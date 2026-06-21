/*
 * noxed RDP spike — proves that pixels can be pulled out of FreeRDP 3.
 *
 * This is the riskiest unknown for "RDP in noxed": everything else (spawning a
 * sidecar, an IPC stream, a <canvas> pane) is already a solved pattern in this
 * codebase. So before any Electron plumbing, this standalone client connects to
 * a host, lets FreeRDP's GDI render into an in-memory BGRA framebuffer, and on
 * the first paint dumps that framebuffer to a .ppm on disk.
 *
 * If a real desktop image lands on disk, the architecture is viable: the same
 * primary_buffer that we write to a file here is what a real sidecar would
 * stream over a pipe to the renderer's canvas.
 *
 * Usage:
 *   rdp-spike <host> <port> <user> <password> <out.ppm>
 *
 * Intentionally minimal: no NLA fallback logic, no channels, no input, single
 * frame. It exists to answer one question, not to be a client.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/codec/color.h>
#include <winpr/synch.h>

typedef struct
{
	rdpContext context;
	int frameCount;
	int maxFrames;
	const char* outPath;
} SpikeContext;

/* Write the BGRA primary buffer out as a binary PPM (P6, RGB). */
static BOOL write_ppm(const char* path, const BYTE* buf, UINT32 w, UINT32 h, UINT32 stride)
{
	FILE* f = fopen(path, "wb");
	if (!f)
	{
		fprintf(stderr, "[spike] cannot open %s for writing\n", path);
		return FALSE;
	}
	fprintf(f, "P6\n%u %u\n255\n", w, h);
	for (UINT32 y = 0; y < h; y++)
	{
		const BYTE* row = buf + (size_t)y * stride;
		for (UINT32 x = 0; x < w; x++)
		{
			const BYTE* px = row + (size_t)x * 4; /* BGRA */
			fputc(px[2], f);                      /* R */
			fputc(px[1], f);                      /* G */
			fputc(px[0], f);                      /* B */
		}
	}
	fclose(f);
	return TRUE;
}

/* Called by FreeRDP after each server paint. The framebuffer is fully composed
 * in gdi->primary_buffer by the time we get here. */
static BOOL spike_end_paint(rdpContext* context)
{
	SpikeContext* ctx = (SpikeContext*)context;
	rdpGdi* gdi = context->gdi;

	if (!gdi || !gdi->primary_buffer)
		return TRUE;

	ctx->frameCount++;
	if (ctx->frameCount == 1)
	{
		printf("[spike] first frame: %ux%u stride=%u\n", gdi->width, gdi->height, gdi->stride);
		if (!write_ppm(ctx->outPath, gdi->primary_buffer, gdi->width, gdi->height, gdi->stride))
			return FALSE;
		printf("[spike] wrote %s — pixels are flowing out of FreeRDP\n", ctx->outPath);
	}

	if (ctx->frameCount >= ctx->maxFrames)
		freerdp_abort_connect_context(context);

	return TRUE;
}

static BOOL spike_post_connect(freerdp* instance)
{
	/* Render into an in-memory BGRA32 surface — no on-screen window at all. */
	if (!gdi_init(instance, PIXEL_FORMAT_BGRA32))
		return FALSE;

	/* gdi_init installs its own update callbacks, so hook ours afterwards. */
	instance->context->update->EndPaint = spike_end_paint;
	return TRUE;
}

static BOOL spike_client_new(freerdp* instance, rdpContext* context)
{
	(void)context;
	instance->PostConnect = spike_post_connect;
	return TRUE;
}

static void spike_client_free(freerdp* instance, rdpContext* context)
{
	(void)instance;
	(void)context;
}

static int spike_client_start(rdpContext* context)
{
	(void)context;
	return 0;
}

static int spike_client_stop(rdpContext* context)
{
	(void)context;
	return 0;
}

static int spike_entry(RDP_CLIENT_ENTRY_POINTS* pEntryPoints)
{
	pEntryPoints->Version = RDP_CLIENT_INTERFACE_VERSION;
	pEntryPoints->Size = sizeof(RDP_CLIENT_ENTRY_POINTS);
	pEntryPoints->ContextSize = sizeof(SpikeContext);
	pEntryPoints->ClientNew = spike_client_new;
	pEntryPoints->ClientFree = spike_client_free;
	pEntryPoints->ClientStart = spike_client_start;
	pEntryPoints->ClientStop = spike_client_stop;
	return 0;
}

int main(int argc, char* argv[])
{
	if (argc != 6)
	{
		fprintf(stderr, "usage: %s <host> <port> <user> <password> <out.ppm>\n", argv[0]);
		return 2;
	}

	const char* host = argv[1];
	const UINT32 port = (UINT32)strtoul(argv[2], NULL, 10);
	const char* user = argv[3];
	const char* pass = argv[4];
	const char* out = argv[5];

	RDP_CLIENT_ENTRY_POINTS entry = { 0 };
	spike_entry(&entry);

	rdpContext* context = freerdp_client_context_new(&entry);
	if (!context)
	{
		fprintf(stderr, "[spike] failed to create client context\n");
		return 1;
	}

	SpikeContext* ctx = (SpikeContext*)context;
	ctx->maxFrames = 1;
	ctx->outPath = out;

	rdpSettings* settings = context->settings;
	freerdp_settings_set_string(settings, FreeRDP_ServerHostname, host);
	freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, port);
	freerdp_settings_set_string(settings, FreeRDP_Username, user);
	freerdp_settings_set_string(settings, FreeRDP_Password, pass);
	freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE);
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, 1280);
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, 800);
	freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32);

	freerdp* instance = context->instance;

	int rc = 0;
	if (!freerdp_connect(instance))
	{
		fprintf(stderr, "[spike] connect failed (auth/host/cert?) err=0x%08X\n",
		        freerdp_get_last_error(context));
		rc = 1;
		goto cleanup;
	}

	printf("[spike] connected to %s:%u, waiting for first paint...\n", host, port);

	while (!freerdp_shall_disconnect_context(context))
	{
		HANDLE handles[64];
		DWORD count = freerdp_get_event_handles(context, handles, 64);
		if (count == 0)
		{
			fprintf(stderr, "[spike] failed to get event handles\n");
			rc = 1;
			break;
		}

		DWORD status = WaitForMultipleObjects(count, handles, FALSE, INFINITE);
		if (status == WAIT_FAILED)
		{
			fprintf(stderr, "[spike] WaitForMultipleObjects failed\n");
			rc = 1;
			break;
		}

		if (!freerdp_check_event_handles(context))
		{
			/* Could be a normal disconnect after our abort; not necessarily an error. */
			break;
		}
	}

	freerdp_disconnect(instance);

cleanup:
	freerdp_client_context_free(context);
	return rc;
}
