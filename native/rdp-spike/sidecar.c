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
 * Usage: rdp-sidecar <host> <port> <user> [width] [height]
 * The password is read as the first line of stdin so it never appears in the
 * process list.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif

#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/error.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/codec/color.h>
#include <winpr/synch.h>
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

	while (!freerdp_shall_disconnect_context(context))
	{
		HANDLE handles[64];
		DWORD count = freerdp_get_event_handles(context, handles, 64);
		if (count == 0)
		{
			fprintf(stderr, "[sidecar] failed to get event handles\n");
			rc = 1;
			break;
		}

		DWORD status = WaitForMultipleObjects(count, handles, FALSE, INFINITE);
		if (status == WAIT_FAILED)
		{
			fprintf(stderr, "[sidecar] wait failed\n");
			rc = 1;
			break;
		}

		if (!freerdp_check_event_handles(context))
			break;
	}

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
	return rc;
}
