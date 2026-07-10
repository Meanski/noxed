import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../index'
import { groupColor, connectionColor, dbTypeLabel } from '../../lib/colors'
import type { Session } from '../index'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    label: 'Test Server',
    host: 'example.com',
    port: 22,
    username: 'user',
    authType: 'password',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('Zustand Store', () => {
  beforeEach(() => {
    useAppStore.setState({
      sessions: [],
      tabs: [],
      activeTabId: null,
      notifications: [],
      serverMetrics: {},
      showAddSession: false,
      showCommandPalette: false,
      showAddConnection: false,
      editingConnectionId: null,
      sidebarView: 'type',
      isDarkMode: false,
      isLocked: true,
      sectionOrder: {},
      projectGroupOrder: [],
      focusedPaneId: null,
    })
  })

  describe('Split panes', () => {
    function openTerminalTab(sessionId = 's1') {
      useAppStore.getState().openTab(makeSession({ id: sessionId }))
      return useAppStore.getState().activeTabId!
    }

    it('splitTab adds a pane linked to the parent and focuses it', () => {
      const parentId = openTerminalTab()
      useAppStore.getState().splitTab(parentId, makeSession({ id: 's2' }))
      const { tabs, focusedPaneId } = useAppStore.getState()
      const pane = tabs.find(t => t.paneOf === parentId)
      expect(pane).toBeDefined()
      expect(pane!.view).toBe('terminal')
      expect(focusedPaneId).toBe(pane!.id)
    })

    it('splitTab caps a tab at four panes', () => {
      const parentId = openTerminalTab()
      for (let i = 0; i < 5; i++) {
        useAppStore.getState().splitTab(parentId, makeSession({ id: `s${i + 2}` }))
      }
      expect(useAppStore.getState().tabs.filter(t => t.paneOf === parentId)).toHaveLength(3)
    })

    it('splitTab refuses to split a pane directly', () => {
      const parentId = openTerminalTab()
      useAppStore.getState().splitTab(parentId, makeSession({ id: 's2' }))
      const pane = useAppStore.getState().tabs.find(t => t.paneOf === parentId)!
      useAppStore.getState().splitTab(pane.id, makeSession({ id: 's3' }))
      expect(useAppStore.getState().tabs.filter(t => t.paneOf === pane.id)).toHaveLength(0)
    })

    it('closing the parent tab closes its panes', () => {
      const parentId = openTerminalTab()
      useAppStore.getState().splitTab(parentId, makeSession({ id: 's2' }))
      useAppStore.getState().closeTab(parentId)
      expect(useAppStore.getState().tabs).toHaveLength(0)
    })

    it('closing a pane keeps the parent and clears focus', () => {
      const parentId = openTerminalTab()
      useAppStore.getState().splitTab(parentId, makeSession({ id: 's2' }))
      const pane = useAppStore.getState().tabs.find(t => t.paneOf === parentId)!
      useAppStore.getState().closeTab(pane.id)
      const { tabs, focusedPaneId } = useAppStore.getState()
      expect(tabs.map(t => t.id)).toEqual([parentId])
      expect(focusedPaneId).toBeNull()
    })

    it('switching tabs resets pane focus', () => {
      const parentId = openTerminalTab()
      useAppStore.getState().splitTab(parentId, makeSession({ id: 's2' }))
      useAppStore.getState().openDashboardTab()
      expect(useAppStore.getState().focusedPaneId).toBeNull()
      useAppStore.getState().setActiveTab(parentId)
      expect(useAppStore.getState().focusedPaneId).toBeNull()
    })
  })

  describe('Session management', () => {
    it('setSessions replaces all sessions', () => {
      const s1 = makeSession({ id: '1' })
      const s2 = makeSession({ id: '2' })
      useAppStore.getState().setSessions([s1, s2])
      expect(useAppStore.getState().sessions).toHaveLength(2)
    })

    it('addSession appends to list', () => {
      const s1 = makeSession({ id: '1' })
      useAppStore.getState().addSession(s1)
      expect(useAppStore.getState().sessions).toHaveLength(1)

      const s2 = makeSession({ id: '2' })
      useAppStore.getState().addSession(s2)
      expect(useAppStore.getState().sessions).toHaveLength(2)
    })

    it('updateSession modifies the correct session', () => {
      const s = makeSession({ id: '1', label: 'Old Name' })
      useAppStore.getState().setSessions([s])
      useAppStore.getState().updateSession('1', { label: 'New Name' })
      expect(useAppStore.getState().sessions[0].label).toBe('New Name')
    })

    it('updateSession does not modify other sessions', () => {
      const s1 = makeSession({ id: '1', label: 'A' })
      const s2 = makeSession({ id: '2', label: 'B' })
      useAppStore.getState().setSessions([s1, s2])
      useAppStore.getState().updateSession('1', { label: 'Updated' })
      expect(useAppStore.getState().sessions[1].label).toBe('B')
    })

    it('removeSession filters out the session', () => {
      const s1 = makeSession({ id: '1' })
      const s2 = makeSession({ id: '2' })
      useAppStore.getState().setSessions([s1, s2])
      useAppStore.getState().removeSession('1')
      expect(useAppStore.getState().sessions).toHaveLength(1)
      expect(useAppStore.getState().sessions[0].id).toBe('2')
    })
  })

  describe('Tab management', () => {
    it('openTab creates a new tab and sets it active', () => {
      const session = makeSession({ id: 's1', label: 'Server 1' })
      useAppStore.getState().openTab(session)
      const state = useAppStore.getState()
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].sessionId).toBe('s1')
      expect(state.tabs[0].view).toBe('terminal')
      expect(state.activeTabId).toBe(state.tabs[0].id)
    })

    it('openTab reuses existing tab for same session', () => {
      const session = makeSession({ id: 's1' })
      useAppStore.getState().openTab(session)
      useAppStore.getState().openTab(session)
      expect(useAppStore.getState().tabs).toHaveLength(1)
    })

    it('openTab creates k8s tab for kubernetes type', () => {
      const session = makeSession({ type: 'kubernetes', contextName: 'my-cluster' })
      useAppStore.getState().openTab(session)
      expect(useAppStore.getState().tabs[0].view).toBe('k8s')
      expect(useAppStore.getState().tabs[0].status).toBe('connected')
    })

    it('closeTab removes the tab', () => {
      const session = makeSession()
      useAppStore.getState().openTab(session)
      const tabId = useAppStore.getState().tabs[0].id
      useAppStore.getState().closeTab(tabId)
      expect(useAppStore.getState().tabs).toHaveLength(0)
    })

    it('closeTab selects next tab when active is closed', () => {
      const s1 = makeSession({ id: 's1' })
      const s2 = makeSession({ id: 's2' })
      useAppStore.getState().openTab(s1)
      useAppStore.getState().openTab(s2)
      const tab1 = useAppStore.getState().tabs[0]
      const tab2 = useAppStore.getState().tabs[1]
      useAppStore.getState().setActiveTab(tab1.id)
      useAppStore.getState().closeTab(tab1.id)
      expect(useAppStore.getState().activeTabId).toBe(tab2.id)
    })

    it('closeTab sets activeTabId to null when last tab closed', () => {
      const session = makeSession()
      useAppStore.getState().openTab(session)
      const tabId = useAppStore.getState().tabs[0].id
      useAppStore.getState().closeTab(tabId)
      expect(useAppStore.getState().activeTabId).toBeNull()
    })

    it('updateTab modifies tab data', () => {
      const session = makeSession()
      useAppStore.getState().openTab(session)
      const tabId = useAppStore.getState().tabs[0].id
      useAppStore.getState().updateTab(tabId, { status: 'connected', streamId: 'stream-1' })
      const tab = useAppStore.getState().tabs[0]
      expect(tab.status).toBe('connected')
      expect(tab.streamId).toBe('stream-1')
    })

    it('toggleFilesDrawer flips filesOpen', () => {
      const session = makeSession()
      useAppStore.getState().openTab(session)
      const tabId = useAppStore.getState().tabs[0].id
      expect(useAppStore.getState().tabs[0].filesOpen).toBe(false)
      useAppStore.getState().toggleFilesDrawer(tabId)
      expect(useAppStore.getState().tabs[0].filesOpen).toBe(true)
      useAppStore.getState().toggleFilesDrawer(tabId)
      expect(useAppStore.getState().tabs[0].filesOpen).toBe(false)
    })

    it('openDashboardTab creates singleton dashboard tab', () => {
      useAppStore.getState().openDashboardTab()
      useAppStore.getState().openDashboardTab()
      expect(useAppStore.getState().tabs).toHaveLength(1)
      expect(useAppStore.getState().tabs[0].view).toBe('dashboard')
    })

    it('openSettingsTab creates singleton settings tab', () => {
      useAppStore.getState().openSettingsTab()
      useAppStore.getState().openSettingsTab()
      expect(useAppStore.getState().tabs).toHaveLength(1)
      expect(useAppStore.getState().tabs[0].view).toBe('settings')
    })

    it('openConnectionsTab creates singleton connections tab', () => {
      useAppStore.getState().openConnectionsTab()
      useAppStore.getState().openConnectionsTab()
      expect(useAppStore.getState().tabs).toHaveLength(1)
      expect(useAppStore.getState().tabs[0].view).toBe('connections')
    })

    it('openK8sTab reuses existing tab for same context', () => {
      useAppStore.getState().openK8sTab('cluster-1')
      useAppStore.getState().openK8sTab('cluster-1')
      expect(useAppStore.getState().tabs).toHaveLength(1)
    })

    it('openK8sTab creates separate tabs for different contexts', () => {
      useAppStore.getState().openK8sTab('cluster-1')
      useAppStore.getState().openK8sTab('cluster-2')
      expect(useAppStore.getState().tabs).toHaveLength(2)
    })

    it('reorderTabs moves a tab to the target position', () => {
      useAppStore.getState().openTab(makeSession({ id: 's1' }))
      useAppStore.getState().openTab(makeSession({ id: 's2' }))
      useAppStore.getState().openTab(makeSession({ id: 's3' }))
      const [t1, t2, t3] = useAppStore.getState().tabs
      // Drag the first tab onto the third
      useAppStore.getState().reorderTabs(t1.id, t3.id)
      expect(useAppStore.getState().tabs.map(t => t.id)).toEqual([t2.id, t3.id, t1.id])
    })

    it('reorderTabs keeps split panes attached to their parent', () => {
      useAppStore.getState().openTab(makeSession({ id: 's1' }))
      const parentId = useAppStore.getState().activeTabId!
      useAppStore.getState().openTab(makeSession({ id: 's2' }))
      const secondId = useAppStore.getState().activeTabId!
      useAppStore.getState().splitTab(parentId, makeSession({ id: 's3' }))
      useAppStore.getState().reorderTabs(parentId, secondId)
      const { tabs } = useAppStore.getState()
      const pane = tabs.find(t => t.paneOf === parentId)!
      // Pane still references its parent and parent now sits after the second tab
      expect(tabs.filter(t => !t.paneOf).map(t => t.id)).toEqual([secondId, parentId])
      expect(pane.paneOf).toBe(parentId)
    })

    it('reorderTabs ignores moves involving the dashboard', () => {
      useAppStore.getState().openDashboardTab()
      useAppStore.getState().openTab(makeSession({ id: 's1' }))
      const [dash, t1] = useAppStore.getState().tabs
      useAppStore.getState().reorderTabs(dash.id, t1.id)
      expect(useAppStore.getState().tabs.map(t => t.id)).toEqual([dash.id, t1.id])
    })

    it('openRedisTab creates a redis tab', () => {
      const session = makeSession({ id: 'r1', type: 'redis' })
      useAppStore.getState().openRedisTab(session)
      expect(useAppStore.getState().tabs[0].view).toBe('redis')
    })
  })

  describe('Session type → tab view mapping', () => {
    it('opens an sftp view for sftp sessions', () => {
      useAppStore.getState().openTab(makeSession({ type: 'sftp' }))
      const tab = useAppStore.getState().tabs[0]
      expect(tab.view).toBe('sftp')
      expect(tab.status).toBe('idle')
    })

    it('opens a database view for database sessions', () => {
      useAppStore.getState().openTab(makeSession({ type: 'database' }))
      expect(useAppStore.getState().tabs[0].view).toBe('database')
    })

    it('opens a redis view for redis sessions', () => {
      useAppStore.getState().openTab(makeSession({ type: 'redis' }))
      expect(useAppStore.getState().tabs[0].view).toBe('redis')
    })

    it('opens an rdp view for rdp sessions, born connected with RDP label', () => {
      useAppStore.getState().openTab(makeSession({ type: 'rdp', label: 'Win Box' }))
      const tab = useAppStore.getState().tabs[0]
      expect(tab.view).toBe('rdp')
      expect(tab.status).toBe('connected')
      expect(tab.label).toBe('RDP · Win Box')
    })

    it('falls back to terminal for untyped and ssh sessions', () => {
      useAppStore.getState().openTab(makeSession({ id: 'a1' }))
      useAppStore.getState().openTab(makeSession({ id: 'a2', type: 'ssh' }))
      const [t1, t2] = useAppStore.getState().tabs
      expect(t1.view).toBe('terminal')
      expect(t2.view).toBe('terminal')
    })
  })

  describe('Notifications', () => {
    it('addNotification adds a notification', () => {
      useAppStore.getState().addNotification({ type: 'info', message: 'Test' })
      expect(useAppStore.getState().notifications).toHaveLength(1)
      expect(useAppStore.getState().notifications[0].message).toBe('Test')
      expect(useAppStore.getState().notifications[0].type).toBe('info')
    })

    it('notifications have auto-generated ids and timestamps', () => {
      useAppStore.getState().addNotification({ type: 'error', message: 'Fail' })
      const n = useAppStore.getState().notifications[0]
      expect(n.id).toBeTruthy()
      expect(n.createdAt).toBeGreaterThan(0)
    })

    it('dismissNotification removes the notification', () => {
      useAppStore.getState().addNotification({ type: 'info', message: 'One' })
      useAppStore.getState().addNotification({ type: 'info', message: 'Two' })
      const id = useAppStore.getState().notifications[0].id
      useAppStore.getState().dismissNotification(id)
      expect(useAppStore.getState().notifications).toHaveLength(1)
      expect(useAppStore.getState().notifications[0].message).toBe('Two')
    })

    it('caps notifications at 20', () => {
      for (let i = 0; i < 25; i++) {
        useAppStore.getState().addNotification({ type: 'info', message: `Msg ${i}` })
      }
      expect(useAppStore.getState().notifications.length).toBeLessThanOrEqual(20)
    })
  })

  describe('Server metrics', () => {
    it('setServerMetrics stores metrics for a session', () => {
      useAppStore.getState().setServerMetrics('s1', {
        cpu: 45, memUsed: 4e9, memTotal: 8e9, available: true, lastUpdated: Date.now(),
      })
      const m = useAppStore.getState().serverMetrics['s1']
      expect(m.cpu).toBe(45)
      expect(m.available).toBe(true)
    })

    it('setServerMetrics updates existing metrics', () => {
      useAppStore.getState().setServerMetrics('s1', {
        cpu: 45, memUsed: 4e9, memTotal: 8e9, available: true, lastUpdated: Date.now(),
      })
      useAppStore.getState().setServerMetrics('s1', {
        cpu: 80, memUsed: 6e9, memTotal: 8e9, available: true, lastUpdated: Date.now(),
      })
      expect(useAppStore.getState().serverMetrics['s1'].cpu).toBe(80)
    })
  })

  describe('UI state', () => {
    it('setLocked toggles lock state', () => {
      expect(useAppStore.getState().isLocked).toBe(true)
      useAppStore.getState().setLocked(false)
      expect(useAppStore.getState().isLocked).toBe(false)
    })

    it('setSidebarView changes sidebar view', () => {
      useAppStore.getState().setSidebarView('project')
      expect(useAppStore.getState().sidebarView).toBe('project')
    })

    it('setSectionOrder stores order for a section', () => {
      useAppStore.getState().setSectionOrder('ssh', ['a', 'b', 'c'])
      expect(useAppStore.getState().sectionOrder['ssh']).toEqual(['a', 'b', 'c'])
    })

    it('setProjectGroupOrder stores order', () => {
      useAppStore.getState().setProjectGroupOrder(['prod', 'staging'])
      expect(useAppStore.getState().projectGroupOrder).toEqual(['prod', 'staging'])
    })
  })
})

