import React, { useState, useEffect, useRef, useMemo, useCallback, forwardRef } from 'react'
import { useAppStore, Session, groupColor } from '../../store'
import {
  IconSearch, IconX, IconTerminal, IconArrowUp, IconArrowDown,
  IconCorner, IconPlus,
} from '../Icons'

interface Props {
  onClose: () => void
}

interface SessionItem {
  kind: 'session'
  session: Session
  id: string
}

interface CommandItem {
  kind: 'command'
  id: string
  label: string
  description?: string
  shortcut?: string
  Icon: typeof IconTerminal
  action: () => void
}

type PaletteItem = SessionItem | CommandItem

export default function CommandPalette({ onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  const { sessions, tabs, openTab, setShowAddSession, openTunnelsTab, openRunnerTab, openDockerTab, openDashboardTab, openLocalTerminalTab } = useAppStore()

  const connectedIds = useMemo(
    () => new Set(tabs.filter((t) => t.status === 'connected').map((t) => t.sessionId)),
    [tabs]
  )
  const connectingIds = useMemo(
    () => new Set(tabs.filter((t) => t.status === 'connecting').map((t) => t.sessionId)),
    [tabs]
  )

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase()

    const matchSession = (s: Session) =>
      !q ||
      (s.label || '').toLowerCase().includes(q) ||
      s.host.toLowerCase().includes(q) ||
      s.username.toLowerCase().includes(q) ||
      (s.group || '').toLowerCase().includes(q)

    const matched = sessions.filter(matchSession)

    const sorted: Session[] = [
      ...matched.filter((s) => connectedIds.has(s.id)),
      ...matched.filter((s) => connectingIds.has(s.id) && !connectedIds.has(s.id)),
      ...matched.filter((s) => !connectedIds.has(s.id) && !connectingIds.has(s.id)),
    ]

    const sessionItems: SessionItem[] = sorted.map((s) => ({
      kind: 'session',
      id: s.id,
      session: s,
    }))

    // Surfaced as the first option so ⌘T → Enter opens a local shell instantly
    const localTerminalCmd: CommandItem = {
      kind: 'command',
      id: 'new-local-terminal',
      label: 'New Local Terminal',
      description: 'Open a shell on this machine',
      shortcut: '⌘`',
      Icon: IconTerminal,
      action: () => { onClose(); openLocalTerminalTab() },
    }
    const quickItems: CommandItem[] =
      !q || `${localTerminalCmd.label} ${localTerminalCmd.description} shell`.toLowerCase().includes(q)
        ? [localTerminalCmd]
        : []

    const allCommands: CommandItem[] = [
      {
        kind: 'command',
        id: 'new-ssh',
        label: 'New SSH Session',
        description: 'Add a new server connection',
        shortcut: '⌘N',
        Icon: IconPlus,
        action: () => { onClose(); setShowAddSession(true) },
      },
      {
        kind: 'command',
        id: 'open-dashboard',
        label: 'Open Dashboard',
        description: 'Server health and live metrics',
        Icon: IconTerminal,
        action: () => { onClose(); openDashboardTab() },
      },
      {
        kind: 'command',
        id: 'open-tunnels',
        label: 'Open Tunnels',
        description: 'Port forwarding and SOCKS proxies',
        Icon: IconTerminal,
        action: () => { onClose(); openTunnelsTab() },
      },
      {
        kind: 'command',
        id: 'run-command',
        label: 'Run Command on Hosts…',
        description: 'Execute one command across multiple servers',
        Icon: IconTerminal,
        action: () => { onClose(); openRunnerTab() },
      },
      ...sessions
        .filter((s) => (s.type ?? 'ssh') === 'ssh')
        .map((s): CommandItem => ({
          kind: 'command',
          id: `docker-${s.id}`,
          label: `Docker on ${s.label || s.host}`,
          description: 'Containers, images, and logs over SSH',
          Icon: IconTerminal,
          action: () => { onClose(); openDockerTab(s) },
        })),
    ]

    const matchedCommands = allCommands.filter((c) => {
      // Per-host Docker entries only surface when searched for
      if (!q) return !c.id.startsWith('docker-')
      return c.label.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q)
    })

    return [...quickItems, ...sessionItems, ...matchedCommands]
  }, [query, sessions, connectedIds, connectingIds, onClose, setShowAddSession, openTunnelsTab, openRunnerTab, openDockerTab, openDashboardTab, openLocalTerminalTab])

  useEffect(() => setSelectedIdx(0), [items.length])

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const activate = useCallback(
    (item: PaletteItem) => {
      if (item.kind === 'session') {
        openTab(item.session)
        onClose()
      } else {
        item.action()
      }
    },
    [openTab, onClose]
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx((i) => Math.min(i + 1, items.length - 1))
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx((i) => Math.max(i - 1, 0))
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[selectedIdx]
        if (item) activate(item)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [items, selectedIdx, activate, onClose])

  const sessionItems = items.filter((i): i is SessionItem => i.kind === 'session')
  const commandItems = items.filter((i): i is CommandItem => i.kind === 'command')
  const quickItems = commandItems.filter((i) => i.id === 'new-local-terminal')
  const otherCommandItems = commandItems.filter((i) => i.id !== 'new-local-terminal')
  const connectedItems = sessionItems.filter((i) => connectedIds.has(i.session.id))
  const idleItems = sessionItems.filter((i) => !connectedIds.has(i.session.id))
  const showSectionLabels = !query.trim()

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <div className="w-[620px] bg-surface/95 backdrop-blur-xl border border-border-strong rounded-2xl shadow-palette overflow-hidden animate-modal-in">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border/60">
          <span className="text-text-muted flex-shrink-0">
            <IconSearch size={16} />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search servers, commands…"
            className="flex-1 bg-transparent text-md text-text-primary placeholder-text-muted focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
            >
              <IconX size={12} />
            </button>
          )}
          <kbd className="px-1.5 py-0.5 text-2xs font-medium text-text-muted bg-surface-2/60 border border-border rounded">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[440px] overflow-y-auto py-1.5">
          {items.length === 0 && (
            <div className="px-6 py-12 text-center">
              <p className="text-sm text-text-secondary">No results</p>
              <p className="text-xs text-text-muted mt-1">
                Nothing matches "<span className="text-text-secondary">{query}</span>"
              </p>
            </div>
          )}

          {quickItems.length > 0 && (
            <>
              {showSectionLabels && <SectionLabel>Quick actions</SectionLabel>}
              {quickItems.map((item) => {
                const globalIdx = items.indexOf(item)
                return (
                  <CommandRow
                    key={item.id}
                    ref={globalIdx === selectedIdx ? selectedRef : undefined}
                    item={item}
                    selected={globalIdx === selectedIdx}
                    onHover={() => setSelectedIdx(globalIdx)}
                    onClick={() => activate(item)}
                  />
                )
              })}
            </>
          )}

          {connectedItems.length > 0 && (
            <>
              {showSectionLabels && <SectionLabel>Active</SectionLabel>}
              {connectedItems.map((item) => {
                const globalIdx = items.indexOf(item)
                return (
                  <SessionRow
                    key={item.id}
                    ref={globalIdx === selectedIdx ? selectedRef : undefined}
                    item={item}
                    selected={globalIdx === selectedIdx}
                    isConnected
                    isConnecting={false}
                    onHover={() => setSelectedIdx(globalIdx)}
                    onClick={() => activate(item)}
                  />
                )
              })}
            </>
          )}

          {idleItems.length > 0 && (
            <>
              {showSectionLabels && <SectionLabel>Servers</SectionLabel>}
              {idleItems.map((item) => {
                const globalIdx = items.indexOf(item)
                return (
                  <SessionRow
                    key={item.id}
                    ref={globalIdx === selectedIdx ? selectedRef : undefined}
                    item={item}
                    selected={globalIdx === selectedIdx}
                    isConnected={false}
                    isConnecting={connectingIds.has(item.session.id)}
                    onHover={() => setSelectedIdx(globalIdx)}
                    onClick={() => activate(item)}
                  />
                )
              })}
            </>
          )}

          {otherCommandItems.length > 0 && (
            <>
              {showSectionLabels && <SectionLabel>Commands</SectionLabel>}
              {otherCommandItems.map((item) => {
                const globalIdx = items.indexOf(item)
                return (
                  <CommandRow
                    key={item.id}
                    ref={globalIdx === selectedIdx ? selectedRef : undefined}
                    item={item}
                    selected={globalIdx === selectedIdx}
                    onHover={() => setSelectedIdx(globalIdx)}
                    onClick={() => activate(item)}
                  />
                )
              })}
            </>
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-5 px-4 py-2.5 border-t border-border/60 bg-surface-2/30">
          <HintKey icon={<IconArrowUp size={9} />} secondIcon={<IconArrowDown size={9} />} label="navigate" />
          <HintKey icon={<IconCorner size={9} />} label="open" />
          <HintKey text="esc" label="close" />
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="px-4 pt-3 pb-1.5">
      <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-text-muted">
        {children}
      </span>
    </div>
  )
}

