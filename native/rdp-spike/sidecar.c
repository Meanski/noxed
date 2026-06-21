/*
 * noxed RDP sidecar — the streaming sibling of spike.c.
 *
 * Where spike.c dumps a single frame to disk to prove the pixel path, this
 * runs as a long-lived child process: it connects to an RDP host and writes
 * every composed frame to stdout as a length-prefixed BGRA blob. The Electron
 * main process (src/main/ipc/rdp.ts) spawns this, parses the framed stream, and
 * forwards frames to a <canvas> in the renderer — the same shape as how
 * localTerminal.ts spawns node-pty and streams its output.
 *
 * Output framing (stdout, binary, little-endian):
 *   magic   "NXF1"   (4 bytes)
 *   width   u32
 *   height  u32
 *   dataLen u32      (== width * height * 4, tightly packed RGBA, no padding)
 *   data    dataLen bytes
 *
 * The GDI surface is BGRA with a zero alpha channel; we swizzle to RGBA and
 * force alpha to 255 here so the renderer can hand the buffer straight to a
 * canvas ImageData (which is RGBA and would otherwise paint fully transparent).
 *
 * Diagnostics go to stderr ONLY — stdout is a binary frame channel and must not
 * be polluted. FreeRDP's own WLog already targets stderr.
 *
 * This milestone is output-only (read-only desktop view). Input injection
 * (mouse/keyboard over stdin) is the next milestone.
 *
 * Usage: rdp-sidecar <host> <port> <user> <password> [width] [height]
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <winsock2.h>
#include <io.h>
#include <fcntl.h>
#endif

#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/codec/color.h>
#include <freerdp/input.h>
#include <winpr/synch.h>
#include <winpr/thread.h>
#include <winpr/wlog.h>

typedef struct
{
	rdpContext context;
	BYTE* packed; /* scratch buffer for stride-stripped BGRA */
	size_t packedCap;
} SidecarContext;

/*
 * Input injection. The parent process (src/main/ipc/rdp.ts) writes fixed 8-byte
 * little-endian messages to our stdin; a reader thread pushes them onto a small
 * ring queue and signals g_inputEvent, which the main event loop waits on
 * alongside FreeRDP's own handles. The loop drains the queue and calls the
 * FreeRDP input functions on the main thread (the transport isn't thread-safe).
 *
 * Wire message (8 bytes):
 *   u8  type     1=mouse, 2=scancode key, 3=unicode key
 *   u8  _pad
 *   u16 flags    PTR_FLAGS_* (mouse) or KBD_FLAGS_* (keyboard)
 *   u16 a        mouse x, or key code (scancode / unicode unit)
 *   u16 b        mouse y (0 for keys)
 *
 * Keeping the sidecar generic — it just forwards flags/codes — means all the
 * key-mapping lives in the renderer where it's easy to iterate.
 */
typedef struct
{
	UINT8 type;
	UINT16 flags;
	UINT16 a;
	UINT16 b;
} InputMsg;

#define INPUT_QUEUE_CAP 512
static CRITICAL_SECTION g_inputLock;
static InputMsg g_inputQueue[INPUT_QUEUE_CAP];
static int g_inputHead = 0;
static int g_inputTail = 0;
static HANDLE g_inputEvent = NULL;

static UINT16 read_u16_le(const UINT8* p)
{
	return (UINT16)(p[0] | ((UINT16)p[1] << 8));
}

static DWORD WINAPI input_reader_thread(LPVOID arg)
{
	(void)arg;
	UINT8 buf[8];
	for (;;)
	{
		/* Block until a full 8-byte message is available; stop on EOF/short read
		 * (parent closed stdin, i.e. the session is going away). */
		if (fread(buf, 1, sizeof(buf), stdin) != sizeof(buf))
			break;

		InputMsg msg;
		msg.type = buf[0];
		msg.flags = read_u16_le(buf + 2);
		msg.a = read_u16_le(buf + 4);
		msg.b = read_u16_le(buf + 6);

		EnterCriticalSection(&g_inputLock);
		int next = (g_inputTail + 1) % INPUT_QUEUE_CAP;
		if (next != g_inputHead) /* drop if full rather than block the reader */
		{
			g_inputQueue[g_inputTail] = msg;
			g_inputTail = next;
		}
		LeaveCriticalSection(&g_inputLock);
		SetEvent(g_inputEvent);
	}
	return 0;
}