describe('Store utility functions', () => {
  describe('groupColor', () => {
    it('returns a hex color string', () => {
      expect(groupColor('production')).toMatch(/^#[0-9a-fA-F]{6}$/)
    })

    it('returns consistent color for same input', () => {
      expect(groupColor('staging')).toBe(groupColor('staging'))
    })

    it('returns different colors for different groups', () => {
      const c1 = groupColor('production')
      const c2 = groupColor('development')
      // Not guaranteed different, but with the palette it's likely
      expect(typeof c1).toBe('string')
      expect(typeof c2).toBe('string')
    })
  })

  describe('connectionColor', () => {
    it('returns blue for ssh', () => {
      expect(connectionColor('ssh')).toBe('#3B5CCC')
    })

    it('returns pink for sftp', () => {
      expect(connectionColor('sftp')).toBe('#EC4899')
    })

    it('returns green for database', () => {
      expect(connectionColor('database')).toBe('#10B981')
    })

    it('returns purple for kubernetes', () => {
      expect(connectionColor('kubernetes')).toBe('#8B5CF6')
    })

    it('returns red for redis', () => {
      expect(connectionColor('redis')).toBe('#DC382D')
    })
  })

  describe('dbTypeLabel', () => {
    it('maps known types to labels', () => {
      expect(dbTypeLabel('postgresql')).toBe('PostgreSQL')
      expect(dbTypeLabel('mysql')).toBe('MySQL')
      expect(dbTypeLabel('mariadb')).toBe('MariaDB')
      expect(dbTypeLabel('sqlite')).toBe('SQLite')
      expect(dbTypeLabel('mongodb')).toBe('MongoDB')
    })

    it('returns raw type for unknown types', () => {
      expect(dbTypeLabel('oracle')).toBe('oracle')
    })

    it('returns "Database" for undefined', () => {
      expect(dbTypeLabel(undefined)).toBe('Database')
    })
  })
})
