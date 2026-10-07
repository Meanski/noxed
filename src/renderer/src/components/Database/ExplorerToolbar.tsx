import { Activity, Eye, EyeOff, Loader2, Pin, Play, RotateCcw } from 'lucide-react'
import type { ActivePanel } from './types'

export default function ExplorerToolbar({ running, explainRunning, hasSql, activePanel, watchActive, watchSec, watchCountdown, onRun, onExplain, onStartWatch, onStopWatch, onWatchSecChange, onSave, onClear }: Readonly<{
  running: boolean; explainRunning: boolean; hasSql: boolean; activePanel: ActivePanel
  watchActive: boolean; watchSec: number; watchCountdown: number
  onRun: () => void; onExplain: () => void; onStartWatch: () => void; onStopWatch: () => void
  onWatchSecChange: (sec: number) => void; onSave: () => void; onClear: () => void
}>) {
  return (
    <div className="flex items-center gap-2 px-3 flex-shrink-0" style={{ height: 36, borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
      <button onClick={onRun} disabled={running || !hasSql} className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium disabled:opacity-30" style={{ background: running ? 'var(--nox-active)' : '#3B5CCC', color: running ? 'var(--nox-text-2)' : '#fff' }}>
        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}{running ? 'Running…' : 'Run'}
      </button>
      <button onClick={onExplain} disabled={running || explainRunning || !hasSql} className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium disabled:opacity-30" style={{ color: activePanel === 'explain' ? '#F59E0B' : 'var(--nox-text-3)', background: activePanel === 'explain' ? 'rgba(245,158,11,0.08)' : undefined }} title="Visualize query execution plan">
        <Activity className="w-3 h-3" /> Explain
      </button>
      <div className="w-px h-4" style={{ background: 'var(--nox-border)' }} />
      <WatchControls watchActive={watchActive} watchSec={watchSec} watchCountdown={watchCountdown} running={running} hasSql={hasSql} onStart={onStartWatch} onStop={onStopWatch} onSecChange={onWatchSecChange} />
      <kbd className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ color: 'var(--nox-text-3)', background: 'var(--nox-active)' }}>{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter</kbd>
      <div className="w-px h-4" style={{ background: 'var(--nox-border)' }} />
      <button onClick={onSave} disabled={!hasSql} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] disabled:opacity-30" style={{ color: 'var(--nox-text-3)' }} title="Save query"><Pin className="w-3 h-3" /> Save</button>
      <div className="flex-1" />
      <button onClick={onClear} className="flex items-center gap-1 px-2 py-1 rounded text-[10px]" style={{ color: 'var(--nox-text-3)' }}><RotateCcw className="w-3 h-3" /> Clear</button>
    </div>
  )
}

function WatchControls({ watchActive, watchSec, watchCountdown, running, hasSql, onStart, onStop, onSecChange }: Readonly<{
  watchActive: boolean; watchSec: number; watchCountdown: number; running: boolean; hasSql: boolean
  onStart: () => void; onStop: () => void; onSecChange: (sec: number) => void
}>) {
  return (
    <div className="flex items-center gap-1">
      <button onClick={watchActive ? onStop : onStart} disabled={!watchActive && (running || !hasSql)} className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium disabled:opacity-30" style={{ color: watchActive ? '#10B981' : 'var(--nox-text-3)', background: watchActive ? 'rgba(16,185,129,0.08)' : undefined }} title={watchActive ? 'Stop watching' : 'Auto-refresh query results'}>
        {watchActive ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />} {watchActive ? 'Stop' : 'Watch'}
      </button>
      {watchActive && <span className="text-[9px] font-mono tabular-nums px-1.5 py-0.5 rounded-full animate-pulse" style={{ color: '#10B981', background: 'rgba(16,185,129,0.08)' }}>{watchCountdown}s</span>}
      {!watchActive && (
        <select value={watchSec} onChange={e => onSecChange(Number(e.target.value))} className="bg-transparent text-[10px] font-mono focus:outline-none cursor-pointer" style={{ color: 'var(--nox-text-3)' }}>
          <option value={2}>2s</option>
          <option value={5}>5s</option>
          <option value={10}>10s</option>
          <option value={30}>30s</option>
        </select>
      )}
    </div>
  )
}
