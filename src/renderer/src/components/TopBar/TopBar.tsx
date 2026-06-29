import { Moon, Sun, Plus, Search, Download, RefreshCw, RotateCw } from 'lucide-react'
import { useAppStore } from '../../store'

const nodrag: React.CSSProperties = { WebkitAppRegion: 'no-drag' } as any

// macOS uses a hidden-inset title bar with traffic lights overlaid top-left,
// so the logo needs clearance for them. Other platforms have a normal title
// bar above this row and need no such offset.
const isMac = window.api?.platform === 'darwin'

export default function TopBar() {
  const { setShowCommandPalette, setShowAddConnection, isDarkMode, toggleDarkMode, openDashboardTab } = useAppStore()

  return (
    <div
      className="flex items-center flex-shrink-0 drag"
      style={{
        height: 44,
        background: 'var(--nox-shell)',
        borderBottom: '1px solid var(--nox-border)',
      }}
    >
      {/* Traffic light clearance + logo */}
      <div
        className="flex items-center flex-shrink-0"
        style={{ width: 220, paddingLeft: isMac ? 80 : 16, paddingRight: 16, borderRight: '1px solid var(--nox-border)' }}
      >
        <button
          onClick={openDashboardTab}
          className="flex items-center gap-2"
          style={nodrag}
        >
          <svg width="22" height="22" viewBox="0 0 256 256" fill="none">
            <defs>
              <clipPath id="nx-topbar-squircle"><rect width="256" height="256" rx="58" /></clipPath>
            </defs>
            <g clipPath="url(#nx-topbar-squircle)">
              <path d="M0 0 L148 0 Q138 64 128 128 Q64 118 0 108 Z" fill="#A78BFA" />
              <path d="M148 0 L256 0 L256 148 Q192 138 128 128 Q138 64 148 0 Z" fill="#6D28D9" />
              <path d="M256 148 L256 256 L108 256 Q118 192 128 128 Q192 138 256 148 Z" fill="#312A7D" />
              <path d="M108 256 L0 256 L0 108 Q64 118 128 128 Q118 192 108 256 Z" fill="#4C6EF5" />
            </g>
            <path
              d="M128 44 C136 100 156 120 212 128 C156 136 136 156 128 212 C120 156 100 136 44 128 C100 120 120 100 128 44 Z"
              fill="#FFFFFF"
              transform="rotate(14 128 128)"
            />
          </svg>
          <span
            className="font-['Plus_Jakarta_Sans'] font-bold text-[15px]"
            style={{ color: 'var(--nox-text)' }}
          >
            noxed
          </span>
        </button>
      </div>

      {/* Search bar – container is draggable, button inside is not */}
      <div className="flex-1 flex items-center px-4">
        <button
          onClick={() => setShowCommandPalette(true)}
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 flex-1 max-w-md transition-colors"
          style={{
            ...nodrag,
            background: 'var(--nox-bg)',
            border: '1px solid var(--nox-border)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = '#3B5CCC'
            e.currentTarget.style.background = 'var(--nox-surface)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--nox-border)'
            e.currentTarget.style.background = 'var(--nox-bg)'
          }}
        >
          <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
          <span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-3)' }}>
            Search connections… ⌘K
          </span>
        </button>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pr-4 flex-shrink-0">
        <UpdatePill />

        <button
          onClick={() => setShowAddConnection(true)}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 font-['Inter'] text-[12px] font-medium text-white transition-colors"
          style={{ ...nodrag, background: '#3B5CCC' }}
          onMouseEnter={e => { e.currentTarget.style.background = '#2A4299' }}
          onMouseLeave={e => { e.currentTarget.style.background = '#3B5CCC' }}
        >
          <Plus className="w-3.5 h-3.5" />
          New Connection
        </button>

        {/* Dark mode toggle */}
        <button
          onClick={toggleDarkMode}
          title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          className="p-1.5 rounded-md transition-colors"
          style={{
            ...nodrag,
            background: 'transparent',
            color: 'var(--nox-text-2)',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          {isDarkMode
            ? <Sun className="w-4 h-4" />
            : <Moon className="w-4 h-4" />
          }
        </button>
      </div>
    </div>
  )
}

/* ── Update pill ─────────────────────────────────────────────────────────────
   Persistent indicator driven by the startup (and manual) update check. The
   check only reads the manifest; clicking "Update available" is what starts the
   download. Stays put until acted on, so it can't be missed like a toast. */
function UpdatePill() {
  const status = useAppStore(s => s.updateStatus)
  if (!status) return null

  if (status.state === 'available') {
    return (
      <button
        onClick={() => window.api.updater.download()}
        title={`Version ${status.version} is available — click to download`}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-['Inter'] text-[12px] font-medium text-white transition-colors"
        style={{ ...nodrag, background: '#10B981' }}
        onMouseEnter={e => { e.currentTarget.style.background = '#059669' }}
        onMouseLeave={e => { e.currentTarget.style.background = '#10B981' }}
      >
        <Download className="w-3.5 h-3.5" />
        Update available
      </button>
    )
  }

  if (status.state === 'downloading') {
    return (
      <div
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-['Inter'] text-[12px]"
        style={{ ...nodrag, color: 'var(--nox-text-2)', border: '1px solid var(--nox-border)' }}
      >
        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
        Updating… {status.percent}%
      </div>
    )
  }

  if (status.state === 'downloaded') {
    return (
      <button
        onClick={() => window.api.updater.quitAndInstall()}
        title={`Version ${status.version} downloaded — restart to install`}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-['Inter'] text-[12px] font-medium text-white transition-colors"
        style={{ ...nodrag, background: '#3B5CCC' }}
        onMouseEnter={e => { e.currentTarget.style.background = '#2A4299' }}
        onMouseLeave={e => { e.currentTarget.style.background = '#3B5CCC' }}
      >
        <RotateCw className="w-3.5 h-3.5" />
        Restart to update
      </button>
    )
  }

  return null
}
