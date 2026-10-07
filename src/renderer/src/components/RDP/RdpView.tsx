import { useEffect, useRef, useState } from 'react'
import type { Tab } from '../../store'
import { useAppStore } from '../../store'
import { scancodeFor, type Scancode } from './scancodes'

// Interactive RDP desktop: the FreeRDP sidecar streams RGBA frames over IPC and
// we blit each one to a canvas; mouse and keyboard events are translated to the
// sidecar's stdin input grammar (see sidecar.c) and sent back.
//
// STATUS: connects, paints frames, surfaces connect/close errors, and forwards
// pointer + keyboard input. No reconnect or live resize negotiation yet.

type Status = 'connecting' | 'connected' | 'error' | 'closed'

// Browser wheel deltas are pixels for most devices; one physical mouse-wheel
// notch is ~100px in Chromium. Trackpads emit many small deltas, so we
// accumulate and only send a 120-unit RDP notch per WHEEL_NOTCH_PX scrolled.
const WHEEL_NOTCH_PX = 100
// WheelEvent.deltaMode → pixels per unit (0=pixel, 1=line, 2=page).
const WHEEL_MODE_PX = [1, 40, 300]
// React button (0=left, 1=middle, 2=right) → sidecar button (0=left, 1=right, 2=middle).
const SIDECAR_BUTTON: Record<number, number> = { 0: 0, 1: 2, 2: 1 }

