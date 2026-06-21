import React, { useEffect, useRef, useState } from 'react'
import type { Tab } from '../../store'
import { useAppStore } from '../../store'
import { lookupScancode } from '../../lib/rdpKeymap'

// RDP desktop: the FreeRDP sidecar streams RGBA frames over IPC and we blit each
// one to a canvas; mouse/keyboard events on the canvas are sent back over the
// same sidecar (window.api.rdp.input).
//
// STATUS: connects, paints frames, mouse + keyboard input. No live resize
// re-negotiation yet (resizing after connect just scales the canvas).

type Status = 'connecting' | 'connected' | 'error' | 'closed'

// Wire message types (match sidecar.c InputMsg.type).
const INPUT_MOUSE = 1
const INPUT_KEY = 2

// FreeRDP pointer flags (see freerdp/input.h).
const PTR_FLAGS_MOVE = 0x0800
const PTR_FLAGS_DOWN = 0x8000
const PTR_FLAGS_BUTTON1 = 0x1000 // left
const PTR_FLAGS_BUTTON2 = 0x2000 // right
const PTR_FLAGS_BUTTON3 = 0x4000 // middle
const PTR_FLAGS_WHEEL = 0x0200
const PTR_FLAGS_WHEEL_NEGATIVE = 0x0100
const WHEEL_ROTATION_MASK = 0x01ff

// FreeRDP keyboard flags.
const KBD_FLAGS_EXTENDED = 0x0100
const KBD_FLAGS_RELEASE = 0x8000

function mouseButtonFlag(button: number): number {
  if (button === 0) return PTR_FLAGS_BUTTON1
  if (button === 2) return PTR_FLAGS_BUTTON2
  if (button === 1) return PTR_FLAGS_BUTTON3
  return 0
}

export default function RdpView({ tab }: { tab: Tab }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // The active sidecar session id, readable from event handlers.
  const activeIdRef = useRef<string | null>(null)
  // Coalesce frequent mousemove events to one send per animation frame.
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null)
  const moveRafRef = useRef<number | null>(null)
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
    let pendingId: string | null = null
    let disposed = false
    const offFns: Array<() => void> = []

    const paint = (id: string, width: number, height: number, pixels: Uint8Array) => {
      if (id !== rdpId) return
      const canvas = canvasRef.current
      if (!canvas) return
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // pixels is RGBA (sidecar already swizzled + forced alpha). Copy into a
      // fresh clamped array so ImageData gets a plain ArrayBuffer-backed view.
      const img = new ImageData(new Uint8ClampedArray(pixels), width, height)
      ctx.putImageData(img, 0, 0)
      if (status !== 'connected') setStatus('connected')
    }

    offFns.push(window.api.rdp.onFrame(paint))
    offFns.push(
      window.api.rdp.onClose((id, error) => {
        if (id !== rdpId && id !== pendingId) return
        activeIdRef.current = null
        setStatus(error ? 'error' : 'closed')
        if (error) setMessage(error)
      }),
    )

    ;(async () => {
      try {
        const { password } = await window.api.sessions.getCredentials(session.id)
        if (disposed) return
        // Negotiate the desktop at the current pane size so it fills the window
        // instead of rendering at a fixed small resolution. RDP widths/heights
        // must be even; clamp to a sane minimum. (No live re-negotiation yet —
        // resizing after connect just scales the canvas via object-fit.)
        const el = containerRef.current
        const even = (n: number) => n - (n % 2)
        const width = el && el.clientWidth > 0 ? Math.max(640, even(el.clientWidth)) : 1280
        const height = el && el.clientHeight > 0 ? Math.max(480, even(el.clientHeight)) : 800
        const id = await window.api.rdp.connect({
          host: session.host,
          // RDP connections store 3389; fall back for non-RDP hosts opened ad hoc.
          port: session.port || 3389,
          username: session.username,
          password: password ?? '',
          width,
          height,
        })
        if (disposed) {
          // Component was unmounted while connect was in progress
          window.api.rdp.disconnect(id).catch(() => {})
        } else {
          rdpId = id
          pendingId = null
          activeIdRef.current = id
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
      activeIdRef.current = null
      if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current)
      offFns.forEach((off) => off())
      if (rdpId) window.api.rdp.disconnect(rdpId).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId])

  // Map a client (viewport) coordinate to a remote desktop pixel, accounting for
  // the object-fit: contain letterboxing. Returns null for points in the
  // letterbox margins (outside the actual desktop image).
  const toRemote = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const imgW = canvas.width
    const imgH = canvas.height
    if (!imgW || !imgH || !rect.width || !rect.height) return null
    const scale = Math.min(rect.width / imgW, rect.height / imgH)
    const dispW = imgW * scale
    const dispH = imgH * scale
    const offX = (rect.width - dispW) / 2
    const offY = (rect.height - dispH) / 2
    const x = Math.round((clientX - rect.left - offX) / scale)
    const y = Math.round((clientY - rect.top - offY) / scale)
    if (x < 0 || y < 0 || x >= imgW || y >= imgH) return null
    return { x, y }
  }

  const sendMouse = (flags: number, x: number, y: number): void => {
    const id = activeIdRef.current
    if (id) window.api.rdp.input(id, INPUT_MOUSE, flags, x, y)
  }

  const sendKey = (scancode: number, extended: boolean, down: boolean): void => {
    const id = activeIdRef.current
    if (!id) return
    const flags = (extended ? KBD_FLAGS_EXTENDED : 0) | (down ? 0 : KBD_FLAGS_RELEASE)
    window.api.rdp.input(id, INPUT_KEY, flags, scancode, 0)
  }

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const p = toRemote(e.clientX, e.clientY)
    if (!p) return
    pendingMoveRef.current = p
    if (moveRafRef.current === null) {
      moveRafRef.current = requestAnimationFrame(() => {
        moveRafRef.current = null
        const move = pendingMoveRef.current
        if (move) sendMouse(PTR_FLAGS_MOVE, move.x, move.y)
      })
    }
  }

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    canvasRef.current?.focus()
    const p = toRemote(e.clientX, e.clientY)
    if (!p) return
    e.preventDefault()
    // Position the pointer first, then press, so the click lands where expected.
    sendMouse(PTR_FLAGS_MOVE, p.x, p.y)
    sendMouse(PTR_FLAGS_DOWN | mouseButtonFlag(e.button), p.x, p.y)
  }

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const p = toRemote(e.clientX, e.clientY)
    if (!p) return
    e.preventDefault()
    sendMouse(mouseButtonFlag(e.button), p.x, p.y)
  }

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const p = toRemote(e.clientX, e.clientY)
    if (!p) return
    const up = e.deltaY < 0
    const magnitude = 120 & WHEEL_ROTATION_MASK
    const flags = PTR_FLAGS_WHEEL | (up ? 0 : PTR_FLAGS_WHEEL_NEGATIVE) | magnitude
    sendMouse(flags, p.x, p.y)
  }

  const onKey = (e: React.KeyboardEvent<HTMLCanvasElement>, down: boolean): void => {
    const key = lookupScancode(e.code)
    if (!key) return
    // Swallow the event so browser/app shortcuts don't fire while the desktop
    // has focus; the keystroke goes to the remote instead.
    e.preventDefault()
    e.stopPropagation()
    sendKey(key.scancode, key.extended, down)
  }

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full w-full items-center justify-center overflow-hidden"
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
        tabIndex={0}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => onKey(e, true)}
        onKeyUp={(e) => onKey(e, false)}
        style={{
          display: status === 'connected' ? 'block' : 'none',
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          outline: 'none',
        }}
      />
    </div>
  )
}
