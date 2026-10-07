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
 * Output framing (stdout, binary, little-endian) — one message per DIRTY
 * RECTANGLE, not per full screen. Re-sending the whole desktop on every paint is
 * what made this unusably slow; RDP already tells us which rectangles changed
 * (the GDI invalid region), so we swizzle and emit only those:
 *   magic   "NXF2"   (4 bytes)
 *   descW   u32      full desktop width  (canvas size — constant per session)
 *   descH   u32      full desktop height
 *   x, y    u32,u32  rectangle origin within the desktop
 *   w, h    u32,u32  rectangle size
 *   dataLen u32      (== w * h * 4, tightly packed RGBA, no padding)
 *   data    dataLen bytes
 *
 * The GDI surface is BGRA with a zero alpha channel; we swizzle to RGBA and
 * force alpha to 255 here so the renderer can hand the buffer straight to a
 * canvas ImageData (which is RGBA and would otherwise paint fully transparent).
 *
 * Diagnostics go to stderr ONLY — stdout is a binary frame channel and must not
 * be polluted. FreeRDP's own WLog already targets stderr.
 *
 * Input: after the password, stdin becomes a line-based input channel. A reader
 * thread parses each line into a pointer/keyboard event and hands it to the main
 * thread (via a small wake-on-enqueue queue) so every FreeRDP call stays on one
 * thread. Input command grammar (one per line, coords are desktop pixels):
 *   mv <x> <y>              pointer move
 *   md <x> <y> <btn>        button down  (btn: 0=left 1=right 2=middle)
 *   mu <x> <y> <btn>        button up
 *   mw <x> <y> <delta>      wheel        (delta: signed RDP rotation, ~±120/notch)
 *   kd <scancode> <ext>     key down     (RDP set-1 scancode; ext: 0/1)
 *   ku <scancode> <ext>     key up
 *   uc <down> <codepoint>   unicode key  (down: 1=press 0=release)
 *
 * Usage: rdp-sidecar <host> <port> <user> [width] [height]
 * The password is read as the first line of stdin so it never appears in the
 * process list.
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
#include <freerdp/error.h>
#include <freerdp/input.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/codec/color.h>
#include <winpr/synch.h>
#include <winpr/thread.h>
#include <winpr/wlog.h>

typedef struct
{
	rdpContext context;
	BYTE* packed; /* scratch buffer for stride-stripped BGRA */
	size_t packedCap;
} SidecarContext;

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

/* Emit one dirty rectangle from the GDI framebuffer: swizzle just that sub-rect
 * (BGRA→RGBA, alpha forced opaque) into a tightly-packed buffer and write an
 * NXF2 message. `x/y/w/h` must already be clamped to the desktop bounds. Only
 * the changed pixels are touched, which is the whole point — swizzling and
 * shipping the full screen every paint is what killed performance. */