export default function RdpView({ tab }: Readonly<{ tab: Tab }>) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Current live session id, mirrored from the connect effect so the DOM event
  // handlers (outside the effect) can address the sidecar.
  const rdpIdRef = useRef<string | null>(null)
  // rAF-coalesced pointer move: moves fire far faster than we need to send them.
  const moveRaf = useRef(0)
  const pendingMove = useRef<[number, number] | null>(null)
  const wheelAccum = useRef(0)
  // Keys currently held on the remote. Released on blur, otherwise a key held
  // while focus leaves the pane (e.g. Ctrl then Cmd-Tab) stays stuck down.
  const heldKeys = useRef(new Map<string, Scancode>())
  const sessions = useAppStore((s) => s.sessions)
  const [status, setStatus] = useState<Status>('connecting')
  const [message, setMessage] = useState<string>('')

  useEffect(() => {
    const session = sessions.find((s) => s.id === tab.sessionId)
    if (!session) {
      setStatus('error')
      setMessage('No connection associated with this tab')
      return
    }

    let rdpId: string | null = null
    let disposed = false
    const offFns: Array<() => void> = []

    // Each frame is one dirty rectangle. Apply it straight away — we must NOT
    // coalesce to "latest wins" like a full-frame stream would, or we'd drop
    // regions and paint a torn desktop. Each putImageData is just the changed
    // sub-rect, so this stays cheap even at full Retina resolution.
    const paint = (
      id: string,
      frame: { descW: number; descH: number; x: number; y: number; w: number; h: number; pixels: Uint8Array },
    ) => {
      if (id !== rdpId || disposed) return
      const canvas = canvasRef.current
      if (!canvas) return
      // Size the canvas once to the desktop. Resizing clears it, but the server
      // sends a full-desktop rect on first paint (and after any resize) anyway.
      if (canvas.width !== frame.descW || canvas.height !== frame.descH) {
        canvas.width = frame.descW
        canvas.height = frame.descH
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // pixels is RGBA (sidecar already swizzled + forced alpha). Copy into a
      // fresh clamped array so ImageData gets a plain ArrayBuffer-backed view.
      const img = new ImageData(new Uint8ClampedArray(frame.pixels), frame.w, frame.h)
      ctx.putImageData(img, frame.x, frame.y)
      setStatus((s) => (s === 'connected' ? s : 'connected'))
    }

    offFns.push(
      window.api.rdp.onFrame(paint),
      window.api.rdp.onClose((id, error) => {
        if (id !== rdpId) return
        setStatus(error ? 'error' : 'closed')
        if (error) setMessage(error)
      }),
    )

    ;(async () => {
      try {
        const { password } = await window.api.sessions.getCredentials(session.id)
        if (disposed) return
        if (!password) {
          // The sidecar can't prompt; an empty password would just fail NLA
          // with a confusing "sign-in failed". Say what's actually wrong.
          setStatus('error')
          setMessage('No password saved for this connection. Edit it and add one.')
          return
        }
        // Ask for a desktop matching the pane at *physical* pixel resolution so
        // the image stays crisp on HiDPI/Retina displays. getBoundingClientRect
        // reports CSS pixels, but the canvas backing store (and the screen) are
        // devicePixelRatio times denser — requesting CSS-pixel dimensions made
        // the sidecar send a half-resolution desktop that the canvas then
        // upscaled, which is the "blurry RDP" everyone saw. Even numbers keep
        // RDP codecs happy; clamp to the sidecar's 7680 ceiling; fall back to
        // 1280×800 if the pane hasn't laid out yet.
        const rect = containerRef.current?.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        const toPixels = (css: number) => Math.min(7680, Math.max(2, Math.floor((css * dpr) / 2) * 2))
        const id = await window.api.rdp.connect({
          host: session.host,
          // RDP connections store 3389; fall back for non-RDP hosts opened ad hoc.
          port: session.port || 3389,
          username: session.username,
          password,
          width: rect && rect.width >= 640 ? toPixels(rect.width) : 1280,
          height: rect && rect.height >= 480 ? toPixels(rect.height) : 800,
        })
        if (disposed) {
          // Component was unmounted while connect was in progress
          window.api.rdp.disconnect(id).catch(() => {})
        } else {
          rdpId = id
          rdpIdRef.current = id
        }
      } catch (err) {
        if (!disposed) {
          setStatus('error')
          setMessage(err instanceof Error ? err.message : String(err))
        }
      }
    })()

    return () => {
      disposed = true
      rdpIdRef.current = null
      heldKeys.current.clear()
      if (moveRaf.current) cancelAnimationFrame(moveRaf.current)
      moveRaf.current = 0
      offFns.forEach((off) => off())
      if (rdpId) window.api.rdp.disconnect(rdpId).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId])

  // --- input plumbing (pointer + keyboard → sidecar stdin) -------------------
  const send = (line: string): void => {
    const id = rdpIdRef.current
    if (id) window.api.rdp.sendInput(id, line)
  }

  // Map a mouse event to desktop pixel coordinates. The canvas backing store is
  // the RDP desktop size; its on-screen rect is letterboxed/scaled by CSS, so we
  // rescale by the ratio and clamp into range.
  const toDesktop = (e: React.MouseEvent): [number, number] | null => {
    const canvas = canvasRef.current
    if (!canvas || !canvas.width || !canvas.height) return null
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const x = Math.round(((e.clientX - rect.left) / rect.width) * canvas.width)
    const y = Math.round(((e.clientY - rect.top) / rect.height) * canvas.height)
    return [
      Math.min(canvas.width - 1, Math.max(0, x)),
      Math.min(canvas.height - 1, Math.max(0, y)),
    ]
  }

  const onPointerMove = (e: React.MouseEvent): void => {
    const p = toDesktop(e)
    if (!p) return
    pendingMove.current = p
    if (!moveRaf.current) {
      moveRaf.current = requestAnimationFrame(() => {
        moveRaf.current = 0
        const m = pendingMove.current
        pendingMove.current = null
        if (m) send(`mv ${m[0]} ${m[1]}`)
      })
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const button = SIDECAR_BUTTON[e.button]
    if (button === undefined) return
    containerRef.current?.focus() // so keyboard events land on this pane
    // Capture so the matching button-up still reaches us when the pointer is
    // released outside the canvas; otherwise the remote button stays held.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const p = toDesktop(e)
    if (!p) return
    send(`md ${p[0]} ${p[1]} ${button}`)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const button = SIDECAR_BUTTON[e.button]
    if (button === undefined) return
    const p = toDesktop(e)
    if (!p) return
    send(`mu ${p[0]} ${p[1]} ${button}`)
  }

  const onWheel = (e: React.WheelEvent): void => {
    const p = toDesktop(e)
    if (!p) return
    wheelAccum.current += e.deltaY * (WHEEL_MODE_PX[e.deltaMode] ?? 1)
    // RDP: positive rotation = wheel-up; browser deltaY is positive scrolling down.
    while (Math.abs(wheelAccum.current) >= WHEEL_NOTCH_PX) {
      const down = wheelAccum.current > 0
      wheelAccum.current += down ? -WHEEL_NOTCH_PX : WHEEL_NOTCH_PX
      send(`mw ${p[0]} ${p[1]} ${down ? -120 : 120}`)
    }
  }

  const onKey = (e: React.KeyboardEvent, down: boolean): void => {
    // Let Cmd-shortcuts stay local (Cmd+Q/W/Tab, etc.) rather than swallowing
    // them into the remote — Ctrl-based combos still reach Windows normally.
    if (e.metaKey) return
    const sc = scancodeFor(e.code)
    if (!sc) return
    e.preventDefault()
    if (down) heldKeys.current.set(e.code, sc)
    else heldKeys.current.delete(e.code)
    send(`${down ? 'kd' : 'ku'} ${sc.code} ${sc.extended ? 1 : 0}`)
  }

  const releaseHeldKeys = (): void => {
    for (const sc of heldKeys.current.values()) send(`ku ${sc.code} ${sc.extended ? 1 : 0}`)
    heldKeys.current.clear()
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={(e) => onKey(e, true)}
      onKeyUp={(e) => onKey(e, false)}
      onBlur={releaseHeldKeys}
      className="flex flex-col h-full w-full items-center justify-center overflow-hidden outline-none"
      style={{ background: '#000' }}
    >
      {status !== 'connected' && (
        <div className="text-center px-6">
          <p
            className="font-['Plus_Jakarta_Sans'] font-semibold text-[14px] mb-1"
            style={{ color: 'var(--nox-text)' }}
          >
            {status === 'connecting' && 'Connecting to RDP host…'}
            {status === 'error' && 'RDP connection failed'}
            {status === 'closed' && 'RDP session ended'}
          </p>
          {message && (
            <p className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-2)' }}>
              {message}
            </p>
          )}
        </div>
      )}
      <canvas
        ref={canvasRef}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          display: status === 'connected' ? 'block' : 'none',
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          cursor: 'default',
        }}
      />
    </div>
  )
}
