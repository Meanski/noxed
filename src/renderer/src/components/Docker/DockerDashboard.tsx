import { useEffect, useRef, useState } from 'react'
import {
  Loader2, RefreshCw, Play, Square, RotateCcw, Trash2, ScrollText,
  Boxes, AlertTriangle, ChevronRight, ChevronDown, HardDrive,
} from 'lucide-react'
import { useAppStore, Tab } from '../../store'
import DockerLogsModal from './DockerLogsModal'

interface ContainerRow {
  ID: string
  Names: string
  Image: string
  State: string
  Status: string
  Ports: string
}

interface StatsRow {
  Name: string
  CPUPerc: string
  MemUsage: string
}

interface ImageRow {
  Repository: string
  Tag: string
  Size: string
  CreatedSince: string
}

const POLL_INTERVAL_MS = 6000

interface Props {
  tab: Tab
}

export default function DockerDashboard({ tab }: Props) {
  const sessions = useAppStore(s => s.sessions)
  const addNotification = useAppStore(s => s.addNotification)
  const session = sessions.find(s => s.id === tab.sessionId)

  const dockerIdRef = useRef<string | null>(null)
  const [phase, setPhase] = useState<'connecting' | 'ready' | 'error'>('connecting')
  const [error, setError] = useState('')
  const [containers, setContainers] = useState<ContainerRow[]>([])
  const [stats, setStats] = useState<Map<string, StatsRow>>(new Map())
  const [images, setImages] = useState<ImageRow[]>([])
  const [imagesOpen, setImagesOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [busyContainer, setBusyContainer] = useState<string | null>(null)
  const [logsTarget, setLogsTarget] = useState<ContainerRow | null>(null)

  async function refresh(): Promise<void> {
    const id = dockerIdRef.current
    if (!id) return
    setRefreshing(true)
    try {
      const [cs, st] = await Promise.all([
        window.api.docker.containers(id) as Promise<ContainerRow[]>,
        window.api.docker.stats(id) as Promise<StatsRow[]>,
      ])
      setContainers(cs)
      setStats(new Map(st.map(s => [s.Name, s])))
      setPhase('ready')
    } catch (err: any) {
      setError(err?.message ?? 'Failed to query Docker')
      setPhase('error')
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!tab.sessionId) return
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null

    window.api.docker.connect(tab.sessionId)
      .then(async id => {
        if (cancelled) { window.api.docker.disconnect(id); return }
        dockerIdRef.current = id
        await refresh()
        window.api.docker.images(id)
          .then(imgs => { if (!cancelled) setImages(imgs as ImageRow[]) })
          .catch(() => {})
        interval = setInterval(refresh, POLL_INTERVAL_MS)
      })
      .catch((err: any) => {
        if (cancelled) return
        setError(err?.message ?? 'Connection failed')
        setPhase('error')
      })

    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
      if (dockerIdRef.current) {
        window.api.docker.disconnect(dockerIdRef.current).catch(() => {})
        dockerIdRef.current = null
      }
    }
  }, [tab.sessionId])

  async function runAction(container: ContainerRow, action: 'start' | 'stop' | 'restart' | 'rm') {
    const id = dockerIdRef.current
    if (!id) return
    if (action === 'rm' && !confirm(`Remove container "${container.Names}"? This cannot be undone.`)) return
    setBusyContainer(container.ID)
    try {
      await window.api.docker.action(id, container.ID, action)
      await refresh()
    } catch (err: any) {
      addNotification({ type: 'error', message: `${action} ${container.Names}: ${err?.message ?? 'failed'}` })
    } finally {
      setBusyContainer(null)
    }
  }

  const running = containers.filter(c => c.State === 'running').length

  return (
    <div className="h-full w-full overflow-y-auto" style={{ background: 'var(--nox-bg)' }}>
      <div className="p-6 max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="font-['Plus_Jakarta_Sans'] font-bold text-[22px] flex items-center gap-2.5" style={{ color: 'var(--nox-text)' }}>
              <Boxes className="w-5 h-5" style={{ color: '#2496ED' }} />
              Docker
            </h1>
            <p className="font-['Inter'] text-[12.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
              {session ? `${session.username}@${session.host}` : 'Unknown host'}
              {phase === 'ready' && ` · ${running} running / ${containers.length} containers`}
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={phase !== 'ready' || refreshing}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-['Inter'] text-[12px] transition-colors disabled:opacity-50"
            style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {phase === 'connecting' && (
          <div className="flex items-center justify-center gap-2 py-20" style={{ color: 'var(--nox-text-2)' }}>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="font-['Inter'] text-[13px]">Connecting over SSH…</span>
          </div>
        )}

        {phase === 'error' && (
          <div
            className="flex items-start gap-3 rounded-md p-4"
            style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)' }}
          >
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#EF4444' }} />
            <div>
              <p className="font-['Inter'] text-[13px] font-medium" style={{ color: 'var(--nox-text)' }}>
                Docker unavailable
              </p>
              <p className="font-['Inter'] text-[12px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>{error}</p>
            </div>
          </div>
        )}

        {phase === 'ready' && (
          <>
            {containers.length === 0 ? (
              <div
                className="rounded-md p-10 text-center"
                style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
              >
                <p className="font-['Inter'] text-[13px]" style={{ color: 'var(--nox-text-2)' }}>
                  No containers on this host.
                </p>
              </div>
            ) : (
              <div className="rounded-md overflow-hidden" style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}>
                <table className="w-full">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-sidebar)' }}>
                      {['Container', 'Image', 'Status', 'CPU', 'Memory', 'Ports', ''].map(h => (
                        <th
                          key={h}
                          className="text-left font-['Plus_Jakarta_Sans'] text-[10.5px] uppercase tracking-wider font-semibold px-4 py-2.5"
                          style={{ color: 'var(--nox-text-3)', textAlign: h === '' ? 'right' : 'left' }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {containers.map((c, i) => (
                      <ContainerTableRow
                        key={c.ID}
                        container={c}
                        stat={stats.get(c.Names)}
                        last={i === containers.length - 1}
                        busy={busyContainer === c.ID}
                        onAction={a => runAction(c, a)}
                        onLogs={() => setLogsTarget(c)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Images */}
            <div className="mt-5">
              <button
                onClick={() => setImagesOpen(o => !o)}
                className="flex items-center gap-1.5 font-['Plus_Jakarta_Sans'] text-[11px] uppercase tracking-wider font-semibold"
                style={{ color: 'var(--nox-text-3)' }}
              >
                {imagesOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                <HardDrive className="w-3.5 h-3.5" />
                Images ({images.length})
              </button>
              {imagesOpen && images.length > 0 && (
                <div className="mt-2 rounded-md overflow-hidden" style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}>
                  <table className="w-full">
                    <tbody>
                      {images.map((img, i) => (
                        <tr key={`${img.Repository}:${img.Tag}-${i}`} style={i < images.length - 1 ? { borderBottom: '1px solid var(--nox-border)' } : {}}>
                          <td className="px-4 py-2 font-mono text-[11.5px]" style={{ color: 'var(--nox-text)' }}>
                            {img.Repository}<span style={{ color: 'var(--nox-text-3)' }}>:{img.Tag}</span>
                          </td>
                          <td className="px-4 py-2 font-['Inter'] text-[11.5px] text-right" style={{ color: 'var(--nox-text-2)' }}>
                            {img.CreatedSince}
                          </td>
                          <td className="px-4 py-2 font-mono text-[11.5px] text-right w-24" style={{ color: 'var(--nox-text-2)' }}>
                            {img.Size}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {logsTarget && dockerIdRef.current && (
        <DockerLogsModal
          dockerId={dockerIdRef.current}
          containerName={logsTarget.Names}
          containerId={logsTarget.ID}
          onClose={() => setLogsTarget(null)}
        />
      )}
    </div>
  )
}

function ContainerTableRow({ container, stat, last, busy, onAction, onLogs }: {
  container: ContainerRow
  stat?: StatsRow
  last: boolean
  busy: boolean
  onAction: (action: 'start' | 'stop' | 'restart' | 'rm') => void
  onLogs: () => void
}) {
  const isRunning = container.State === 'running'
  const stateColor = isRunning ? '#10B981' : container.State === 'exited' ? 'var(--nox-text-3)' : '#F59E0B'

  return (
    <tr
      className="group"
      style={last ? {} : { borderBottom: '1px solid var(--nox-border)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: stateColor }} />
          <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[12.5px]" style={{ color: 'var(--nox-text)' }}>
            {container.Names}
          </span>
        </div>
      </td>
      <td className="px-4 py-2.5 font-mono text-[11px] max-w-[180px] truncate" style={{ color: 'var(--nox-text-2)' }}>
        {container.Image}
      </td>
      <td className="px-4 py-2.5 font-['Inter'] text-[11.5px]" style={{ color: stateColor }}>
        {container.Status}
      </td>
      <td className="px-4 py-2.5 font-mono text-[11.5px] tabular-nums" style={{ color: 'var(--nox-text-2)' }}>
        {isRunning ? stat?.CPUPerc ?? '—' : ''}
      </td>
      <td className="px-4 py-2.5 font-mono text-[11.5px] tabular-nums" style={{ color: 'var(--nox-text-2)' }}>
        {isRunning ? stat?.MemUsage?.split(' / ')[0] ?? '—' : ''}
      </td>
      <td className="px-4 py-2.5 font-mono text-[10.5px] max-w-[160px] truncate" style={{ color: 'var(--nox-text-2)' }}>
        {container.Ports}
      </td>
      <td className="px-4 py-2.5 text-right whitespace-nowrap">
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin inline" style={{ color: 'var(--nox-text-2)' }} />
        ) : (
          <div className="inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <RowAction title="Logs" onClick={onLogs}><ScrollText className="w-3.5 h-3.5" /></RowAction>
            {isRunning ? (
              <>
                <RowAction title="Restart" onClick={() => onAction('restart')}><RotateCcw className="w-3.5 h-3.5" /></RowAction>
                <RowAction title="Stop" onClick={() => onAction('stop')}><Square className="w-3.5 h-3.5" /></RowAction>
              </>
            ) : (
              <RowAction title="Start" onClick={() => onAction('start')}><Play className="w-3.5 h-3.5" /></RowAction>
            )}
            <RowAction title="Remove" danger onClick={() => onAction('rm')}><Trash2 className="w-3.5 h-3.5" /></RowAction>
          </div>
        )}
      </td>
    </tr>
  )
}

function RowAction({ title, onClick, danger, children }: {
  title: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="p-1 rounded transition-colors"
      style={{ color: 'var(--nox-text-2)' }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'var(--nox-hover)'
        e.currentTarget.style.color = danger ? '#EF4444' : '#3B5CCC'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--nox-text-2)'
      }}
    >
      {children}
    </button>
  )
}
