import { useEffect, useRef, useState } from 'react'
import type { Tab } from '../../store'
import { useAppStore } from '../../store'

// Read-only RDP desktop: the FreeRDP sidecar streams RGBA frames over IPC and
// we blit each one to a canvas. Input injection is the next milestone.
//
// SPIKE STATUS: connects, paints frames, surfaces connect/close errors. No
// reconnect, no resize negotiation, no keyboard/mouse yet.

type Status = 'connecting' | 'connected' | 'error' | 'closed'

export default function RdpView({ tab }: Readonly<{ tab: Tab }>) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
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
    let rafId = 0
    // Latest frame wins: frames can arrive faster than we can paint 4MB of
    // pixels, so we stash the newest one and blit at most once per
    // animation frame instead of letting putImageData calls pile up.
    let latest: { width: number; height: number; pixels: Uint8Array } | null = null
    const offFns: Array<() => void> = []

    const blit = () => {
      rafId = 0
      const frame = latest
      latest = null
      if (!frame || disposed) return
      const canvas = canvasRef.current
      if (!canvas) return
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width
        canvas.height = frame.height
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // pixels is RGBA (sidecar already swizzled + forced alpha). Copy into a
      // fresh clamped array so ImageData gets a plain ArrayBuffer-backed view.
      const img = new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height)
      ctx.putImageData(img, 0, 0)
      setStatus((s) => (s === 'connected' ? s : 'connected'))
    }

    const paint = (id: string, width: number, height: number, pixels: Uint8Array) => {
      if (id !== rdpId) return
      latest = { width, height, pixels }
      if (!rafId) rafId = requestAnimationFrame(blit)
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
        // Ask for a desktop matching the pane so the image isn't scaled.
        // Even numbers keep RDP codecs happy; fall back to 1280×800 if the
        // pane hasn't laid out yet.
        const rect = containerRef.current?.getBoundingClientRect()
        const even = (n: number) => Math.floor(n / 2) * 2
        const id = await window.api.rdp.connect({
          host: session.host,
          // RDP connections store 3389; fall back for non-RDP hosts opened ad hoc.
          port: session.port || 3389,
          username: session.username,
          password,
          width: rect && rect.width >= 640 ? even(rect.width) : 1280,
          height: rect && rect.height >= 480 ? even(rect.height) : 800,
        })
        if (disposed) {
          // Component was unmounted while connect was in progress
          window.api.rdp.disconnect(id).catch(() => {})
        } else {
          rdpId = id
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
      if (rafId) cancelAnimationFrame(rafId)
      offFns.forEach((off) => off())
      if (rdpId) window.api.rdp.disconnect(rdpId).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId])

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
        style={{
          display: status === 'connected' ? 'block' : 'none',
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
        }}
      />
    </div>
  )
}
