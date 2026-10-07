import { History } from 'lucide-react'
import { useAppStore, type Session } from '../../store'
import { connectionColor } from '../../lib/colors'
import { relativeTime } from '../../lib/format'

const SHOWN = 6

// Saved connections opened most recently, one click from reopening.
export default function RecentConnections() {
  const recents = useAppStore((s) => s.recentConnections)
  const sessions = useAppStore((s) => s.sessions)
  const openTab = useAppStore((s) => s.openTab)

  // Recents can outlive deleted connections; only show ones that still exist.
  const items = recents
    .map((r) => ({ at: r.at, session: sessions.find((s) => s.id === r.id) }))
    .filter((r): r is { at: number; session: Session } => r.session !== undefined)
    .slice(0, SHOWN)
  if (items.length === 0) return null

  return (
    <section aria-label="Recent connections">
      <h2 className="flex items-center gap-1.5 font-['Inter'] text-[11px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--nox-text-2)' }}>
        <History className="w-3.5 h-3.5" /> Recent
      </h2>
      <div className="flex flex-wrap gap-2">
        {items.map(({ at, session }) => (
          <button
            key={session.id}
            type="button"
            onClick={() => openTab(session)}
            className="flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-md text-left transition-colors hover:bg-[var(--nox-hover)]"
            style={{ border: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}
          >
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: session.color ?? connectionColor(session.type ?? 'ssh') }} />
            <span className="min-w-0">
              <span className="block font-['Inter'] text-[12px] font-medium truncate max-w-[180px]" style={{ color: 'var(--nox-text)' }}>
                {session.label || session.host}
              </span>
              <span className="block font-['Inter'] text-[10.5px]" style={{ color: 'var(--nox-text-2)' }}>
                {relativeTime(at)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
