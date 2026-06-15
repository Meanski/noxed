import { create } from 'zustand'

// ── Connection types ──────────────────────────────────────────────────────────

export type ConnectionType = 'ssh' | 'sftp' | 'database' | 'kubernetes' | 'redis'

export interface Connection {
  id: string
  type: ConnectionType
  name: string
  host: string
  port: number
  color: string
  tags: string[]
  isFavorite: boolean
  group?: string
  createdAt: number
  // SSH / SFTP auth
  username?: string
  authType?: 'password' | 'key'
  password?: string
  keyPath?: string
  // Database specific
  dbType?: 'postgresql' | 'mysql' | 'mariadb' | 'sqlite' | 'mongodb'
  databaseName?: string
  sslMode?: 'disable' | 'require' | 'verify-ca' | 'verify-full'
  // Polling (SSH)
  pollingEnabled?: boolean
  pollingIntervalSeconds?: number
  // SFTP
  sftpMode?: 'standalone' | 'linkedToSSH'
  linkedSSHId?: string
}

// Legacy compat: keep Session for the SSH IPC layer
export interface Session {
  id: string
  label: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  password?: string
  keyPath?: string
  group?: string
  createdAt: number
  // Extended fields
  type?: ConnectionType
  color?: string
  tags?: string[]
  isFavorite?: boolean
  pollingEnabled?: boolean
  pollingIntervalSeconds?: number
  dbType?: string
  databaseName?: string
  sslMode?: string
  // Redis-specific
  redisDb?: number
  // Auto-connect on app start
  connectOnStart?: boolean
  // Kubernetes-specific
  contextName?: string
  kubeconfigPath?: string
  // Connect through another saved SSH connection (ProxyJump)
  jumpHostId?: string
  // Set by main process — indicates a credential exists in the OS keychain
  hasPassword?: boolean
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export type TabView =
  | 'terminal' | 'sftp' | 'k8s' | 'database' | 'redis' | 'editor' | 'docker' | 'local-term'
  | 'dashboard' | 'connections' | 'settings' | 'tunnels' | 'runner'
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'

export interface EditorFile {
  source: 'remote' | 'local'
  path: string
}

export interface Tab {
  id: string
  sessionId?: string
  k8sContext?: string
  kubeconfigPath?: string
  label: string
  view: TabView
  streamId?: string
  status: ConnectionStatus
  errorMessage?: string
  connectedAt?: number
  filesOpen: boolean
  isSystem?: boolean
  editorFile?: EditorFile
  isDirty?: boolean
  // Set when this terminal renders as a split pane inside another tab
  paneOf?: string
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface ServerMetrics {
  cpu: number
  memUsed: number
  memTotal: number
  diskUsed?: number
  diskTotal?: number
  load1?: number
  uptimeSec?: number
  available: boolean
  lastUpdated: number
  cpuHistory?: number[]
}

// ── Notifications ─────────────────────────────────────────────────────────────

export interface AppNotification {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  message: string
  createdAt: number
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface AppState {
  sessions: Session[]
  tabs: Tab[]
  activeTabId: string | null
  showAddSession: boolean
  showCommandPalette: boolean
  showAddConnection: boolean
  editingConnectionId: string | null
  notifications: AppNotification[]
  serverMetrics: Record<string, ServerMetrics>
  sidebarView: 'type' | 'project'
  sidebarExpanded: boolean
  isDarkMode: boolean
  isLocked: boolean
  sectionOrder: Record<string, string[]>
  projectGroupOrder: string[]
  broadcastEnabled: boolean
  focusedPaneId: string | null
  groupColors: Record<string, string>
  // Pre-selected project group for the next "New Connection" modal
  pendingConnectionGroup: string | null

  setSessions: (sessions: Session[]) => void
  addSession: (session: Session) => void
  updateSession: (id: string, data: Partial<Session>) => void
  removeSession: (id: string) => void

  openTab: (session: Session) => void
  openEditorTab: (opts: { path: string; source: 'remote' | 'local'; session?: Session; streamId?: string }) => void
  openK8sTab: (context: string) => void
  openDockerTab: (session: Session) => void
  openDashboardTab: () => void
  openConnectionsTab: () => void
  openSettingsTab: () => void
  openTunnelsTab: () => void
  openRunnerTab: () => void
  openLocalTerminalTab: () => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  splitTab: (parentTabId: string, session: Session) => void
  setFocusedPane: (tabId: string | null) => void
  updateTab: (tabId: string, data: Partial<Tab>) => void
  toggleFilesDrawer: (tabId: string) => void
  setShowAddSession: (show: boolean) => void
  setShowCommandPalette: (show: boolean) => void
  setShowAddConnection: (show: boolean) => void
  setEditingConnectionId: (id: string | null) => void
  openRedisTab: (session: Session) => void
  setLocked: (v: boolean) => void
  setSidebarView: (view: 'type' | 'project') => void
  setSidebarExpanded: (v: boolean) => void
  setSectionOrder: (section: string, order: string[]) => void
  setProjectGroupOrder: (order: string[]) => void
  setGroupColor: (group: string, color: string | null) => void
  setPendingConnectionGroup: (group: string | null) => void
  setBroadcastEnabled: (v: boolean) => void
  setServerMetrics: (sessionId: string, metrics: ServerMetrics) => void
  addNotification: (n: Omit<AppNotification, 'id' | 'createdAt'>) => void
  dismissNotification: (id: string) => void
  toggleDarkMode: () => void
}

let tabCounter = 0
let notifCounter = 0

// Fire-and-forget settings write, guarded so the store works in tests (no window)
function persistSetting(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  ;(window as any).api?.settings?.set(key, value)
}

type SetState = (fn: (s: AppState) => Partial<AppState>) => void

// System views (dashboard, settings, …) only ever get one tab each.
function openSingletonTab(set: SetState, view: TabView, label: string): void {
  set((s) => {
    const existing = s.tabs.find((t) => t.view === view)
    if (existing) return { activeTabId: existing.id, focusedPaneId: null }
    const tab: Tab = {
      id: `tab-${++tabCounter}`,
      label,
      view,
      status: 'connected',
      filesOpen: false,
    }
    return { tabs: [...s.tabs, tab], activeTabId: tab.id, focusedPaneId: null }
  })
}

export const useAppStore = create<AppState>((set) => ({
  sessions: [],
  tabs: [],
  activeTabId: null,
  showAddSession: false,
  showCommandPalette: false,
  showAddConnection: false,
  editingConnectionId: null,
  notifications: [],
  serverMetrics: {},
  sidebarView: 'type',
  sidebarExpanded: true,
  isDarkMode: false,
  isLocked: true,
  sectionOrder: {},
  projectGroupOrder: [],
  broadcastEnabled: false,
  focusedPaneId: null,
  groupColors: {},
  pendingConnectionGroup: null,

  setSessions: (sessions) => set({ sessions }),
  addSession: (session) => set((s) => ({ sessions: [...s.sessions, session] })),
  updateSession: (id, data) =>
    set((s) => ({ sessions: s.sessions.map((sess) => (sess.id === id ? { ...sess, ...data } : sess)) })),
  removeSession: (id) => set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) })),

