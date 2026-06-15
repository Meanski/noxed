import { useEffect, useState } from 'react'
import { Radio, Columns2, X } from 'lucide-react'
import { useAppStore, Session } from '../../store'
import { IconFolder } from '../Icons'
import { formatBytesLong, sparkline } from '../../lib/format'
import { metricColorMuted } from '../../lib/colors'
import { LiveMetrics } from '../../lib/sshDispatch'

interface Props {
  session: Session
  status: string
  elapsed: string
  metrics: LiveMetrics | null
  cpuHistory: number[]
  filesOpen: boolean
  snippetsOpen: boolean
  broadcastEnabled: boolean
  onToggleFiles: () => void
  onToggleSnippets: () => void
  onToggleBroadcast: () => void
  onSplitPick?: (session: Session) => void
  onClosePane?: () => void
}

// Single bar above the terminal: identity, live metrics, and panel toggles.
export default function HostHeader({ session, status, elapsed, metrics, cpuHistory, filesOpen, snippetsOpen, broadcastEnabled, onToggleFiles, onToggleSnippets, onToggleBroadcast, onSplitPick, onClosePane }: Props) {
  const connected = status === 'connected'
  const connecting = status === 'connecting'
  const spark = sparkline(cpuHistory.slice(-20))
  const memPct = metrics && metrics.memTotal > 0 ? (metrics.memUsed / metrics.memTotal) * 100 : 0

  return (
    <div
      className="flex items-center gap-3 px-3 flex-shrink-0 select-none"
      style={{ height: 34, borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.015)' }}
    >
      {/* Status dot */}
      {connecting ? (
        <span className="relative w-1.5 h-1.5 flex-shrink-0">
          <span className="absolute inset-0 rounded-full animate-pulse" style={{ background: 'rgba(99,102,241,0.5)' }} />
          <span className="w-full h-full rounded-full block" style={{ background: '#6366f1' }} />
        </span>
      ) : connected ? (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#22c55e', boxShadow: '0 0 6px rgba(34,197,94,0.5)' }} />
      ) : (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#f87171' }} />
      )}

      {/* Host */}
      <span className="text-xs font-semibold font-mono" style={{ color: '#eeeef2', letterSpacing: '-0.01em' }}>
        {session.username}<span style={{ color: 'rgba(255,255,255,0.3)' }}>@</span>{session.host}
        {session.port !== 22 && <span style={{ color: 'rgba(255,255,255,0.3)' }}>:{session.port}</span>}
      </span>

      {connected && elapsed && (
        <span className="text-2xs font-mono" style={{ color: 'rgba(255,255,255,0.2)' }}>{elapsed}</span>
      )}

      {connecting && (
        <span className="text-2xs" style={{ color: '#9d6ff8' }}>Connecting…</span>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Inline CPU + MEM metrics */}
      {connected && metrics?.available && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <span className="text-2xs uppercase" style={{ color: 'rgba(255,255,255,0.2)', letterSpacing: '0.08em' }}>CPU</span>
            {spark && <span className="font-mono text-2xs leading-none" style={{ color: 'rgba(255,255,255,0.25)' }}>{spark}</span>}
            <span className="text-2xs font-mono font-semibold tabular-nums" style={{ color: metricColorMuted(metrics.cpu) }}>{metrics.cpu}%</span>
          </div>
          <span className="w-px h-3" style={{ background: 'rgba(255,255,255,0.07)' }} />
          <div className="flex items-center gap-1">
            <span className="text-2xs uppercase" style={{ color: 'rgba(255,255,255,0.2)', letterSpacing: '0.08em' }}>MEM</span>
            <span className="text-2xs font-mono font-semibold tabular-nums" style={{ color: metricColorMuted(memPct) }}>{formatBytesLong(metrics.memUsed)}</span>
            <span className="text-2xs font-mono" style={{ color: 'rgba(255,255,255,0.2)' }}>/ {formatBytesLong(metrics.memTotal)}</span>
          </div>
          <span className="w-px h-3" style={{ background: 'rgba(255,255,255,0.07)' }} />
        </div>
      )}

      {/* Broadcast toggle */}
      {connected && (
        <HeaderToggle
          on={broadcastEnabled}
          onClick={onToggleBroadcast}
          title={broadcastEnabled ? 'Stop broadcasting' : 'Broadcast keystrokes to all terminals'}
          activeColor="#F59E0B"
          activeBackground="rgba(245,158,11,0.15)"
          activeBorder="rgba(245,158,11,0.3)"
        >
          <Radio className="w-3 h-3" />
          <span>Broadcast</span>
        </HeaderToggle>
      )}

      {/* Snippets toggle */}
      <HeaderToggle
        on={snippetsOpen}
        onClick={onToggleSnippets}
        title={snippetsOpen ? 'Hide snippets' : 'Show snippets'}
        activeColor="#10b981"
        activeBackground="rgba(16,185,129,0.15)"
        activeBorder="rgba(16,185,129,0.3)"
      >
        <span style={{ fontSize: 10, lineHeight: 1 }}>⚡</span>
        <span>Snippets</span>
      </HeaderToggle>

      {/* Files toggle */}
      <HeaderToggle
        on={filesOpen}
        onClick={onToggleFiles}
        title={filesOpen ? 'Hide files panel' : 'Show files panel'}
        activeColor="#9d6ff8"
        activeBackground="rgba(99,102,241,0.15)"
        activeBorder="rgba(99,102,241,0.3)"
      >
        <IconFolder size={10} />
        <span>Files</span>
      </HeaderToggle>

      {onSplitPick && <SplitMenu currentSession={session} onPick={onSplitPick} />}

      {onClosePane && (
        <button
          onClick={onClosePane}
          title="Close pane"
          className="flex items-center justify-center w-5 h-5 rounded transition-all"
          style={{ color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.borderColor = 'rgba(248,113,113,0.3)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

function HeaderToggle({ on, onClick, title, activeColor, activeBackground, activeBorder, children }: {
  on: boolean
  onClick: () => void
  title: string
  activeColor: string
  activeBackground: string
  activeBorder: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-1 h-5 px-2 rounded transition-all text-2xs font-medium"
      style={{
        color: on ? activeColor : 'rgba(255,255,255,0.4)',
        background: on ? activeBackground : 'transparent',
        border: `1px solid ${on ? activeBorder : 'rgba(255,255,255,0.08)'}`,
      }}
      onMouseEnter={e => { if (!on) { e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)' } }}
      onMouseLeave={e => { if (!on) { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' } }}
    >
      {children}
    </button>
  )
}

/* ── Split pane picker ───────────────────────────────────────────────────── */
function SplitMenu({ currentSession, onPick }: { currentSession: Session; onPick: (session: Session) => void }) {
  const [open, setOpen] = useState(false)
  const sessions = useAppStore(s => s.sessions)
  const sshSessions = sessions.filter(s => (s.type ?? 'ssh') === 'ssh')

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="relative" onMouseDown={e => e.stopPropagation()}>
      <HeaderToggle
        on={open}
        onClick={() => setOpen(o => !o)}
        title="Split terminal"
        activeColor="#06b6d4"
        activeBackground="rgba(6,182,212,0.15)"
        activeBorder="rgba(6,182,212,0.3)"
      >
        <Columns2 className="w-3 h-3" />
        <span>Split</span>
      </HeaderToggle>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 rounded-lg py-1 min-w-[180px] max-h-[260px] overflow-y-auto"
          style={{ background: '#16141d', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
        >
          <SplitMenuItem
            label={`${currentSession.label || currentSession.host} (again)`}
            onClick={() => { onPick(currentSession); setOpen(false) }}
          />
          {sshSessions.filter(s => s.id !== currentSession.id).map(s => (
            <SplitMenuItem
              key={s.id}
              label={s.label || s.host}
              onClick={() => { onPick(s); setOpen(false) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SplitMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 text-2xs truncate transition-colors"
      style={{ color: 'rgba(255,255,255,0.7)' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#fff' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)' }}
    >
      {label}
    </button>
  )
}
