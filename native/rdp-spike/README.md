# RDP spike

Throwaway proof-of-concept answering one question: **can noxed pull pixels out
of FreeRDP from its own code?** (Option B — FreeRDP as a sidecar process,
framebuffer streamed to a `<canvas>` pane.)

It connects to an RDP host, lets FreeRDP's GDI compose frames into an in-memory
BGRA buffer (no on-screen window), and on the first paint writes that buffer to
a `.ppm`. If a real desktop image lands on disk, the rest is noxed's existing
patterns: a sidecar like `src/main/ipc/localTerminal.ts`, an IPC stream, and a
canvas pane.

## Build

Requires `freerdp` 3 (`brew install freerdp`) and `pkg-config`.

```sh
make
```

## Run

```sh
./rdp-spike <host> <port> <user> <password> out.ppm
open out.ppm   # Preview renders .ppm on macOS
```

Example: `./rdp-spike 192.168.1.50 3389 Administrator 'hunter2' out.ppm`

## Status / next milestones

- [x] Prove pixels come out of libfreerdp (this spike)
- [ ] Stream frames + dirty rects over a pipe instead of writing to disk
- [ ] Inject keyboard/mouse input back into the session
- [ ] `src/main/ipc/rdp.ts` sidecar manager (model on `localTerminal.ts`)
- [ ] `rdp` TabView + canvas pane in the renderer
- [ ] Route through `tunnels.ts` for RDP-over-SSH-tunnel
