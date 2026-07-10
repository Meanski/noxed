import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useAppStore, Tab, Session } from '../../store'
import { checkResourceAlerts } from '../../lib/metricsAlerts'
import SnippetRunner, { Snippet, SnippetScope } from './SnippetRunner'
import TerminalSearchBar from './TerminalSearchBar'
import HostHeader from './HostHeader'
import DisconnectedOverlay from './DisconnectedOverlay'
import { registerStream, unregisterStream, LiveMetrics } from '../../lib/sshDispatch'
import {
  DEFAULT_SCROLLBACK_SIZE, resolveTerminalTheme, applyTerminalSettings,
  playBellSound, TerminalBehavior,
} from './terminalSettings'
import FilesDrawer from '../SFTP/FilesDrawer'

type Metrics = LiveMetrics

interface TerminalDebugState {
  bufferType: string
  baseY: number
  viewportY: number
  length: number
  rows: number
  cols: number
  lastWheelDelta: number | null
  wheelEvents: number
}

interface Props {
  tab: Tab
}

const MIN_TERMINAL_WIDTH = 20
const MIN_TERMINAL_HEIGHT = 20
const MIN_TERMINAL_COLS = 2
const MIN_TERMINAL_ROWS = 1
const MAX_TERMINAL_ROWS = 300
const PIXELS_PER_WHEEL_LINE = 18

function hasMeasurableSize(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return rect.width >= MIN_TERMINAL_WIDTH && rect.height >= MIN_TERMINAL_HEIGHT
}

interface TerminalCoreShape {
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: {
            width?: unknown
            height?: unknown
          }
        }
      }
    }
    viewport?: {
      scrollBarWidth?: unknown
    }
  }
}