const SessionRow = forwardRef<
  HTMLButtonElement,
  {
    item: SessionItem
    selected: boolean
    isConnected: boolean
    isConnecting: boolean
    onHover: () => void
    onClick: () => void
  }
>(({ item, selected, isConnected, isConnecting, onHover, onClick }, ref) => {
  const { session } = item
  const group = session.group

  return (
    <button
      ref={ref}
      onClick={onClick}
      onMouseMove={onHover}
      className={`
        relative w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors
        ${selected ? 'bg-accent/[0.08]' : 'hover:bg-white/[0.02]'}
      `}
    >
      {/* Selected bar */}
      {selected && (
        <span className="absolute left-0 top-1 bottom-1 w-[2.5px] bg-accent rounded-r-full" />
      )}

      <Pip connected={isConnected} connecting={isConnecting} />

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary truncate">
            {session.label || session.host}
          </span>
          {session.label && (
            <span className="text-xs text-text-muted truncate font-mono shrink-0">
              {session.username}@{session.host}
            </span>
          )}
        </div>
      </div>

      {group && <GroupChip name={group} />}

      {isConnected && (
        <span className="text-2xs font-medium text-success flex-shrink-0 uppercase tracking-wider">
          Active
        </span>
      )}

      {selected && (
        <span className="flex items-center gap-1 text-2xs text-text-muted flex-shrink-0">
          {isConnected ? 'Switch' : 'Connect'}
          <IconCorner size={9} />
        </span>
      )}
    </button>
  )
})