  openTab: (session) =>
    set((s) => {
      const existing = s.tabs.find((t) => t.sessionId === session.id && t.status !== 'error' && !t.paneOf)
      if (existing) return { activeTabId: existing.id, focusedPaneId: null }
      const isK8s = session.type === 'kubernetes'
      const isSftp = session.type === 'sftp'
      const isDb = session.type === 'database'
      const view: TabView = isK8s ? 'k8s' : isSftp ? 'sftp' : isDb ? 'database' : 'terminal'
      const tab: Tab = {
        id: `tab-${++tabCounter}`,
        sessionId: session.id,
        label: session.label || session.host,
        view,
        status: isK8s ? 'connected' : 'idle',
        filesOpen: false,
        k8sContext: isK8s ? session.contextName : undefined,
        kubeconfigPath: isK8s ? session.kubeconfigPath : undefined,
      }
      return { tabs: [...s.tabs, tab], activeTabId: tab.id, focusedPaneId: null }
    }),

  openEditorTab: ({ path, source, session, streamId }) =>
    set((s) => {
      const existing = s.tabs.find(t =>
        t.view === 'editor' &&
        t.editorFile?.path === path &&
        t.editorFile?.source === source &&
        t.sessionId === session?.id
      )
      if (existing) return { activeTabId: existing.id, focusedPaneId: null }
      const tab: Tab = {
        id: `tab-${++tabCounter}`,
        sessionId: session?.id,
        streamId,
        label: path.split('/').pop() || path,
        view: 'editor',
        status: 'idle',
        filesOpen: false,
        editorFile: { source, path },
      }
      return { tabs: [...s.tabs, tab], activeTabId: tab.id, focusedPaneId: null }
    }),

  openK8sTab: (context) =>
    set((s) => {
      const existing = s.tabs.find((t) => t.k8sContext === context && t.view === 'k8s')
      if (existing) return { activeTabId: existing.id, focusedPaneId: null }
      const tab: Tab = {
        id: `tab-${++tabCounter}`,
        k8sContext: context,
        label: context,
        view: 'k8s',
        status: 'connected',
        filesOpen: false,
      }
      return { tabs: [...s.tabs, tab], activeTabId: tab.id, focusedPaneId: null }
    }),

  openDashboardTab: () => openSingletonTab(set, 'dashboard', 'Dashboard'),
  openConnectionsTab: () => openSingletonTab(set, 'connections', 'Connections'),
  openSettingsTab: () => openSingletonTab(set, 'settings', 'Settings'),
  openTunnelsTab: () => openSingletonTab(set, 'tunnels', 'Tunnels'),
  openRunnerTab: () => openSingletonTab(set, 'runner', 'Run Command'),

  // Each invocation opens a fresh shell — no dedup on purpose
  openLocalTerminalTab: () =>
    set((s) => {
      const tab: Tab = {
        id: `tab-${++tabCounter}`,
        label: 'Local',
        view: 'local-term',
        status: 'connected',
        filesOpen: false,
      }
      return { tabs: [...s.tabs, tab], activeTabId: tab.id, focusedPaneId: null }
    }),