function getTerminalCellSize(term: Terminal): { width: number; height: number } | null {
  const core = (term as unknown as TerminalCoreShape)._core
  const cell = core?._renderService?.dimensions?.css?.cell
  const width = typeof cell?.width === 'number' && Number.isFinite(cell.width) ? cell.width : 0
  const height = typeof cell?.height === 'number' && Number.isFinite(cell.height) ? cell.height : 0
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

function getTerminalScrollbarWidth(term: Terminal): number {
  const value = (term as unknown as TerminalCoreShape)._core?.viewport?.scrollBarWidth
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export default function TerminalView({ tab }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const streamIdRef = useRef<string | null>(null)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const updateTab = useAppStore((s) => s.updateTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const toggleFilesDrawer = useAppStore((s) => s.toggleFilesDrawer)
  const sessions = useAppStore((s) => s.sessions)
  const setServerMetrics = useAppStore((s) => s.setServerMetrics)
  const addNotification = useAppStore((s) => s.addNotification)
  const [connecting, setConnecting] = useState(false)
  const [elapsed, setElapsed] = useState('')
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [cooldown, setCooldown] = useState(0)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [globalSnippets, setGlobalSnippets] = useState<Snippet[]>([])
  const [hostSnippets, setHostSnippets] = useState<Snippet[]>([])
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugState, setDebugState] = useState<TerminalDebugState | null>(null)
  const failCountRef = useRef(0)
  const cooldownTimerRef = useRef<NodeJS.Timeout | null>(null)
  const broadcastEnabled = useAppStore(s => s.broadcastEnabled)
  const setBroadcastEnabled = useAppStore(s => s.setBroadcastEnabled)
  const broadcastRef = useRef(false)
  const siblingIdsRef = useRef<string[]>([])
  const pendingFitTimersRef = useRef<number[]>([])
  const pendingFitFramesRef = useRef<number[]>([])
  const wheelRemainderRef = useRef(0)
  const wheelEventsRef = useRef(0)
  const lastWheelDeltaRef = useRef<number | null>(null)
  const behaviorRef = useRef<TerminalBehavior>({ copyOnSelect: false, bellSound: true, resourceAlerts: true })

  const session = sessions.find((s) => s.id === tab.sessionId)

  // Split panes render under their parent tab; visibility and keyboard
  // shortcuts follow the parent's active state plus pane focus.
  const tabs = useAppStore((s) => s.tabs)
  const focusedPaneId = useAppStore((s) => s.focusedPaneId)
  const splitTab = useAppStore((s) => s.splitTab)
  const hostTabId = tab.paneOf ?? tab.id
  const isVisible = activeTabId === hostTabId
  const isKeyTarget = tab.paneOf
    ? isVisible && focusedPaneId === tab.id
    : isVisible && (!focusedPaneId || focusedPaneId === tab.id)
  const paneCount = tabs.filter((t) => t.paneOf === hostTabId).length + 1

  function notifyConnection(type: 'warning' | 'success', message: string): void {
    window.api.settings.get().then((cfg: { connAlerts?: unknown }) => {
      if (cfg.connAlerts !== false) addNotification({ type, message })
    }).catch((err: any) => {
      console.error('[notify] settings read failed:', err?.message ?? err)
    })
  }

  function attachStream(streamId: string): void {
    registerStream(
      streamId,
      (data) => termRef.current?.write(data),
      () => {
        updateTab(tab.id, { status: 'error', errorMessage: 'Remote closed connection' })
        termRef.current?.write('\r\n\x1b[2m— connection closed —\x1b[0m\r\n')
        notifyConnection('warning', `Connection to ${session?.label || session?.host || 'server'} closed`)
      },
      (data) => {
        setMetrics(data)
        setCpuHistory((prev) => [...prev.slice(-29), data.cpu])
        if (tab.sessionId) setServerMetrics(tab.sessionId, { ...data, lastUpdated: Date.now() })
        if (behaviorRef.current.resourceAlerts) {
          checkResourceAlerts(
            tab.sessionId ?? streamId,
            session?.label || session?.host || 'server',
            data,
            (message) => addNotification({ type: 'warning', message }),
          )
        }
      },
    )
  }

  broadcastRef.current = broadcastEnabled

  useEffect(() => {
    let prevTabs = useAppStore.getState().tabs
    const computeSiblings = (tabs: typeof prevTabs) => {
      siblingIdsRef.current = tabs
        .filter(t => t.view === 'terminal' && t.status === 'connected' && t.streamId && t.id !== tab.id)
        .map(t => t.streamId!)
    }
    computeSiblings(prevTabs)
    const unsub = useAppStore.subscribe(state => {
      if (state.tabs !== prevTabs) {
        prevTabs = state.tabs
        computeSiblings(state.tabs)
      }
    })
    return unsub
  }, [tab.id])

  useEffect(() => {
    window.api.settings.get().then((s: any) => {
      if (s?.['snippets:global']) setGlobalSnippets(s['snippets:global'].map((sn: Snippet) => ({ ...sn, scope: sn.scope || 'global' })))
      if (session && s?.[`snippets:${session.host}`]) setHostSnippets(s[`snippets:${session.host}`].map((sn: Snippet) => ({ ...sn, scope: sn.scope || 'host' })))
    }).catch((err: any) => {
      console.error('[snippets] failed to load:', err?.message ?? err)
    })
  }, [session?.host])

  function saveSnippet(snippet: Snippet) {
    const onError = (err: any) => console.error('[snippets] save failed:', err?.message ?? err)
    if (snippet.scope === 'global') {
      const next = [...globalSnippets, snippet]
      setGlobalSnippets(next)
      window.api.settings.set('snippets:global', next).catch(onError)
    } else {
      const next = [...hostSnippets, snippet]
      setHostSnippets(next)
      if (session) window.api.settings.set(`snippets:${session.host}`, next).catch(onError)
    }
  }

  function deleteSnippet(id: string, scope: SnippetScope) {
    const onError = (err: any) => console.error('[snippets] delete failed:', err?.message ?? err)
    if (scope === 'global') {
      const next = globalSnippets.filter(s => s.id !== id)
      setGlobalSnippets(next)
      window.api.settings.set('snippets:global', next).catch(onError)
    } else {
      const next = hostSnippets.filter(s => s.id !== id)
      setHostSnippets(next)
      if (session) window.api.settings.set(`snippets:${session.host}`, next).catch(onError)
    }
  }

  function runSnippetCommand(cmd: string) {
    if (cmd && streamIdRef.current) window.api.ssh.send(streamIdRef.current, cmd)
  }

  function captureDebugState(term = termRef.current) {
    if (!term) return
    setDebugState({
      bufferType: term.buffer.active.type,
      baseY: term.buffer.active.baseY,
      viewportY: term.buffer.active.viewportY,
      length: term.buffer.active.length,
      rows: term.rows,
      cols: term.cols,
      lastWheelDelta: lastWheelDeltaRef.current,
      wheelEvents: wheelEventsRef.current,
    })
  }

  function fitAndResizeRemote() {
    const container = containerRef.current
    const term = termRef.current
    if (!container || !term || !hasMeasurableSize(container)) return

    const rect = container.getBoundingClientRect()
    const cell = getTerminalCellSize(term)
    if (!cell) return

    const cols = Math.max(MIN_TERMINAL_COLS, Math.floor((rect.width - getTerminalScrollbarWidth(term)) / cell.width))
    const rows = Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, Math.floor(rect.height / cell.height)))
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows)

    if (streamIdRef.current) window.api.ssh.resize(streamIdRef.current, term.cols, term.rows)
    if (debugOpen) captureDebugState(term)
  }

  function scheduleFit() {
    clearScheduledFits()
    const frame = window.requestAnimationFrame(() => fitAndResizeRemote())
    pendingFitFramesRef.current.push(frame)
    const delays = [0, 50, 200, 500]
    delays.forEach((delay) => {
      const timer = window.setTimeout(() => fitAndResizeRemote(), delay)
      pendingFitTimersRef.current.push(timer)
    })
  }

  function clearScheduledFits() {
    pendingFitTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    pendingFitFramesRef.current.forEach((frame) => window.cancelAnimationFrame(frame))
    pendingFitTimersRef.current = []
    pendingFitFramesRef.current = []
  }

  function getWheelLineDelta(event: WheelEvent, term: Terminal): number {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * term.rows
    return event.deltaY / PIXELS_PER_WHEEL_LINE
  }

  function handleTerminalWheel(event: WheelEvent, term: Terminal): boolean {
    wheelEventsRef.current += 1
    lastWheelDeltaRef.current = event.deltaY
    if (debugOpen) captureDebugState(term)
    if (term.buffer.active.type !== 'normal') return true

    wheelRemainderRef.current += getWheelLineDelta(event, term)
    const lines = wheelRemainderRef.current > 0
      ? Math.floor(wheelRemainderRef.current)
      : Math.ceil(wheelRemainderRef.current)

    if (lines !== 0) {
      wheelRemainderRef.current -= lines
      term.scrollLines(lines)
      if (debugOpen) captureDebugState(term)
    }

    event.preventDefault()
    event.stopPropagation()
    return false
  }

  function toggleFilesPanel() {
    if (!tab.filesOpen) setSnippetsOpen(false)
    toggleFilesDrawer(tab.id)
  }

  function toggleSnippetsPanel() {
    if (!snippetsOpen && tab.filesOpen) toggleFilesDrawer(tab.id)
    setSnippetsOpen(s => !s)
  }

  // Init xterm
  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 14,
      lineHeight: 1.55,
      letterSpacing: 0.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: DEFAULT_SCROLLBACK_SIZE,
      allowTransparency: false,
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 5,
      smoothScrollDuration: 0,
      rescaleOverlappingGlyphs: true,
      theme: resolveTerminalTheme('noxed Dark'),
    })

    const links = new WebLinksAddon()
    term.loadAddon(links)
    const search = new SearchAddon()
    term.loadAddon(search)
    searchAddonRef.current = search
    term.attachCustomWheelEventHandler((event) => handleTerminalWheel(event, term))
    term.open(container)
    const onWheel = (event: WheelEvent) => handleTerminalWheel(event, term)
    container.addEventListener('wheel', onWheel, { capture: true, passive: false })
    document.fonts.ready.then(() => scheduleFit())

    const onSelection = term.onSelectionChange(() => {
      if (!behaviorRef.current.copyOnSelect || !term.hasSelection()) return
      navigator.clipboard.writeText(term.getSelection()).catch((err: any) => {
        console.error('[terminal] copy on select failed:', err?.message ?? err)
      })
    })
    const onBell = term.onBell(() => {
      if (behaviorRef.current.bellSound) playBellSound()
    })

    termRef.current = term

    const ro = new ResizeObserver(() => fitAndResizeRemote())
    ro.observe(container)

    applyTerminalSettings(term, behaviorRef, fitAndResizeRemote)

    return () => {
      container.removeEventListener('wheel', onWheel, { capture: true })
      clearScheduledFits()
      ro.disconnect()
      onSelection.dispose()
      onBell.dispose()
      term.dispose()
    }
  }, [])

  // Listen for settings changes and re-apply to the live terminal
  useEffect(() => {
    const handler = () => {
      if (termRef.current) {
        applyTerminalSettings(termRef.current, behaviorRef, fitAndResizeRemote)
      }
    }
    window.addEventListener('noxed:settings-changed', handler)
    return () => window.removeEventListener('noxed:settings-changed', handler)
  }, [])

  useEffect(() => {
    if (!debugOpen) return
    captureDebugState()
    const id = window.setInterval(() => captureDebugState(), 500)
    return () => window.clearInterval(id)
  }, [debugOpen])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isKeyTarget || !(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'd') return
      event.preventDefault()
      setDebugOpen(open => !open)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isKeyTarget])

  // Cmd+F opens scrollback search for the focused terminal
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isKeyTarget || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isKeyTarget])

  function closeSearch() {
    setSearchOpen(false)
    termRef.current?.focus()
  }

  // Restore existing stream on mount (tab was kept alive in store)
  useEffect(() => {
    if (tab.status === 'connected' && tab.streamId) {
      streamIdRef.current = tab.streamId
      attachStream(tab.streamId)
    }
  }, [])

  // Cleanup: stop metrics and disconnect SSH when component unmounts
  useEffect(() => {
    return () => {
      if (streamIdRef.current) {
        unregisterStream(streamIdRef.current)
        window.api.ssh.stopMetrics(streamIdRef.current)
        window.api.ssh.disconnect(streamIdRef.current).catch((err: any) => {
          // Best-effort: main may have already cleaned up on window close.
          console.error('[ssh] disconnect on unmount failed:', err?.message ?? err)
        })
      }
    }
  }, [])

  // Auto-connect on mount if idle
  useEffect(() => {
    if (tab.status !== 'idle' || !session) return
    connect()
  }, [tab.id])

  // Fit terminal when this tab becomes visible. Covers both initial mount
  // (first time the tab is created as the active tab) and switching back
  // from another tab (display:none → display:flex). Multiple delays ensure
  // at least one fires after the browser has finished layout.
  useEffect(() => {
    if (!isVisible) return
    scheduleFit()
    return clearScheduledFits
  }, [isVisible, paneCount])

  // Re-fit terminal when snippet panel toggles
  useEffect(() => {
    scheduleFit()
  }, [snippetsOpen])

  // SSH data + close events handled by sshDispatch singleton (registered on connect)

  // Keyboard → SSH
  useEffect(() => {
    if (!termRef.current) return
    const term = termRef.current
    const d1 = term.onData((data) => {
      if (streamIdRef.current) {
        window.api.ssh.send(streamIdRef.current, data)
        if (broadcastRef.current) {
          for (const sid of siblingIdsRef.current) window.api.ssh.send(sid, data)
        }
      }
    })
    const d2 = term.onResize(({ cols, rows }) => {
      if (streamIdRef.current) window.api.ssh.resize(streamIdRef.current, cols, rows)
    })
    return () => { d1.dispose(); d2.dispose() }
  }, [])

  // Elapsed timer
  useEffect(() => {
    if (tab.status !== 'connected' || !tab.connectedAt) return
    const tick = () => {
      const secs = Math.floor((Date.now() - tab.connectedAt!) / 1000)
      if (secs < 60) setElapsed(`${secs}s`)
      else if (secs < 3600) setElapsed(`${Math.floor(secs / 60)}m`)
      else setElapsed(`${Math.floor(secs / 3600)}h`)
    }
    tick()
    const id = setInterval(tick, 10000)
    return () => clearInterval(id)
  }, [tab.status, tab.connectedAt])

  // Metrics handled by sshDispatch singleton (registered on connect)

  function startCooldown(secs: number) {
    setCooldown(secs)
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current)
    cooldownTimerRef.current = setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) { clearInterval(cooldownTimerRef.current!); return 0 }
        return prev - 1
      })
    }, 1000)
  }

  async function connect() {
    if (!session) return
    setConnecting(true)
    updateTab(tab.id, { status: 'connecting' })

    const dim = '\x1b[2m'
    const reset = '\x1b[0m'
    termRef.current?.write(`${dim}Connecting to ${session.username}@${session.host}…${reset}\r\n`)

    try {
      const { password, privateKey } = await resolveSshCredentials(session, tab.sessionId)

      const streamId = await window.api.ssh.connect({
        host: session.host,
        port: session.port,
        username: session.username,
        password,
        privateKey,
        jumpHostId: session.jumpHostId,
      })
      if (streamIdRef.current) unregisterStream(streamIdRef.current)
      streamIdRef.current = streamId
      attachStream(streamId)
      if (failCountRef.current > 0) {
        notifyConnection('success', `Reconnected to ${session.label || session.host}`)
      }
      failCountRef.current = 0
      setCooldown(0)
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current)
      updateTab(tab.id, { status: 'connected', streamId, connectedAt: Date.now() })
      termRef.current?.clear()
      scheduleFit()
      setTimeout(() => window.api.ssh.startMetrics(streamId), 800)
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message ?? 'Connection failed'
      failCountRef.current += 1
      updateTab(tab.id, { status: 'error', errorMessage: msg })
      termRef.current?.write(`\r\n\x1b[31m✕ ${msg}\x1b[0m\r\n`)
      // Backoff: 5s, 15s, 30s after successive failures
      startCooldown(BACKOFF_SECONDS[Math.min(failCountRef.current, BACKOFF_SECONDS.length) - 1])
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="relative flex flex-col h-full" style={{ background: '#0c0b0f' }}>
      {/* Combined host header with inline metrics + files toggle */}
      {session && (
        <HostHeader
          session={session}
          status={tab.status}
          elapsed={elapsed}
          metrics={metrics}
          cpuHistory={cpuHistory}
          filesOpen={tab.filesOpen}
          snippetsOpen={snippetsOpen}
          broadcastEnabled={broadcastEnabled}
          onToggleFiles={toggleFilesPanel}
          onToggleSnippets={toggleSnippetsPanel}
          onToggleBroadcast={() => setBroadcastEnabled(!broadcastEnabled)}
          onSplitPick={paneCount < 4 ? (s) => splitTab(hostTabId, s) : undefined}
          onClosePane={tab.paneOf ? () => closeTab(tab.id) : undefined}
        />
      )}

      {/* Terminal + optional snippet panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="relative flex-1 min-w-0 px-3 pt-1.5 pb-1 overflow-hidden">
          <div ref={containerRef} className="h-full w-full" />
          {searchOpen && searchAddonRef.current && (
            <TerminalSearchBar addon={searchAddonRef.current} onClose={closeSearch} />
          )}
        </div>
        {snippetsOpen && (
          <SnippetRunner
            globalSnippets={globalSnippets}
            hostSnippets={hostSnippets}
            hostname={session?.host || 'unknown'}
            onRun={runSnippetCommand}
            onSave={saveSnippet}
            onDelete={deleteSnippet}
            onClose={() => setSnippetsOpen(false)}
          />
        )}
        {tab.filesOpen && (
          <FilesDrawer tab={tab} onClose={() => toggleFilesDrawer(tab.id)} />
        )}
      </div>

      {debugOpen && debugState && (
        <div
          className="absolute right-3 bottom-3 z-50 rounded-md px-3 py-2 font-mono text-[10px] leading-relaxed shadow-xl"
          style={{ background: 'rgba(0,0,0,0.86)', color: '#e5e7eb', border: '1px solid rgba(255,255,255,0.14)' }}
        >
          <div>buffer {debugState.bufferType}</div>
          <div>baseY {debugState.baseY} viewportY {debugState.viewportY} length {debugState.length}</div>
          <div>size {debugState.cols}x{debugState.rows}</div>
          <div>wheel {debugState.wheelEvents} delta {debugState.lastWheelDelta ?? 'none'}</div>
        </div>
      )}

      {tab.status === 'error' && (
        <DisconnectedOverlay
          message={tab.errorMessage}
          onReconnect={connect}
          connecting={connecting}
          cooldown={cooldown}
          failCount={failCountRef.current}
          onDismiss={() => updateTab(tab.id, { status: 'idle', errorMessage: undefined })}
          onClose={() => { updateTab(tab.id, { status: 'idle', errorMessage: undefined }); closeTab(tab.id) }}
        />
      )}
    </div>
  )
}

const BACKOFF_SECONDS = [5, 15, 30]

async function readKeyFile(path: string): Promise<string | undefined> {
  try { return await window.api.fs.readFile(path) } catch { return undefined }
}

// Resolves either the private key or the stored password for a session,
// throwing a user-facing error when neither is usable.
async function resolveSshCredentials(session: Session, sessionId?: string): Promise<{ password?: string; privateKey?: string }> {
  if (session.authType === 'key') {
    if (!session.keyPath) throw new Error('Key authentication selected but no key file path is configured')
    const privateKey = await readKeyFile(session.keyPath)
    if (!privateKey) throw new Error(`Cannot read private key: ${session.keyPath}`)
    return { privateKey }
  }
  const creds = sessionId
    ? await window.api.sessions.getCredentials(sessionId).catch((err: any) => {
        throw new Error(err?.message?.includes('locked') ? 'App is locked — unlock noxed to reconnect' : (err?.message ?? 'Failed to retrieve credentials'))
      })
    : null
  const password = creds?.password
  if (password === undefined) throw new Error('No password found for this session — re-enter credentials in Settings')
  return { password }
}
