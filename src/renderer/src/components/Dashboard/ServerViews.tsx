import { Box, Database, HardDrive, Plug, Server } from 'lucide-react'
import { Session, ServerMetrics } from '../../store'
import { formatBytesLong, formatUptime, sparkline } from '../../lib/format'
import { metricColor } from '../../lib/colors'

// Server presentations share the Dashboard's tab and metrics-derived status.

export function reachabilityInfo(isConnected: boolean): { label: string; color: string } {
  if (isConnected) return { label: 'Connected', color: '#10B981' }
  return { label: 'Disconnected', color: 'var(--nox-text-3)' }
}

interface ServerViewProps {
  session: Session
  metrics?: ServerMetrics
  isConnected: boolean
  onConnect: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

interface HealthCardProps extends ServerViewProps {
  isDropTarget: boolean
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  onDragEnd: () => void
}

export function HealthCard({
  session,
  metrics,
  isConnected,
  isDropTarget,
  onConnect,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: HealthCardProps) {
  const color = session.color ?? '#3B5CCC'
  const cpu = metrics?.cpu ?? 0
  const memUsed = metrics?.memUsed ?? 0
  const memTotal = metrics?.memTotal ?? 1
  const memPct = Math.round((memUsed / memTotal) * 100)
  const hasLiveData = isConnected && !!metrics?.available
  const reachability = reachabilityInfo(isConnected)

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={e => { e.preventDefault(); onDragOver() }}
      onDrop={e => { e.preventDefault(); onDrop() }}
      onDragEnd={onDragEnd}
      onClick={onConnect}
      onContextMenu={onContextMenu}
      className="rounded-lg overflow-hidden cursor-pointer transition-all hover:shadow-md min-h-[118px]"
      style={{
        background: 'var(--nox-shell)',
        border: isDropTarget ? `2px dashed ${color}` : '1px solid var(--nox-border)',
      }}
    >
      <div className="flex">
        <div className="w-[3px] flex-shrink-0" style={{ background: color }} />
        <div className="flex-1 min-w-0 p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: color + '18' }}>
                <ConnectionTypeIcon type={session.type} />
              </div>
              <div className="min-w-0">
                <div className="font-['Plus_Jakarta_Sans'] font-semibold text-[14px] truncate" style={{ color: 'var(--nox-text)' }}>
                  {session.label || session.host}
                </div>
                <div className="flex items-center gap-1.5 mt-1 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: reachability.color }} />
                  <span className="font-['Inter'] text-[11px] whitespace-nowrap flex-shrink-0" style={{ color: 'var(--nox-text-2)' }}>
                    {reachability.label}
                  </span>
                  <span className="font-['Inter'] text-[11px] flex-shrink-0" style={{ color: 'var(--nox-text-3)' }}>·</span>
                  <span className="font-['Inter'] text-[11px] truncate" style={{ color: 'var(--nox-text-3)' }}>{session.host}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {!isConnected && (
                <button
                  onClick={e => { e.stopPropagation(); onConnect() }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md font-['Inter'] text-[10.5px] font-medium transition-colors flex-shrink-0"
                  style={{ background: color + '15', color, border: `1px solid ${color}30` }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = color + '25' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = color + '15' }}
                >
                  <Plug className="w-2.5 h-2.5" />
                  Connect
                </button>
              )}
            </div>
          </div>

          {hasLiveData ? (
            <div className="space-y-2">
              <MetricBar label="CPU" value={cpu} color={color}
                sublabel={`${sparkline((metrics?.cpuHistory ?? []).slice(-16))}  ${cpu}%`} />
              <MetricBar label="MEM" value={memPct} color={color}
                sublabel={`${formatBytesLong(memUsed)} / ${formatBytesLong(memTotal)}`} />
              {!!metrics?.diskTotal && (
                <MetricBar
                  label="DISK"
                  value={Math.round(((metrics.diskUsed ?? 0) / metrics.diskTotal) * 100)}
                  color={color}
                  sublabel={`${formatBytesLong(metrics.diskUsed ?? 0)} / ${formatBytesLong(metrics.diskTotal)}`}
                />
              )}
              {(metrics?.load1 !== undefined || metrics?.uptimeSec) && (
                <div className="flex items-center gap-3 pt-0.5">
                  {metrics?.load1 !== undefined && (
                    <span className="font-['JetBrains_Mono'] text-[10px]" style={{ color: 'var(--nox-text-3)' }}>
                      load {metrics.load1.toFixed(2)}
                    </span>
                  )}
                  {!!metrics?.uptimeSec && (
                    <span className="font-['JetBrains_Mono'] text-[10px]" style={{ color: 'var(--nox-text-3)' }}>
                      up {formatUptime(metrics.uptimeSec)}
                    </span>
                  )}
                </div>
              )}
            </div>
          ) : isConnected ? (
            <div className="space-y-2 animate-pulse">
              <MetricBar label="CPU" value={0} color={color} sublabel="..." />
              <MetricBar label="MEM" value={0} color={color} sublabel="waiting for metrics" />
            </div>
          ) : (
            <OfflineStatus />
          )}
        </div>
      </div>
    </div>
  )
}

export function CompactServerCard({ session, metrics, isConnected, onConnect, onContextMenu }: ServerViewProps) {
  const color = session.color ?? '#3B5CCC'
  const reach = reachabilityInfo(isConnected)
  const live = isConnected && metrics?.available
  const memPct = live && metrics!.memTotal > 0 ? Math.round((metrics!.memUsed / metrics!.memTotal) * 100) : 0

  return (
    <button
      onClick={onConnect}
      onContextMenu={onContextMenu}
      className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-left transition-colors min-w-0"
      style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--nox-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--nox-shell)' }}
    >
      <span className="w-1 self-stretch rounded-full flex-shrink-0" style={{ background: color }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: reach.color }} />
          <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[12.5px] truncate" style={{ color: 'var(--nox-text)' }}>
            {session.label || session.host}
          </span>
        </div>
        <span className="font-mono text-[10.5px] block truncate mt-0.5" style={{ color: 'var(--nox-text-3)' }}>
          {live
            ? `cpu ${metrics!.cpu}% · mem ${memPct}%`
            : isConnected
              ? 'waiting for metrics'
              : reach.label}
        </span>
      </div>
    </button>
  )
}