const CommandRow = forwardRef<
  HTMLButtonElement,
  {
    item: CommandItem
    selected: boolean
    onHover: () => void
    onClick: () => void
  }
>(({ item, selected, onHover, onClick }, ref) => (
  <button
    ref={ref}
    onClick={onClick}
    onMouseMove={onHover}
    className={`
      relative w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors
      ${selected ? 'bg-accent/[0.08]' : 'hover:bg-white/[0.02]'}
    `}
  >
    {selected && (
      <span className="absolute left-0 top-1 bottom-1 w-[2.5px] bg-accent rounded-r-full" />
    )}
    <span className={`
      w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors
      ${selected ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-text-secondary border border-border/60'}
    `}>
      <item.Icon size={14} />
    </span>
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-text-primary">{item.label}</div>
      {item.description && (
        <div className="text-xs text-text-muted">{item.description}</div>
      )}
    </div>
    {item.shortcut && (
      <kbd className="text-2xs font-medium text-text-muted bg-surface-2/60 border border-border rounded px-1.5 py-0.5 flex-shrink-0">
        {item.shortcut}
      </kbd>
    )}
  </button>
))

function Pip({ connected, connecting }: Readonly<{ connected: boolean; connecting: boolean }>) {
  if (connecting) {
    return (
      <span className="relative flex items-center justify-center w-2 h-2 flex-shrink-0">
        <span className="absolute inset-0 rounded-full bg-accent/40 animate-pulse-ring" />
        <span className="relative w-1.5 h-1.5 rounded-full bg-accent" />
      </span>
    )
  }
  if (connected) {
    return <span className="w-2 h-2 rounded-full bg-success shadow-glow-success flex-shrink-0" />
  }
  return <span className="w-2 h-2 rounded-full border border-text-faint flex-shrink-0" />
}

function GroupChip({ name }: Readonly<{ name: string }>) {
  const groupColors = useAppStore(s => s.groupColors)
  const color = groupColor(name, groupColors)
  return (
    <span
      className="flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium flex-shrink-0"
      style={{
        background: `${color}18`,
        color,
        border: `1px solid ${color}30`,
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {name}
    </span>
  )
}

function HintKey({
  icon, secondIcon, text, label,
}: Readonly<{
  icon?: React.ReactNode
  secondIcon?: React.ReactNode
  text?: string
  label: string
}>) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5">
        {icon && (
          <kbd className="w-5 h-5 flex items-center justify-center text-text-muted bg-surface-2/60 border border-border rounded">
            {icon}
          </kbd>
        )}
        {secondIcon && (
          <kbd className="w-5 h-5 flex items-center justify-center text-text-muted bg-surface-2/60 border border-border rounded">
            {secondIcon}
          </kbd>
        )}
        {text && (
          <kbd className="h-5 flex items-center px-1.5 text-2xs font-medium text-text-muted bg-surface-2/60 border border-border rounded">
            {text}
          </kbd>
        )}
      </div>
      <span className="text-2xs text-text-muted">{label}</span>
    </div>
  )
}
