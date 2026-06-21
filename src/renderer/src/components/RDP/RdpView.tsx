import React, { useEffect, useRef, useState } from 'react'
import type { Tab } from '../../store'
import { useAppStore } from '../../store'

// Read-only RDP desktop: the FreeRDP sidecar streams RGBA frames over IPC and
// we blit each one to a canvas. Input injection is the next milestone.
//
// SPIKE STATUS: connects, paints frames, surfaces connect/close errors. No
// reconnect, no resize negotiation, no keyboard/mouse yet.

type Status = 'connecting' | 'connected' | 'error' | 'closed'

export default function RdpView({ tab }: { tab: Tab }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
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
        if (id !== rdpId) return
        setStatus(error ? 'error' : 'closed')
        if (error) setMessage(error)
      }),
    )

    ;(async () => {
      try {
        const { password } = await window.api.sessions.getCredentials(session.id)
        if (disposed) return
        rdpId = await window.api.rdp.connect({
          host: session.host,
          // RDP connections store 3389; fall back for non-RDP hosts opened ad hoc.
          port: session.port || 3389,
          username: session.username,
          password: password ?? '',
          width: 1280,
          height: 800,
        })
      } catch (err) {
        if (!disposed) {
          setStatus('error')
          setMessage(err instanceof Error ? err.message : String(err))
        }
      }
    })()

    return () => {
      disposed = true
      offFns.forEach((off) => off())
      if (rdpId) window.api.rdp.disconnect(rdpId).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId])

  return (
    <div
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
