import { useState, useEffect, useRef, useCallback } from 'react'
import { X, RefreshCw, Download, Search, ChevronDown, Play, Square } from 'lucide-react'

interface Props {
  context: string
  namespace: string
  pod: string
  containers: string[]
  kubeconfigPath?: string
  onClose: () => void
}

const TAIL_OPTIONS = [100, 200, 500, 1000, 5000]

export default function PodLogsModal({ context, namespace, pod, containers, kubeconfigPath, onClose }: Props) {
  const [container, setContainer] = useState(containers[0] ?? '')
  const [tailLines, setTailLines] = useState(500)
  const [logs, setLogs] = useState('')
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [filter, setFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const logRef = useRef<HTMLPreElement>(null)
  const streamIdRef = useRef<string | null>(null)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const data = await window.api.k8s.logsGet(context, namespace, pod, container, tailLines, kubeconfigPath)
      setLogs(data)
    } catch (err: any) {
      setLogs(`Error: ${err?.message ?? 'Failed to fetch logs'}`)
    } finally {
      setLoading(false)
    }
  }, [context, namespace, pod, container, tailLines, kubeconfigPath])

  // A container/tail switch invalidates any running stream — stop it before refetching
  useEffect(() => {
    if (streamIdRef.current) {
      window.api.k8s.logsStop(streamIdRef.current)
      streamIdRef.current = null
      setStreaming(false)
    }
    fetchLogs()
  }, [fetchLogs])

  useEffect(() => {
    const offChunk = window.api.k8s.onLogChunk((sid, data) => {
      if (sid !== streamIdRef.current) return
      // Cap the buffer so a chatty pod can't grow memory without bound
      setLogs(prev => {
        const next = prev + data
        return next.length > 2_000_000 ? next.slice(next.indexOf('\n', next.length - 1_500_000) + 1) : next
      })
    })
    const offEnd = window.api.k8s.onLogEnd((sid) => {
      if (sid !== streamIdRef.current) return
      setStreaming(false)
      streamIdRef.current = null
    })
    return () => { offChunk(); offEnd() }
  }, [])

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  // Stop stream on unmount
  useEffect(() => {
    return () => {
      if (streamIdRef.current) {
        window.api.k8s.logsStop(streamIdRef.current)
      }
    }
  }, [])

  async function startStream() {
    if (streamIdRef.current) {
      await window.api.k8s.logsStop(streamIdRef.current)
    }
    setLogs('')
    setStreaming(true)
    try {
      const sid = await window.api.k8s.logsStream(context, namespace, pod, container, tailLines, kubeconfigPath)
      streamIdRef.current = sid
    } catch (err: any) {
      setLogs(`Error: ${err?.message ?? 'Failed to start log stream'}`)
      setStreaming(false)
    }
  }

  async function stopStream() {
    if (streamIdRef.current) {
      await window.api.k8s.logsStop(streamIdRef.current)
      streamIdRef.current = null
    }
    setStreaming(false)
  }

  function downloadLogs() {
    const blob = new Blob([logs], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${pod}-${container}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const displayedLines = filter
    ? logs.split('\n').filter(l => l.toLowerCase().includes(filter.toLowerCase())).join('\n')
    : logs

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-[900px] max-w-[95vw] h-[80vh] flex flex-col rounded-xl overflow-hidden shadow-2xl"
        style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{ background: 'var(--nox-shell)', borderBottom: '1px solid var(--nox-border)' }}
        >
          <div className="flex items-center gap-3">
            <div>
              <p className="font-['Plus_Jakarta_Sans'] font-semibold text-[14px]" style={{ color: 'var(--nox-text)' }}>
                Logs — {pod}
              </p>
              <p className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>{namespace}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md transition-colors"
            style={{ color: 'var(--nox-text-2)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div
          className="flex items-center gap-2 px-4 py-2 flex-shrink-0 flex-wrap"
          style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}
        >
          {/* Container selector */}
          {containers.length > 1 && (
            <select
              value={container}
              onChange={e => setContainer(e.target.value)}
              className="px-2 py-1 rounded-md font-['Inter'] text-[12px] focus:outline-none"
              style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
            >
              {containers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}

          {/* Tail lines */}
          <div className="relative flex items-center">
            <select
              value={tailLines}
              onChange={e => setTailLines(Number(e.target.value))}
              className="px-2 py-1 rounded-md font-['Inter'] text-[12px] focus:outline-none appearance-none pr-6"
              style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
            >
              {TAIL_OPTIONS.map(n => <option key={n} value={n}>Last {n} lines</option>)}
            </select>
            <ChevronDown className="w-3 h-3 absolute right-1.5 pointer-events-none" style={{ color: 'var(--nox-text-3)' }} />
          </div>

          {/* Filter */}
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded-md flex-1 min-w-[150px]"
            style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}
          >
            <Search className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter lines…"
              className="bg-transparent outline-none font-['Inter'] text-[12px] w-full"
              style={{ color: 'var(--nox-text)' }}
            />
          </div>

          <div className="flex items-center gap-1 ml-auto">
            {/* Auto-scroll toggle */}
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={e => setAutoScroll(e.target.checked)}
                className="w-3 h-3 accent-[#8B5CF6]"
              />
              <span className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>Auto-scroll</span>
            </label>

            {/* Stream toggle */}
            <button
              onClick={streaming ? stopStream : startStream}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md font-['Inter'] text-[12px] font-medium transition-colors ml-2"
              style={{
                background: streaming ? '#EF444418' : '#10B98118',
                color: streaming ? '#EF4444' : '#10B981',
                border: `1px solid ${streaming ? '#EF444430' : '#10B98130'}`,
              }}
            >
              {streaming ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              {streaming ? 'Stop' : 'Stream'}
            </button>

            {/* Refresh */}
            <button
              onClick={fetchLogs}
              disabled={loading || streaming}
              className="p-1.5 rounded-md transition-colors disabled:opacity-40"
              style={{ color: 'var(--nox-text-2)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>

            {/* Download */}
            <button
              onClick={downloadLogs}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: 'var(--nox-text-2)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              title="Download logs"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Log output */}
        <pre
          ref={logRef}
          className="flex-1 overflow-auto p-4 font-['JetBrains_Mono'] text-[12px] leading-relaxed"
          style={{
            color: 'var(--nox-text)',
            background: '#0c0b0f',
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {loading && !logs ? (
            <span style={{ color: '#6B7280' }}>Loading logs…</span>
          ) : displayedLines || (
            <span style={{ color: '#6B7280' }}>No logs available</span>
          )}
          {streaming && <span className="animate-pulse" style={{ color: '#10B981' }}>█</span>}
        </pre>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-4 py-1.5 flex-shrink-0"
          style={{ background: 'var(--nox-shell)', borderTop: '1px solid var(--nox-border)' }}
        >
          <span className="font-['Inter'] text-[11px]" style={{ color: 'var(--nox-text-3)' }}>
            {displayedLines.split('\n').filter(Boolean).length} lines
            {filter && ` (filtered from ${logs.split('\n').filter(Boolean).length})`}
          </span>
          {streaming && (
            <span className="flex items-center gap-1.5 font-['Inter'] text-[11px]" style={{ color: '#10B981' }}>
              <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse" />
              Streaming
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