static void drain_input(rdpContext* context)
{
	rdpInput* input = context->input;
	for (;;)
	{
		InputMsg msg;
		EnterCriticalSection(&g_inputLock);
		if (g_inputHead == g_inputTail)
		{
			LeaveCriticalSection(&g_inputLock);
			break;
		}
		msg = g_inputQueue[g_inputHead];
		g_inputHead = (g_inputHead + 1) % INPUT_QUEUE_CAP;
		LeaveCriticalSection(&g_inputLock);

		switch (msg.type)
		{
			case 1:
				freerdp_input_send_mouse_event(input, msg.flags, msg.a, msg.b);
				break;
			case 2:
				freerdp_input_send_keyboard_event(input, msg.flags, (UINT8)msg.a);
				break;
			case 3:
				freerdp_input_send_unicode_keyboard_event(input, msg.flags, msg.a);
				break;
			default:
				break;
		}
	}
}

static void write_u32_le(BYTE* p, UINT32 v)
{
	p[0] = (BYTE)(v & 0xFF);
	p[1] = (BYTE)((v >> 8) & 0xFF);
	p[2] = (BYTE)((v >> 16) & 0xFF);
	p[3] = (BYTE)((v >> 24) & 0xFF);
}

/* Keep stdout a pure binary frame channel. FreeRDP's WLog console appender
 * sends WARN/ERROR to stderr but INFO/DEBUG to *stdout*, which corrupts our
 * framed stream. Pin the appender to stderr so logging can never touch stdout,
 * and raise the threshold to ERROR so benign WARN noise (NEON TODO, the
 * experimental-build banner, the cert-ignore notice we trigger deliberately,
 * thread-priority notes) stays out of the console — genuine failures still log
 * at ERROR. The parser side (rdp.ts) also resyncs defensively. Must run before
 * any FreeRDP context is created. */
static void quiet_wlog_to_stderr(void)
{
	wLog* root = WLog_GetRoot();
	if (!root)
		return;
	WLog_SetLogAppenderType(root, WLOG_APPENDER_CONSOLE);
	wLogAppender* appender = WLog_GetLogAppender(root);
	if (appender)
		WLog_ConfigureAppender(appender, "outputstream", (void*)"stderr");
	WLog_SetLogLevel(root, WLOG_ERROR);
}

/* Emit one frame: tightly-packed BGRA so the renderer can hand it straight to
 * ImageData without worrying about stride padding. */
static BOOL emit_frame(SidecarContext* ctx, const BYTE* buf, UINT32 w, UINT32 h, UINT32 stride)
{
	const size_t rowBytes = (size_t)w * 4;
	const size_t dataLen = rowBytes * h;
	const size_t MAX_FRAME_SIZE = 67108864; /* 64 MiB */

	/* Validate dataLen to prevent overflow and excessive allocation */
	if (w > 0 && h > 0 && (rowBytes / 4) != w) {
		fprintf(stderr, "[sidecar] overflow in rowBytes calculation\n");
		return FALSE;
	}
	if (h > 0 && (dataLen / h) != rowBytes) {
		fprintf(stderr, "[sidecar] overflow in dataLen calculation\n");
		return FALSE;
	}
	if (dataLen > MAX_FRAME_SIZE) {
		fprintf(stderr, "[sidecar] frame too large (%zu bytes > 64 MiB)\n", dataLen);
		return FALSE;
	}

	if (ctx->packedCap < dataLen)
	{
		BYTE* grown = realloc(ctx->packed, dataLen);
		if (!grown)
			return FALSE;
		ctx->packed = grown;
		ctx->packedCap = dataLen;
	}

	for (UINT32 y = 0; y < h; y++)
	{
		const BYTE* src = buf + (size_t)y * stride;
		BYTE* dst = ctx->packed + (size_t)y * rowBytes;
		for (UINT32 x = 0; x < w; x++)
		{
			const BYTE* sp = src + (size_t)x * 4; /* BGRA */
			BYTE* dp = dst + (size_t)x * 4;        /* RGBA */
			dp[0] = sp[2];
			dp[1] = sp[1];
			dp[2] = sp[0];
			dp[3] = 255;
		}
	}

	BYTE header[16];
	memcpy(header, "NXF1", 4);
	write_u32_le(header + 4, w);
	write_u32_le(header + 8, h);
	write_u32_le(header + 12, (UINT32)dataLen);

	if (fwrite(header, 1, sizeof(header), stdout) != sizeof(header))
		return FALSE;
	if (fwrite(ctx->packed, 1, dataLen, stdout) != dataLen)
		return FALSE;
	fflush(stdout);
	return TRUE;
}

