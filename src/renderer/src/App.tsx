import { useEffect } from 'react'
import { useAppStore } from './store'
import Sidebar from './components/Sidebar/Sidebar'
import TopBar from './components/TopBar/TopBar'
import TabBar from './components/TabBar/TabBar'
import StatusBar from './components/StatusBar/StatusBar'
import MainContent from './components/MainContent'
import AddConnectionModal from './components/ConnectionManager/AddConnectionModal'
import CommandPalette from './components/CommandPalette/CommandPalette'
import NotificationHost from './components/Notifications/NotificationHost'
import UnlockScreen from './components/UnlockScreen'

export const SIDEBAR_W = 220

export default function App() {
  const setSessions = useAppStore(s => s.setSessions)
  const tabs = useAppStore(s => s.tabs)
  const activeTabId = useAppStore(s => s.activeTabId)
  const setActiveTab = useAppStore(s => s.setActiveTab)
  const showAddSession = useAppStore(s => s.showAddSession)
  const setShowAddSession = useAppStore(s => s.setShowAddSession)
  const showAddConnection = useAppStore(s => s.showAddConnection)
  const setShowAddConnection = useAppStore(s => s.setShowAddConnection)
  const showCommandPalette = useAppStore(s => s.showCommandPalette)
  const setShowCommandPalette = useAppStore(s => s.setShowCommandPalette)
  const openDashboardTab = useAppStore(s => s.openDashboardTab)
  const isLocked = useAppStore(s => s.isLocked)

  const sidebarExpanded = useAppStore(s => s.sidebarExpanded)
  const setLocked = useAppStore(s => s.setLocked)
  const setSidebarExpanded = useAppStore(s => s.setSidebarExpanded)

  // Load sessions on startup (no credentials — those stay in keychain)
  useEffect(() => {
    window.api.sessions.list().then(setSessions)
    window.api.settings.get().then((cfg: any) => {
      if (cfg.sidebarDefault === 'collapsed') setSidebarExpanded(false)
      if (cfg.isDarkMode) {
        document.documentElement.classList.add('dark')
        useAppStore.setState({ isDarkMode: true })
      }
      if (cfg.groupColors && typeof cfg.groupColors === 'object') {
        useAppStore.setState({ groupColors: cfg.groupColors })
      }
      if (cfg.sectionOrder && typeof cfg.sectionOrder === 'object') {
        useAppStore.setState({ sectionOrder: cfg.sectionOrder })
      }
      if (Array.isArray(cfg.projectGroupOrder)) {
        useAppStore.setState({ projectGroupOrder: cfg.projectGroupOrder })
      }
    })
  }, [])

  // Listen for auto-lock from main process
  useEffect(() => {
    return window.api.auth.onLocked(() => setLocked(true))
  }, [])

  // Open connectOnStart tabs after unlock
  useEffect(() => {
    if (!isLocked) {
      const sessions = useAppStore.getState().sessions
      sessions.filter(s => s.connectOnStart).forEach(s => {
        useAppStore.getState().openTab(s)
      })
    }
  }, [isLocked])

  // Open dashboard tab on first load if no tabs
  useEffect(() => {
    if (tabs.length === 0) openDashboardTab()
  }, [])

  // Ctrl+Tab intercepted in main process via before-input-event (macOS grabs it otherwise)
  useEffect(() => {
    return (window.api as any).tabs.onCycle((dir: 'next' | 'prev') => {
      if (useAppStore.getState().isLocked) return
      const { tabs, activeTabId: aid, setActiveTab: sat } = useAppStore.getState()
      const t = tabs.filter(x => !x.paneOf)
      if (t.length <= 1) return
      const idx = t.findIndex(x => x.id === aid)
      const next = dir === 'next'
        ? t[(idx + 1) % t.length]
        : t[(idx - 1 + t.length) % t.length]
      if (next) sat(next.id)
    })
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isLocked) return
      const meta = e.metaKey || e.ctrlKey
      const visibleTabs = tabs.filter(t => !t.paneOf)
      // Cmd+Shift+] / Cmd+Shift+[ — use e.code because Shift changes ] to } in e.key
      if (meta && e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        e.preventDefault()
        if (visibleTabs.length <= 1) return
        const idx = visibleTabs.findIndex(t => t.id === activeTabId)
        const next = e.code === 'BracketRight'
          ? visibleTabs[(idx + 1) % visibleTabs.length]
          : visibleTabs[(idx - 1 + visibleTabs.length) % visibleTabs.length]
        if (next) setActiveTab(next.id)
        return
      }
      if (meta && e.key === 'k') { e.preventDefault(); setShowCommandPalette(!showCommandPalette); return }
      // ⌘N (new connection), ⌘T (open connection), ⌘` (local terminal) and ⌘W
      // (close tab) are owned by the application menu — see src/main/menu.ts.
      if (meta && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const tab = visibleTabs[parseInt(e.key) - 1]
        if (tab) setActiveTab(tab.id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [tabs, activeTabId, showCommandPalette, isLocked])

  // Application-menu commands (File menu). Their accelerators (⌘N/⌘T/⌘`/⌘W)
  // are handled by the native menu so macOS can't swallow them; here we route
  // each forwarded command to the matching action. State read via getState so
  // the listeners never need re-subscribing.
  useEffect(() => {
    const offs = [
      window.api.menu.on('new-connection', () => {
        if (!useAppStore.getState().isLocked) setShowAddConnection(true)
      }),
      window.api.menu.on('open-connection', () => {
        if (!useAppStore.getState().isLocked) setShowCommandPalette(true)
      }),
      window.api.menu.on('new-local-terminal', () => {
        if (!useAppStore.getState().isLocked) useAppStore.getState().openLocalTerminalTab()
      }),
      window.api.menu.on('close-tab', () => {
        const s = useAppStore.getState()
        if (!s.isLocked && s.activeTabId) s.closeTab(s.activeTabId)
      }),
    ]
    return () => offs.forEach(off => off())
  }, [])

  // Mirror auto-updater status into the store so the top-bar pill and Settings
  // both react to it. The startup check is lightweight (manifest only) — nothing
  // downloads until the user clicks the pill / "Download" in Settings.
  useEffect(() => {
    return window.api.updater.onStatus((status) => {
      useAppStore.getState().setUpdateStatus(status)
    })
  }, [])

  return (
    <div className="flex flex-col h-full overflow-hidden select-none" style={{ background: 'var(--nox-bg)' }}>
      {isLocked && <UnlockScreen />}

      {/* Main app hidden until unlocked — TerminalView won't try to connect before auth */}
      <div className={isLocked ? 'hidden' : 'contents'}>
        <TopBar />
        <TabBar />
        <div className="flex flex-1 w-full min-w-0 min-h-0 overflow-hidden">
          {sidebarExpanded && <Sidebar />}
          <div className="flex-1 w-full min-w-0 min-h-0 overflow-hidden">
            <MainContent />
          </div>
        </div>
        <StatusBar />
        <NotificationHost />
      </div>

      {(showAddConnection || showAddSession) && (
        <AddConnectionModal onClose={() => { setShowAddConnection(false); setShowAddSession(false) }} />
      )}
      {showCommandPalette && <CommandPalette onClose={() => setShowCommandPalette(false)} />}
    </div>
  )
}
