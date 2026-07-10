import { useEffect, useRef, useState } from 'react'
import { X, ArrowDownToLine, Loader2 } from 'lucide-react'

const TAIL_OPTIONS = [100, 500, 1000, 5000]

interface Props {
  dockerId: string
  containerName: string
  containerId: string
  onClose: () => void
}

export default function DockerLogsModal({ dockerId, containerName, containerId, onClose }: Props) {
  const [tail, setTail] = useState(500)
  const [follow, setFollow] = useState(true)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  const logIdRef = useRef<string | null>(null)
  const followRef = useRef(true)
  followRef.current = follow

  useEffect(() => {
    let cancelled = false
    setError('')
    setStreaming(true)
    if (logRef.current) logRef.current.textContent = ''

    const offChunk = window.api.docker.onLogChunk((logId, data) => {
      if (logId !== logIdRef.current || !logRef.current) return
      logRef.current.textContent += data
      if (followRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    })
    const offEnd = window.api.docker.onLogEnd((logId, err) => {
      if (logId !== logIdRef.current) return
      setStreaming(false)
      if (err) setError(err)
    })

    window.api.docker.logsStart(dockerId, containerId, tail)
      .then(logId => {
        if (cancelled) { window.api.docker.logsStop(logId); return }
        logIdRef.current = logId
      })
      .catch((err: any) => {
        if (!cancelled) { setError(err?.message ?? 'Failed to stream logs'); setStreaming(false) }
      })

    return () => {
      cancelled = true
      offChunk()
      offEnd()
      if (logIdRef.current) {
        window.api.docker.logsStop(logIdRef.current).catch(() => {})
        logIdRef.current = null
      }
    }
  }, [dockerId, containerId, tail])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-[80vw] max-w-[960px] h-[70vh] flex flex-col rounded-xl overflow-hidden animate-slide-up"
        style={{ background: '#0c0b0f', border: '1px solid var(--nox-border)', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}
      >
        <div className="flex items-center gap-3 px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <span className="font-mono text-[12.5px] font-semibold" style={{ color: '#eeeef2' }}>
            {containerName}
          </span>
          {streaming && (
            <span className="flex items-center gap-1.5 text-[10.5px]" style={{ color: '#10B981' }}>
              <Loader2 className="w-3 h-3 animate-spin" />
              streaming
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            <select
              value={tail}
              onChange={e => setTail(Number.parseInt(e.target.value))}
              className="rounded px-2 py-1 text-[11px] font-mono focus:outline-none"
              style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              {TAIL_OPTIONS.map(n => <option key={n} value={n}>tail {n}</option>)}
            </select>
            <button
              onClick={() => setFollow(f => !f)}
              title={follow ? 'Stop following' : 'Follow output'}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors"
              style={follow
                ? { background: 'rgba(16,185,129,0.15)', color: '#10B981', border: '1px solid rgba(16,185,129,0.3)' }
                : { background: 'transparent', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <ArrowDownToLine className="w-3 h-3" />
              Follow
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded transition-colors"
              style={{ color: 'rgba(255,255,255,0.5)' }}
              onMouseEnter={e => { e.currentTarget.style.color = '#fff' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.5)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <pre
          ref={logRef}
          className="flex-1 overflow-auto px-4 py-3 m-0 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all select-text"
          style={{ color: 'rgba(255,255,255,0.78)' }}
          onWheel={() => setFollow(false)}
        />

        {error && (
          <div className="px-4 py-2 text-[11.5px] flex-shrink-0" style={{ color: '#f87171', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