static BOOL sidecar_end_paint(rdpContext* context)
{
	SidecarContext* ctx = (SidecarContext*)context;
	rdpGdi* gdi = context->gdi;

	if (!gdi || !gdi->primary_buffer)
		return TRUE;

	if (!emit_frame(ctx, gdi->primary_buffer, gdi->width, gdi->height, gdi->stride))
	{
		/* stdout closed (parent gone) — tear the session down. */
		fprintf(stderr, "[sidecar] stdout write failed, disconnecting\n");
		freerdp_abort_connect_context(context);
	}
	return TRUE;
}

static BOOL sidecar_post_connect(freerdp* instance)
{
	if (!gdi_init(instance, PIXEL_FORMAT_BGRA32))
		return FALSE;
	instance->context->update->EndPaint = sidecar_end_paint;
	fprintf(stderr, "[sidecar] connected, streaming frames\n");
	return TRUE;
}

static BOOL sidecar_client_new(freerdp* instance, rdpContext* context)
{
	(void)context;
	instance->PostConnect = sidecar_post_connect;
	return TRUE;
}

static void sidecar_client_free(freerdp* instance, rdpContext* context)
{
	(void)instance;
	SidecarContext* ctx = (SidecarContext*)context;
	if (ctx)
		free(ctx->packed);
}

static int sidecar_client_start(rdpContext* context)
{
	(void)context;
	return 0;
}

static int sidecar_client_stop(rdpContext* context)
{
	(void)context;
	return 0;
}

static int sidecar_entry(RDP_CLIENT_ENTRY_POINTS* pEntryPoints)
{
	pEntryPoints->Version = RDP_CLIENT_INTERFACE_VERSION;
	pEntryPoints->Size = sizeof(RDP_CLIENT_ENTRY_POINTS);
	pEntryPoints->ContextSize = sizeof(SidecarContext);
	pEntryPoints->ClientNew = sidecar_client_new;
	pEntryPoints->ClientFree = sidecar_client_free;
	pEntryPoints->ClientStart = sidecar_client_start;
	pEntryPoints->ClientStop = sidecar_client_stop;
	return 0;
}