  openDockerTab: (session) =>
    set((s) => {
      const existing = s.tabs.find((t) => t.sessionId === session.id && t.view === 'docker')
      if (existing) return { activeTabId: existing.id, focusedPaneId: null }
      const tab: Tab = {
        id: `tab-${++tabCounter}`,
        sessionId: session.id,
        label: `Docker · ${session.label || session.host}`,
        view: 'docker',
        status: 'connected',
        filesOpen: false,
      }
      return { tabs: [...s.tabs, tab], activeTabId: tab.id, focusedPaneId: null }
    }),

  closeTab: (tabId) =>
    set((s) => {
      // Closing a tab takes its split panes with it
      const tabs = s.tabs.filter((t) => t.id !== tabId && t.paneOf !== tabId)
      let activeTabId = s.activeTabId
      if (activeTabId === tabId) {
        const visible = tabs.filter((t) => !t.paneOf)
        const idx = s.tabs.filter((t) => !t.paneOf).findIndex((t) => t.id === tabId)
        const next = visible[idx] ?? visible[idx - 1] ?? null
        activeTabId = next?.id ?? null
      }
      const focusedPaneId = s.focusedPaneId === tabId || s.activeTabId === tabId ? null : s.focusedPaneId
      return { tabs, activeTabId, focusedPaneId }
    }),

  setActiveTab: (tabId) => set({ activeTabId: tabId, focusedPaneId: null }),

  splitTab: (parentTabId, session) =>
    set((s) => {
      const parent = s.tabs.find((t) => t.id === parentTabId)
      if (!parent || parent.view !== 'terminal' || parent.paneOf) return {}
      const paneCount = s.tabs.filter((t) => t.paneOf === parentTabId).length
      if (paneCount >= 3) return {}
      const pane: Tab = {
        id: `tab-${++tabCounter}`,
        sessionId: session.id,
        label: session.label || session.host,
        view: 'terminal',
        status: 'idle',
        filesOpen: false,
        paneOf: parentTabId,
      }
      return { tabs: [...s.tabs, pane], focusedPaneId: pane.id }
    }),

  setFocusedPane: (tabId) => set({ focusedPaneId: tabId }),
  updateTab: (tabId, data) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...data } : t)) })),
  toggleFilesDrawer: (tabId) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, filesOpen: !t.filesOpen } : t)) })),
  setShowAddSession: (show) => set({ showAddSession: show }),
  setShowCommandPalette: (show) => set({ showCommandPalette: show }),
  setShowAddConnection: (show) => set({ showAddConnection: show }),
  setEditingConnectionId: (id) => set({ editingConnectionId: id }),
  openRedisTab: (session) =>
    set((s) => {
      const existing = s.tabs.find((t) => t.sessionId === session.id && t.view === 'redis')
      if (existing) return { activeTabId: existing.id, focusedPaneId: null }
      const tab: Tab = {
        id: `tab-${++tabCounter}`,
        sessionId: session.id,
        label: session.label || session.host,
        view: 'redis',
        status: 'idle',
        filesOpen: false,
      }
      return { tabs: [...s.tabs, tab], activeTabId: tab.id, focusedPaneId: null }
    }),
  setLocked: (v) => set({ isLocked: v }),
  setSidebarView: (view) => set({ sidebarView: view }),
  setSidebarExpanded: (v) => set({ sidebarExpanded: v }),
  setSectionOrder: (section, order) =>
    set((s) => {
      const sectionOrder = { ...s.sectionOrder, [section]: order }
      persistSetting('sectionOrder', sectionOrder)
      return { sectionOrder }
    }),
  setProjectGroupOrder: (order) =>
    set(() => {
      persistSetting('projectGroupOrder', order)
      return { projectGroupOrder: order }
    }),
  setPendingConnectionGroup: (group) => set({ pendingConnectionGroup: group }),
  setGroupColor: (group, color) =>
    set((s) => {
      const groupColors = { ...s.groupColors }
      if (color) groupColors[group] = color
      else delete groupColors[group]
      persistSetting('groupColors', groupColors)
      return { groupColors }
    }),
  setBroadcastEnabled: (v) => set({ broadcastEnabled: v }),
  setServerMetrics: (sessionId, metrics) =>
    set((s) => {
      const cpuHistory = [...(s.serverMetrics[sessionId]?.cpuHistory ?? []), metrics.cpu].slice(-30)
      return { serverMetrics: { ...s.serverMetrics, [sessionId]: { ...metrics, cpuHistory } } }
    }),
  addNotification: (n) =>
    set((s) => ({
      notifications: [
        ...s.notifications,
        { ...n, id: `n-${++notifCounter}`, createdAt: Date.now() },
      ].slice(-20),
    })),
  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.isDarkMode
      if (next) document.documentElement.classList.add('dark')
      else document.documentElement.classList.remove('dark')
      persistSetting('isDarkMode', next)
      return { isDarkMode: next }
    }),
}))

// Re-export shared utilities so existing imports from store keep working
export { groupColor, connectionColor, dbTypeLabel } from '../lib/colors'