export function ServerListRow({ session, metrics, isConnected, onConnect, onContextMenu }: ServerViewProps) {
  const color = session.color ?? '#3B5CCC'
  const reach = reachabilityInfo(isConnected)
  const live = isConnected && metrics?.available
  const memPct = live && metrics!.memTotal > 0 ? Math.round((metrics!.memUsed / metrics!.memTotal) * 100) : null
  const diskPct = live && metrics?.diskTotal ? Math.round(((metrics.diskUsed ?? 0) / metrics.diskTotal) * 100) : null

  return (
    <div
      onClick={onConnect}
      onContextMenu={onContextMenu}
      className="group flex items-center gap-3 px-3 cursor-pointer transition-colors"
      style={{ height: 38 }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--nox-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: reach.color }} />
      <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: color }} />
      <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[12.5px] truncate" style={{ color: 'var(--nox-text)', width: 170 }}>
        {session.label || session.host}
      </span>
      <span className="font-mono text-[11px] truncate flex-1 min-w-0" style={{ color: 'var(--nox-text-3)' }}>
        {session.username ? `${session.username}@` : ''}{session.host}
      </span>

      <span className="font-['Inter'] text-[11px] text-right flex-shrink-0 w-24" style={{ color: reach.color }}>
        {reach.label}
      </span>

      <MetricCell label="cpu" value={live ? `${metrics!.cpu}%` : null} pct={live ? metrics!.cpu : null} />
      <MetricCell label="mem" value={live ? formatBytesLong(metrics!.memUsed) : null} pct={memPct} />
      <MetricCell label="disk" value={diskPct !== null ? `${diskPct}%` : null} pct={diskPct} />
      <span className="font-mono text-[10.5px] text-right flex-shrink-0 w-16" style={{ color: 'var(--nox-text-3)' }}>
        {live && metrics?.uptimeSec ? `up ${formatUptime(metrics.uptimeSec)}` : ''}
      </span>

      <div className="flex items-center gap-1 flex-shrink-0 w-8 justify-end">
        {!isConnected && (
          <button
            title="Connect"
            onClick={e => { e.stopPropagation(); onConnect() }}
            className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color }}
          >
            <Plug className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  )
}

function OfflineStatus() {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md px-2.5"
      style={{ background: 'var(--nox-bg)', border: '1px dashed var(--nox-border)', height: 46 }}
    >
      <p className="font-['Inter'] text-[10.5px] truncate" style={{ color: 'var(--nox-text-3)' }}>
        Connect to start live metrics
      </p>
    </div>
  )
}

function MetricCell({ label, value, pct }: { label: string; value: string | null; pct: number | null }) {
  return (
    <span className="font-mono text-[11px] text-right tabular-nums flex-shrink-0 w-20">
      {value !== null ? (
        <>
          <span style={{ color: 'var(--nox-text-3)' }}>{label} </span>
          <span style={{ color: pct !== null ? metricColor(pct) : 'var(--nox-text-2)' }}>{value}</span>
        </>
      ) : (
        <span style={{ color: 'var(--nox-text-3)' }}>—</span>
      )}
    </span>
  )
}

function MetricBar({ label, value, color, sublabel }: { label: string; value: number; color: string; sublabel?: string }) {
  const barColor = value >= 80 ? '#EF4444' : value >= 60 ? '#F59E0B' : color
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-['Inter'] text-[9.5px] uppercase tracking-wider font-semibold" style={{ color: 'var(--nox-text-3)', letterSpacing: '0.08em' }}>
          {label}
        </span>
        <span className="font-['JetBrains_Mono'] text-[10px] font-medium" style={{ color: barColor }}>
          {sublabel ?? `${value}%`}
        </span>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--nox-border)' }}>
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.min(value, 100)}%`, background: barColor }}
        />
      </div>
    </div>
  )
}

function ConnectionTypeIcon({ type }: { type?: string }) {
  const s = { className: 'w-3.5 h-3.5 flex-shrink-0' }
  switch (type) {
    case 'database': return <Database {...s} style={{ color: '#3B5CCC' }} />
    case 'redis': return <HardDrive {...s} style={{ color: '#EF4444' }} />
    case 'kubernetes': return <Box {...s} style={{ color: '#326CE5' }} />
    case 'sftp': return <Server {...s} style={{ color: '#8B5CF6' }} />
    default: return <Server {...s} style={{ color: '#10B981' }} />
  }
}