int main(int argc, char* argv[])
{
#ifdef _WIN32
	/* Windows opens stdout in text mode, which translates every \n to \r\n and
	 * would corrupt our binary frame stream (silent pixel desync). Force binary
	 * before any frame is written; bail out if it fails rather than ship garbage. */
	if (_setmode(_fileno(stdout), _O_BINARY) == -1)
	{
		fprintf(stderr, "[sidecar] failed to set stdout to binary mode\n");
		return 1;
	}
	/* stdin carries binary 8-byte input messages; text mode would mangle them. */
	if (_setmode(_fileno(stdin), _O_BINARY) == -1)
	{
		fprintf(stderr, "[sidecar] failed to set stdin to binary mode\n");
		return 1;
	}
#endif

	if (argc < 4 || argc > 6)
	{
		fprintf(stderr, "usage: %s <host> <port> <user> [width] [height]\n", argv[0]);
		fprintf(stderr, "password will be read from stdin\n");
		return 2;
	}

	const char* host = argv[1];
	const UINT32 port = (UINT32)strtoul(argv[2], NULL, 10);
	const char* user = argv[3];
	const UINT32 width = (argc >= 5) ? (UINT32)strtoul(argv[4], NULL, 10) : 1280;
	const UINT32 height = (argc >= 6) ? (UINT32)strtoul(argv[5], NULL, 10) : 800;

	/* Read password from stdin to avoid exposing it in process list */
	char pass[256];
	if (!fgets(pass, sizeof(pass), stdin)) {
		fprintf(stderr, "[sidecar] failed to read password from stdin\n");
		return 2;
	}
	/* Remove trailing newline (and CR, in case stdin is binary on Windows) */
	size_t len = strlen(pass);
	while (len > 0 && (pass[len - 1] == '\n' || pass[len - 1] == '\r'))
		pass[--len] = '\0';

	quiet_wlog_to_stderr();

	RDP_CLIENT_ENTRY_POINTS entry = { 0 };
	sidecar_entry(&entry);

	rdpContext* context = freerdp_client_context_new(&entry);
	if (!context)
	{
		fprintf(stderr, "[sidecar] failed to create client context\n");
		return 1;
	}

#ifdef _WIN32
	/* Winsock must be initialized before any name resolution / socket call.
	 * FreeRDP's own Windows client does this in its global init; without it
	 * getaddrinfo fails and freerdp_connect reports DNS_NAME_NOT_FOUND even for
	 * a perfectly valid host. */
	WSADATA wsaData;
	if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0)
	{
		fprintf(stderr, "[sidecar] WSAStartup failed\n");
		freerdp_client_context_free(context);
		return 1;
	}
#endif

	rdpSettings* settings = context->settings;
	freerdp_settings_set_string(settings, FreeRDP_ServerHostname, host);
	freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, port);
	freerdp_settings_set_string(settings, FreeRDP_Username, user);
	freerdp_settings_set_string(settings, FreeRDP_Password, pass);
	/* Internal RDP hosts almost always present a self-signed certificate (mstsc
	 * just prompts the user to trust it). This is a view-only tool, so accept the
	 * cert automatically rather than failing the TLS handshake with
	 * ERRCONNECT_TLS_CONNECT_FAILED (0x00020008). */
	freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE);
	freerdp_settings_set_bool(settings, FreeRDP_AutoAcceptCertificate, TRUE);
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, width);
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, height);
	freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32);

	freerdp* instance = context->instance;

	int rc = 0;
	if (!freerdp_connect(instance))
	{
		fprintf(stderr, "[sidecar] connect failed err=0x%08X\n", freerdp_get_last_error(context));
		rc = 1;
		goto cleanup;
	}

	/* Start the stdin input reader now that we're connected. The auto-reset
	 * event wakes the main loop whenever input arrives so it can be flushed to
	 * the (single-threaded) FreeRDP transport. */
	InitializeCriticalSection(&g_inputLock);
	g_inputEvent = CreateEvent(NULL, FALSE, FALSE, NULL);
	HANDLE readerThread = NULL;
	if (g_inputEvent)
		readerThread = CreateThread(NULL, 0, input_reader_thread, NULL, 0, NULL);
	else
		fprintf(stderr, "[sidecar] input disabled: failed to create event\n");

	while (!freerdp_shall_disconnect_context(context))
	{
		HANDLE handles[64];
		/* Reserve one slot for the input event. */
		DWORD count = freerdp_get_event_handles(context, handles, 63);
		if (count == 0)
		{
			fprintf(stderr, "[sidecar] failed to get event handles\n");
			rc = 1;
			break;
		}

		DWORD total = count;
		if (g_inputEvent)
			handles[total++] = g_inputEvent;

		DWORD status = WaitForMultipleObjects(total, handles, FALSE, INFINITE);
		if (status == WAIT_FAILED)
		{
			fprintf(stderr, "[sidecar] wait failed\n");
			rc = 1;
			break;
		}

		if (g_inputEvent)
			drain_input(context);

		if (!freerdp_check_event_handles(context))
			break;
	}

	freerdp_disconnect(instance);
	if (readerThread)
		CloseHandle(readerThread);

cleanup:
	freerdp_client_context_free(context);
#ifdef _WIN32
	WSACleanup();
#endif
	return rc;
}
