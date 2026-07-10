import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, Play, Square, TerminalSquare } from 'lucide-react'
import { useAppStore, Session } from '../../store'

type HostState = 'running' | 'done' | 'failed'

interface HostResult {
  state: HostState
  output: string
  exitCode: number | null
  error: string | null
}

export default function RunnerView() {
  const sessions = useAppStore(s => s.sessions)
  const addNotification = useAppStore(s => s.addNotification)
  const sshSessions = sessions.filter(s => (s.type ?? 'ssh') === 'ssh')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [command, setCommand] = useState('')
  const [results, setResults] = useState<Map<string, HostResult>>(new Map())
  const [running, setRunning] = useState(false)
  const runIdRef = useRef<string | null>(null)

  const applyOutput = (sessionId: string, data: string) => {
    setResults(prev => {
      const next = new Map(prev)
      const r = next.get(sessionId)
      if (r) next.set(sessionId, { ...r, output: r.output + data })
      return next
    })
  }

  const applyDone = (sessionId: string, exitCode: number | null, error: string | null) => {
    setResults(prev => {
      const next = new Map(prev)
      const r = next.get(sessionId)
      if (r) {
        next.set(sessionId, {
          ...r,
          state: error || exitCode !== 0 ? 'failed' : 'done',
          exitCode,
          error,
        })
      }
      setRunning([...next.values()].some(v => v.state === 'running'))
      return next
    })
  }

  useEffect(() => {
    const offOutput = window.api.runner.onOutput((runId, sessionId, data) => {
      if (runId !== runIdRef.current) return
      applyOutput(sessionId, data)
    })
    const offDone = window.api.runner.onDone((runId, sessionId, exitCode, error) => {
      if (runId !== runIdRef.current) return
      applyDone(sessionId, exitCode, error)
    })
    return () => {
      offOutput()
      offDone()
      if (runIdRef.current) window.api.runner.cancel(runIdRef.current).catch(() => {})
    }
  }, [])

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(prev => prev.size === sshSessions.length ? new Set() : new Set(sshSessions.map(s => s.id)))
  }

  async function run() {
    if (!command.trim() || selected.size === 0 || running) return
    const ids = [...selected]
    setResults(new Map(ids.map(id => [id, { state: 'running' as HostState, output: '', exitCode: null, error: null }])))
    setRunning(true)
    try {
      runIdRef.current = await window.api.runner.run(ids, command)
    } catch (err: any) {
      setRunning(false)
      setResults(new Map())
      addNotification({ type: 'error', message: err?.message ?? 'Run failed' })
    }
  }

  async function cancel() {
    if (!runIdRef.current) return
    await window.api.runner.cancel(runIdRef.current).catch(() => {})
    setResults(prev => {
      const next = new Map(prev)
      for (const [id, r] of next) {
        if (r.state === 'running') next.set(id, { ...r, state: 'failed', error: 'Cancelled' })
      }
      return next
    })
    setRunning(false)
  }

  const sessionById = (id: string) => sessions.find(s => s.id === id)

  return (
    <div className="h-full flex" style={{ background: 'var(--nox-bg)' }}>
      {/* Host picker */}
      <div
        className="w-[230px] flex-shrink-0 flex flex-col overflow-hidden"
        style={{ borderRight: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2 flex-shrink-0">
          <span className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--nox-text-3)' }}>
            Hosts ({selected.size}/{sshSessions.length})
          </span>
          <button
            onClick={toggleAll}
            className="font-['Inter'] text-[11px] transition-colors"
            style={{ color: '#3B5CCC' }}
          >
            {selected.size === sshSessions.length ? 'None' : 'All'}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {sshSessions.map(s => {
            const checked = selected.has(s.id)
            return (
              <label
                key={s.id}
                className="flex items-center gap-2.5 px-2 py-1.5 rounded-md cursor-pointer"
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <div
                  className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                  style={{
                    border: `2px solid ${checked ? '#3B5CCC' : 'var(--nox-border)'}`,
                    background: checked ? '#3B5CCC' : 'transparent',
                  }}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(s.id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(s.id) } }}
                >
                  {checked && <Check className="w-3 h-3 text-white" />}
                </div>
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: s.color ?? '#3B5CCC' }} />
                <span className="font-['Inter'] text-[12px] truncate" style={{ color: 'var(--nox-text)' }}>
                  {s.label || s.host}
                </span>
              </label>
            )
          })}
          {sshSessions.length === 0 && (
            <p className="font-['Inter'] text-[11.5px] px-2 py-4" style={{ color: 'var(--nox-text-3)' }}>
              No SSH connections configured yet.
            </p>
          )}
        </div>
      </div>

      {/* Command + results */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="p-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--nox-border)' }}>
          <div className="flex items-center gap-2">
            <div
              className="flex-1 flex items-center gap-2 rounded-md px-3 py-2"
              style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
            >
              <TerminalSquare className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
              <input
                value={command}
                onChange={e => setCommand(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run() }}
                placeholder="uptime && df -h /  —  runs on every selected host"
                spellCheck={false}
                className="flex-1 bg-transparent outline-none font-mono text-[12.5px]"
                style={{ color: 'var(--nox-text)' }}
              />
            </div>
            {running ? (
              <button
                onClick={cancel}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-md font-['Inter'] text-[12px] font-medium transition-colors"
                style={{ background: 'rgba(239,68,68,0.1)', color: '#EF4444' }}
              >
                <Square className="w-3 h-3" />
                Cancel
              </button>
            ) : (
              <button
                onClick={run}
                disabled={!command.trim() || selected.size === 0}
                title="Run (⌘↩)"
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-md font-['Inter'] text-[12px] font-medium text-white transition-colors disabled:opacity-40"
                style={{ background: '#3B5CCC' }}
              >
                <Play className="w-3 h-3" />
                Run
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {results.size === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <TerminalSquare className="w-8 h-8 mb-3" style={{ color: 'var(--nox-text-3)' }} />
              <p className="font-['Inter'] text-[13px] mb-1" style={{ color: 'var(--nox-text)' }}>
                Run a command across your fleet
              </p>
              <p className="font-['Inter'] text-[12px] max-w-sm" style={{ color: 'var(--nox-text-2)' }}>
                Pick hosts on the left, type a command, and watch outputs and exit codes
                come back side by side.
              </p>
            </div>
          ) : (
            [...results.entries()].map(([id, result]) => (
              <HostResultCard key={id} session={sessionById(id)} result={result} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function resultBadge(result: HostResult): { text: string; color: string } {
  if (result.state === 'running') return { text: 'running', color: '#3B5CCC' }
  if (result.state === 'done') return { text: 'exit 0', color: '#10B981' }
  return { text: result.error ? 'error' : `exit ${result.exitCode}`, color: '#EF4444' }
}

function resultText(result: HostResult): string {
  if (result.error) return result.error
  if (result.output) return result.output
  return result.state === 'running' ? '…' : '(no output)'
}

function HostResultCard({ session, result }: Readonly<{ session?: Session; result: HostResult }>) {
  const [open, setOpen] = useState(true)
  const label = session ? (session.label || session.host) : 'unknown host'

  const badge = resultBadge(result)

  return (
    <div className="rounded-md overflow-hidden" style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--nox-text-3)' }} /> : <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--nox-text-3)' }} />}
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: session?.color ?? '#3B5CCC' }} />
        <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[12.5px] flex-1 truncate" style={{ color: 'var(--nox-text)' }}>
          {label}
        </span>
        {result.state === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: badge.color }} />}
        <span
          className="font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ background: badge.color + '18', color: badge.color }}
        >
          {badge.text}
        </span>
      </button>
      {open && (
        <pre
          className="m-0 px-4 py-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all max-h-72 overflow-y-auto select-text"
          style={{ background: 'var(--nox-bg)', color: 'var(--nox-text-2)', borderTop: '1px solid var(--nox-border)' }}
        >
          {resultText(result)}
        </pre>
      )}
    </div>
  )
}