static BOOL emit_rect(SidecarContext* ctx, const rdpGdi* gdi, UINT32 x, UINT32 y, UINT32 w,
                      UINT32 h)
{
	const size_t rowBytes = (size_t)w * 4;
	const size_t dataLen = rowBytes * h;
	const size_t MAX_FRAME_SIZE = 67108864; /* 64 MiB */

	if (w == 0 || h == 0)
		return TRUE;
	if ((rowBytes / 4) != w || (dataLen / h) != rowBytes) {
		fprintf(stderr, "[sidecar] overflow in rect size calculation\n");
		return FALSE;
	}
	if (dataLen > MAX_FRAME_SIZE) {
		fprintf(stderr, "[sidecar] rect too large (%zu bytes > 64 MiB)\n", dataLen);
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

	for (UINT32 row = 0; row < h; row++)
	{
		const BYTE* src = gdi->primary_buffer + (size_t)(y + row) * gdi->stride + (size_t)x * 4;
		BYTE* dst = ctx->packed + (size_t)row * rowBytes;
		for (UINT32 col = 0; col < w; col++)
		{
			const BYTE* sp = src + (size_t)col * 4; /* BGRA */
			BYTE* dp = dst + (size_t)col * 4;        /* RGBA */
			dp[0] = sp[2];
			dp[1] = sp[1];
			dp[2] = sp[0];
			dp[3] = 255;
		}
	}

	BYTE header[32];
	memcpy(header, "NXF2", 4);
	write_u32_le(header + 4, (UINT32)gdi->width);
	write_u32_le(header + 8, (UINT32)gdi->height);
	write_u32_le(header + 12, x);
	write_u32_le(header + 16, y);
	write_u32_le(header + 20, w);
	write_u32_le(header + 24, h);
	write_u32_le(header + 28, (UINT32)dataLen);

	if (fwrite(header, 1, sizeof(header), stdout) != sizeof(header))
		return FALSE;
	if (fwrite(ctx->packed, 1, dataLen, stdout) != dataLen)
		return FALSE;
	return TRUE;
}

/* Clamp a GDI invalid region to the desktop and emit it. Regions can extend a
 * pixel past the edge or arrive empty; skip those rather than read out of
 * bounds. */
static BOOL emit_clamped_rect(SidecarContext* ctx, const rdpGdi* gdi, const GDI_RGN* r)
{
	INT32 x = r->x, y = r->y, w = r->w, h = r->h;
	if (w <= 0 || h <= 0)
		return TRUE;
	if (x < 0) { w += x; x = 0; }
	if (y < 0) { h += y; y = 0; }
	if (x >= gdi->width || y >= gdi->height)
		return TRUE;
	if (x + w > gdi->width) w = gdi->width - x;
	if (y + h > gdi->height) h = gdi->height - y;
	if (w <= 0 || h <= 0)
		return TRUE;
	return emit_rect(ctx, gdi, (UINT32)x, (UINT32)y, (UINT32)w, (UINT32)h);
}

static BOOL sidecar_end_paint(rdpContext* context)
{
	SidecarContext* ctx = (SidecarContext*)context;
	rdpGdi* gdi = context->gdi;

	if (!gdi || !gdi->primary_buffer || !gdi->primary)
		return TRUE;

	HGDI_DC hdc = gdi->primary->hdc;
	HGDI_WND hwnd = hdc ? hdc->hwnd : NULL;

	BOOL ok = TRUE;
	if (!hwnd)
	{
		/* No window bookkeeping available — fall back to the whole desktop. */
		ok = emit_rect(ctx, gdi, 0, 0, (UINT32)gdi->width, (UINT32)gdi->height);
	}
	else if (hwnd->ninvalid >= 1 && hwnd->cinvalid)
	{
		/* Detailed dirty list: emit each changed rectangle (mirrors how the
		 * X11/SDL clients repaint). */
		for (INT32 i = 0; i < hwnd->ninvalid && ok; i++)
			ok = emit_clamped_rect(ctx, gdi, &hwnd->cinvalid[i]);
	}
	else if (hwnd->invalid && !hwnd->invalid->null)
	{
		/* Only a bounding box is tracked — still far better than full-screen. */
		ok = emit_clamped_rect(ctx, gdi, hwnd->invalid);
	}
	else
	{
		return TRUE; /* nothing changed this paint */
	}

	if (!ok)
	{
		/* stdout closed (parent gone) — tear the session down. */
		fprintf(stderr, "[sidecar] stdout write failed, disconnecting\n");
		freerdp_abort_connect_context(context);
		return TRUE;
	}
	fflush(stdout); /* one flush per server frame, after all its rects */

	/* Mark the region clean so FreeRDP doesn't re-report the same rects. */
	if (hwnd)
	{
		if (hwnd->invalid)
			hwnd->invalid->null = TRUE;
		hwnd->ninvalid = 0;
	}
	return TRUE;
}

/* Certificate handling. The default client callbacks
 * (client_cli_verify_certificate_ex) are interactive: they print the cert
 * details to *stdout* — corrupting the binary frame channel — and then read a
 * Y/N answer from *stdin*, which rdp.ts closes right after the password. The
 * EOF rejects the certificate, so any host not already in
 * ~/.config/freerdp/known_hosts2 failed to connect. This was the "works some
 * of the time" bug: only hosts trusted during earlier interactive testing
 * connected, and they broke again whenever Windows rotated its self-signed
 * cert.
 *
 * Windows RDP hosts almost universally present self-signed certs, so we
 * accept for the session (return 2 = temporary trust: nothing persisted, no
 * stale known_hosts state to go bad later) and log the fingerprint to stderr.
 * Same trust-on-use posture as the app's SSH host-key handling; an in-app
 * verification UI is a later milestone for both. */
static DWORD sidecar_verify_certificate(freerdp* instance, const char* host, UINT16 port,
                                        const char* common_name, const char* subject,
                                        const char* issuer, const char* fingerprint, DWORD flags)
{
	(void)instance;
	(void)subject;
	(void)issuer;
	fprintf(stderr, "[sidecar] accepting certificate for %s:%u (CN=%s)\n", host, (unsigned)port,
	        common_name ? common_name : "?");
	if (fingerprint && !(flags & VERIFY_CERT_FLAG_FP_IS_PEM))
		fprintf(stderr, "[sidecar] fingerprint: %s\n", fingerprint);
	return 2; /* trust for this session only */
}

static DWORD sidecar_verify_changed_certificate(freerdp* instance, const char* host, UINT16 port,
                                                const char* common_name, const char* subject,
                                                const char* issuer, const char* new_fingerprint,
                                                const char* old_subject, const char* old_issuer,
                                                const char* old_fingerprint, DWORD flags)
{
	(void)old_subject;
	(void)old_issuer;
	(void)old_fingerprint;
	return sidecar_verify_certificate(instance, host, port, common_name, subject, issuer,
	                                  new_fingerprint, flags);
}

/* Map the common connect failures to messages a person can act on. rdp.ts
 * surfaces the last "[sidecar] error: ..." stderr line in the RDP tab, so this
 * is what the user sees when a connect fails. */
static const char* connect_error_message(UINT32 code)
{
	switch (code)
	{
		case FREERDP_ERROR_CONNECT_LOGON_FAILURE:
		case FREERDP_ERROR_AUTHENTICATION_FAILED:
			return "Sign-in failed: the username or password is incorrect.";
		case FREERDP_ERROR_CONNECT_ACCOUNT_LOCKED_OUT:
			return "Sign-in failed: the account is locked out.";
		case FREERDP_ERROR_CONNECT_ACCOUNT_DISABLED:
			return "Sign-in failed: the account is disabled.";
		case FREERDP_ERROR_CONNECT_ACCOUNT_EXPIRED:
			return "Sign-in failed: the account has expired.";
		case FREERDP_ERROR_CONNECT_ACCOUNT_RESTRICTION:
			return "Sign-in failed: an account restriction blocked the logon.";
		case FREERDP_ERROR_CONNECT_PASSWORD_EXPIRED:
		case FREERDP_ERROR_CONNECT_PASSWORD_CERTAINLY_EXPIRED:
			return "Sign-in failed: the password has expired and must be changed.";
		case FREERDP_ERROR_CONNECT_PASSWORD_MUST_CHANGE:
			return "Sign-in failed: the password must be changed before signing in.";
		case FREERDP_ERROR_CONNECT_FAILED:
		case FREERDP_ERROR_CONNECT_TRANSPORT_FAILED:
			return "Could not reach the host. Check the address, port, and that Remote Desktop is enabled.";
		case FREERDP_ERROR_DNS_NAME_NOT_FOUND:
		case FREERDP_ERROR_DNS_ERROR:
			return "Could not resolve the hostname. Check the address.";
		case FREERDP_ERROR_TLS_CONNECT_FAILED:
			return "TLS negotiation with the host failed.";
		case FREERDP_ERROR_SECURITY_NEGO_CONNECT_FAILED:
			return "Security negotiation failed. The host may require NLA settings this client did not offer.";
		case FREERDP_ERROR_CONNECT_CANCELLED:
			return "The connection was cancelled.";
		default:
			return NULL;
	}
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
	/* Replace the interactive CLI cert prompts (stdout/stdin) — see
	 * sidecar_verify_certificate above. */
	instance->VerifyCertificateEx = sidecar_verify_certificate;
	instance->VerifyChangedCertificateEx = sidecar_verify_changed_certificate;
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

/* ---- Input channel (stdin → RDP) -------------------------------------------
 *
 * A reader thread turns each stdin line into a pre-composed InputEvent and drops
 * it on a ring buffer, then signals `wake`. The main thread waits on `wake`
 * alongside FreeRDP's own event handles and drains the queue, so the actual
 * freerdp_input_send_* calls only ever happen on the main thread (FreeRDP's
 * transport is not safe to write from two threads). The reader never touches the
 * rdpContext — on EOF it just sets `eof` and wakes the main thread, which owns
 * teardown. */
typedef struct
{
	UINT16 type;  /* 0=pointer, 1=keyboard scancode, 2=unicode */
	UINT16 flags; /* PTR_FLAGS_* or KBD_FLAGS_* */
	UINT16 a;     /* pointer x | scancode | codepoint */
	UINT16 b;     /* pointer y */
} InputEvent;

#define INPUT_QUEUE_CAP 2048

typedef struct
{
	CRITICAL_SECTION lock;
	HANDLE wake;
	InputEvent items[INPUT_QUEUE_CAP];
	size_t head;
	size_t tail;
	BOOL eof;
} InputQueue;

/* Encode a signed wheel rotation into PTR_FLAGS_WHEEL[_NEGATIVE] + magnitude.
 * Mirror of FreeRDP's decode (client/common/client.c): a negative rotation is
 * stored as the low byte of (0x100 - magnitude) with PTR_FLAGS_WHEEL_NEGATIVE. */
static UINT16 encode_wheel(int delta)
{
	UINT16 flags = PTR_FLAGS_WHEEL;
	if (delta > 255)
		delta = 255;
	if (delta < -255)
		delta = -255;
	if (delta < 0)
	{
		flags |= PTR_FLAGS_WHEEL_NEGATIVE;
		flags |= (UINT16)((0x100 + delta) & 0xFF); /* 0x100 - |delta| */
	}
	else
	{
		flags |= (UINT16)(delta & 0xFF);
	}
	return flags;
}

/* Parse one stdin line into an InputEvent. Returns FALSE for blank/unknown
 * lines so a stray byte can't inject a bogus event. */
static BOOL parse_input_line(const char* line, InputEvent* out)
{
	char verb[8] = { 0 };
	int a = 0, b = 0, c = 0;
	const int n = sscanf(line, "%7s %d %d %d", verb, &a, &b, &c);
	if (n < 1)
		return FALSE;

	if (strcmp(verb, "mv") == 0)
	{
		out->type = 0;
		out->flags = PTR_FLAGS_MOVE;
		out->a = (UINT16)a;
		out->b = (UINT16)b;
		return TRUE;
	}
	if (strcmp(verb, "md") == 0 || strcmp(verb, "mu") == 0)
	{
		UINT16 flags = (verb[1] == 'd') ? PTR_FLAGS_DOWN : 0;
		switch (c)
		{
			case 0: flags |= PTR_FLAGS_BUTTON1; break; /* left */
			case 1: flags |= PTR_FLAGS_BUTTON2; break; /* right */
			case 2: flags |= PTR_FLAGS_BUTTON3; break; /* middle */
			default: return FALSE;
		}
		out->type = 0;
		out->flags = flags;
		out->a = (UINT16)a;
		out->b = (UINT16)b;
		return TRUE;
	}
	if (strcmp(verb, "mw") == 0)
	{
		out->type = 0;
		out->flags = encode_wheel(c);
		out->a = (UINT16)a;
		out->b = (UINT16)b;
		return TRUE;
	}
	if (strcmp(verb, "kd") == 0 || strcmp(verb, "ku") == 0)
	{
		UINT16 flags = (verb[1] == 'd') ? KBD_FLAGS_DOWN : KBD_FLAGS_RELEASE;
		if (b)
			flags |= KBD_FLAGS_EXTENDED; /* b = extended flag */
		out->type = 1;
		out->flags = flags;
		out->a = (UINT16)(a & 0xFF); /* scancode */
		out->b = 0;
		return TRUE;
	}
	if (strcmp(verb, "uc") == 0)
	{
		out->type = 2;
		out->flags = a ? KBD_FLAGS_DOWN : KBD_FLAGS_RELEASE; /* a = down flag */
		out->a = (UINT16)b;                                  /* b = codepoint */
		out->b = 0;
		return TRUE;
	}
	return FALSE;
}

static DWORD WINAPI input_reader_thread(LPVOID arg)
{
	InputQueue* q = (InputQueue*)arg;
	char line[256];
	while (fgets(line, sizeof(line), stdin))
	{
		/* An overlong line arrives in pieces; parsing the tail on its own could
		 * yield a valid-looking command, so drop the whole line instead. */
		if (!strchr(line, '\n'))
		{
			int ch;
			while ((ch = fgetc(stdin)) != EOF && ch != '\n')
				;
			continue;
		}
		InputEvent ev;
		if (!parse_input_line(line, &ev))
			continue;
		EnterCriticalSection(&q->lock);
		const size_t next = (q->tail + 1) % INPUT_QUEUE_CAP;
		if (next != q->head)
		{
			q->items[q->tail] = ev;
			q->tail = next;
		}
		/* else: queue full (a burst of moves) — drop the newest; the next
		 * absolute move/position corrects it anyway. */
		LeaveCriticalSection(&q->lock);
		SetEvent(q->wake);
	}
	/* stdin closed: the parent went away. Let the main thread tear down. */
	EnterCriticalSection(&q->lock);
	q->eof = TRUE;
	LeaveCriticalSection(&q->lock);
	SetEvent(q->wake);
	return 0;
}

/* Drain every queued event and inject it. Main thread only. */
static void drain_input(rdpContext* context, InputQueue* q)
{
	rdpInput* input = context->input;
	for (;;)
	{
		InputEvent ev;
		EnterCriticalSection(&q->lock);
		if (q->head == q->tail)
		{
			LeaveCriticalSection(&q->lock);
			return;
		}
		ev = q->items[q->head];
		q->head = (q->head + 1) % INPUT_QUEUE_CAP;
		LeaveCriticalSection(&q->lock);

		switch (ev.type)
		{
			case 0: freerdp_input_send_mouse_event(input, ev.flags, ev.a, ev.b); break;
			case 1: freerdp_input_send_keyboard_event(input, ev.flags, (UINT8)ev.a); break;
			case 2: freerdp_input_send_unicode_keyboard_event(input, ev.flags, ev.a); break;
		}
	}
}

int main(int argc, char* argv[])
{
	if (argc < 4 || argc > 6)
	{
		fprintf(stderr, "usage: %s <host> <port> <user> [width] [height]\n", argv[0]);
		fprintf(stderr, "password will be read from stdin\n");
		return 2;
	}

#ifdef _WIN32
	/* stdout defaults to text mode on Windows and translates \n -> \r\n,
	 * which corrupts the binary frame stream. */
	_setmode(_fileno(stdout), _O_BINARY);
#endif

	const char* host = argv[1];
	const UINT32 port = (UINT32)strtoul(argv[2], NULL, 10);
	const char* user = argv[3];
	const UINT32 width = (argc >= 5) ? (UINT32)strtoul(argv[4], NULL, 10) : 1280;
	const UINT32 height = (argc >= 6) ? (UINT32)strtoul(argv[5], NULL, 10) : 800;

	/* "DOMAIN\user" must go into separate Domain/Username settings for NLA;
	 * xfreerdp does this split in its command-line layer, so we mirror it. UPN
	 * form ("user@domain") is understood natively and passes through as-is. */
	const char* domain = NULL;
	char userbuf[256] = { 0 };
	const char* backslash = strchr(user, '\\');
	if (backslash && backslash != user && (size_t)(backslash - user) < sizeof(userbuf))
	{
		memcpy(userbuf, user, (size_t)(backslash - user));
		userbuf[backslash - user] = '\0';
		domain = userbuf;
		user = backslash + 1;
	}

	/* Read password from stdin to avoid exposing it in process list */
	char pass[256];
	if (!fgets(pass, sizeof(pass), stdin)) {
		fprintf(stderr, "[sidecar] failed to read password from stdin\n");
		return 2;
	}
	/* Remove trailing newline */
	size_t len = strlen(pass);
	if (len > 0 && pass[len - 1] == '\n') pass[len - 1] = '\0';

	quiet_wlog_to_stderr();

	RDP_CLIENT_ENTRY_POINTS entry = { 0 };
	sidecar_entry(&entry);

#ifdef _WIN32
	/* FreeRDP's own Windows client initializes Winsock in its global init;
	 * without it getaddrinfo fails and freerdp_connect reports
	 * DNS_NAME_NOT_FOUND even for a valid host. */
	WSADATA wsaData;
	if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0)
	{
		fprintf(stderr, "[sidecar] WSAStartup failed\n");
		return 1;
	}
#endif

	rdpContext* context = freerdp_client_context_new(&entry);
	if (!context)
	{
		fprintf(stderr, "[sidecar] failed to create client context\n");
		return 1;
	}

	rdpSettings* settings = context->settings;
	freerdp_settings_set_string(settings, FreeRDP_ServerHostname, host);
	freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, port);
	freerdp_settings_set_string(settings, FreeRDP_Username, user);
	if (domain)
		freerdp_settings_set_string(settings, FreeRDP_Domain, domain);
	freerdp_settings_set_string(settings, FreeRDP_Password, pass);
	freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, FALSE);
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, width);
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, height);
	freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32);

	/* The static FreeRDP we ship is trimmed: channel addins (rdpgfx, rdpdr,
	 * rdpsnd, cliprdr, ...) are not built in. FreeRDP's defaults still enable
	 * the features backed by those channels, so freerdp_client_load_addins
	 * tries to load them, fails, and pre-connect aborts before a TCP
	 * connection is even attempted. Turn every channel-backed feature off —
	 * this viewer is a plain GDI framebuffer and needs none of them. */
	freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_NetworkAutoDetect, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_SupportHeartbeatPdu, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_SupportMultitransport, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_DeviceRedirection, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_RedirectClipboard, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_AudioPlayback, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_AudioCapture, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_SupportDisplayControl, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_SupportGeometryTracking, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_SupportVideoOptimized, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_MultiTouchInput, FALSE);

	freerdp* instance = context->instance;

	/* Declared before the connect so the failure `goto cleanup` doesn't jump
	 * over an initialized declaration; the input thread is only started once we
	 * know the session (and context->input) is live. */
	InputQueue inq;
	memset(&inq, 0, sizeof(inq));
	HANDLE reader = NULL;

	int rc = 0;
	if (!freerdp_connect(instance))
	{
		const UINT32 err = freerdp_get_last_error(context);
		const char* friendly = connect_error_message(err);
		if (friendly)
			fprintf(stderr, "[sidecar] error: %s\n", friendly);
		else
			fprintf(stderr, "[sidecar] error: connect failed — %s (0x%08X)\n",
			        freerdp_get_last_error_string(err), err);
		rc = 1;
		goto cleanup;
	}

	/* stdin is now the input channel. If the thread/event can't be created we
	 * carry on view-only rather than failing the session. */
	InitializeCriticalSection(&inq.lock);
	inq.wake = CreateEvent(NULL, FALSE, FALSE, NULL); /* auto-reset */
	if (inq.wake)
		reader = CreateThread(NULL, 0, input_reader_thread, &inq, 0, NULL);
	if (!inq.wake || !reader)
		fprintf(stderr, "[sidecar] input channel unavailable — view-only\n");

	while (!freerdp_shall_disconnect_context(context))
	{
		/* Leave one slot for the input wake handle. */
		HANDLE handles[64];
		DWORD count = freerdp_get_event_handles(context, handles, 63);
		if (count == 0)
		{
			fprintf(stderr, "[sidecar] failed to get event handles\n");
			rc = 1;
			break;
		}

		DWORD total = count;
		if (inq.wake)
			handles[total++] = inq.wake;

		DWORD status = WaitForMultipleObjects(total, handles, FALSE, INFINITE);
		if (status == WAIT_FAILED)
		{
			fprintf(stderr, "[sidecar] wait failed\n");
			rc = 1;
			break;
		}

		/* Inject any queued input on this (main) thread, then notice a closed
		 * stdin (parent gone). */
		drain_input(context, &inq);
		if (inq.eof)
			break;

		if (!freerdp_check_event_handles(context))
			break;
	}

	(void)reader; /* daemon thread; reclaimed on process exit */

	/* If the server ended the session, surface why instead of a silent drop.
	 * A deliberate sign-out/disconnect is a normal end; everything else
	 * (kicked by another connection, idle timeout, license/protocol errors)
	 * exits nonzero so rdp.ts shows the reason in the tab. */
	{
		const UINT32 info = freerdp_error_info(instance);
		const BOOL normalEnd = info == ERRINFO_SUCCESS ||
		                       info == ERRINFO_RPC_INITIATED_DISCONNECT ||
		                       info == ERRINFO_RPC_INITIATED_LOGOFF ||
		                       info == ERRINFO_LOGOFF_BY_USER;
		if (!normalEnd)
		{
			fprintf(stderr, "[sidecar] error: session ended by server — %s\n",
			        freerdp_get_error_info_string(info));
			rc = 1;
		}
	}

	freerdp_disconnect(instance);

cleanup:
	freerdp_client_context_free(context);
#ifdef _WIN32
	WSACleanup();
#endif
	return rc;
}
