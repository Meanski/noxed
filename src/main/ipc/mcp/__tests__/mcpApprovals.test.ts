import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const win = vi.hoisted(() => ({
  current: null as null | { isDestroyed: () => boolean; webContents: FakeContents },
}))
type Listener = (...args: unknown[]) => void
interface FakeContents {
  id: number
  send: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  listeners: Map<string, Set<Listener>>
  on: (event: string, fn: Listener) => void
  off: (event: string, fn: Listener) => void
  emit: (event: string, ...args: unknown[]) => void
}
function fakeContents(): FakeContents {
  const listeners = new Map<string, Set<Listener>>()
  return {
    id: 5,
    send: vi.fn(),
    isDestroyed: () => false,
    listeners,
    on: (event, fn) => { listeners.set(event, (listeners.get(event) ?? new Set()).add(fn)) },
    off: (event, fn) => { listeners.get(event)?.delete(fn) },
    emit: (event, ...args) => { for (const fn of listeners.get(event) ?? []) fn(...args) },
  }
}
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { getFocusedWindow: () => win.current, getAllWindows: () => (win.current ? [win.current] : []) },
}))
const unlocked = vi.hoisted(() => ({ value: true }))
const lockListeners = vi.hoisted(() => [] as Array<() => void>)
vi.mock('../../keychain', () => ({ isUnlocked: () => unlocked.value, onLock: (fn: () => void) => lockListeners.push(fn) }))

import { APPROVAL_TIMEOUT_MS, registerMcpApprovalHandlers, requestApproval, resetApprovals } from '../mcpApprovals'
import { AuthError, ValidationError } from '../../errors'

registerMcpApprovalHandlers()

const sent = () => win.current!.webContents.send.mock.calls
const lastRequest = () => sent().filter((c) => c[0] === 'mcp:approval').at(-1)![1] as { requestId: string; kind: string; connection: string; detail: string }
const respond = (decision: string, senderId = 5) => handlers.get('mcp:respond')!({ sender: { id: senderId } }, lastRequest().requestId, decision)
const flush = () => new Promise((r) => setImmediate(r))

beforeEach(() => {
  unlocked.value = true
  resetApprovals()
  win.current = { isDestroyed: () => false, webContents: fakeContents() }
})
afterEach(() => vi.useRealTimers())

describe('requestApproval', () => {
  it('asks the window and resolves when the user allows once', async () => {
    const pending = requestApproval('command', 's1', 'web-01', 'uptime')
    expect(lastRequest()).toMatchObject({ kind: 'command', connection: 'web-01', detail: 'uptime' })
    respond('once')
    await expect(pending).resolves.toBeUndefined()
    // "once" grants nothing further.
    const again = requestApproval('command', 's1', 'web-01', 'df')
    expect(lastRequest().detail).toBe('df')
    respond('deny')
    await expect(again).rejects.toThrow('The user declined')
  })

  it('remembers "allow for this session" per connection and kind', async () => {
    const first = requestApproval('read', 's1', 'web-01', 'read /etc/hosts')
    respond('session')
    await first
    const asked = sent().length
    await requestApproval('read', 's1', 'web-01', 'read /etc/motd')
    expect(sent()).toHaveLength(asked)
    const other = requestApproval('command', 's1', 'web-01', 'ls')
    await flush()
    expect(sent()).toHaveLength(asked + 1)
    respond('deny')
    await expect(other).rejects.toThrow(AuthError)
    resetApprovals()
    const afterClear = requestApproval('read', 's1', 'web-01', 'read x')
    expect(sent()).toHaveLength(asked + 2)
    respond('deny')
    await expect(afterClear).rejects.toThrow(AuthError)
  })

  it('denies when nobody answers in time, and withdraws the prompt', async () => {
    vi.useFakeTimers()
    const pending = requestApproval('command', 's1', 'web-01', 'sleep 1')
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS)
    await expect(pending).rejects.toThrow('declined')
    expect(sent().some((c) => c[0] === 'mcp:approvalDismiss')).toBe(true)
  })

  it('refuses while locked or with no window to ask in', async () => {
    unlocked.value = false
    await expect(requestApproval('read', 's1', 'w', 'x')).rejects.toThrow('noxed is locked')
    unlocked.value = true
    win.current = null
    await expect(requestApproval('read', 's1', 'w', 'x')).rejects.toThrow('no open window')
  })
})

describe('cancelling waiting requests', () => {
  const dismissed = () => sent().filter((c) => c[0] === 'mcp:approvalDismiss').length

  it('denies and withdraws them on reset, and drops their window listeners', async () => {
    const pending = requestApproval('command', 's1', 'web-01', 'uptime')
    resetApprovals()
    await expect(pending).rejects.toThrow('declined')
    expect(dismissed()).toBe(1)
    expect([...win.current!.webContents.listeners.values()].every((set) => set.size === 0)).toBe(true)
  })

  it('denies them and forgets session approvals when noxed locks', async () => {
    const first = requestApproval('read', 's1', 'web-01', 'read a')
    respond('session')
    await first
    const waiting = requestApproval('command', 's1', 'web-01', 'ls')
    for (const fn of lockListeners) fn()
    await expect(waiting).rejects.toThrow('declined')
    const again = requestApproval('read', 's1', 'web-01', 'read b')
    expect(lastRequest().detail).toBe('read b')
    respond('deny')
    await expect(again).rejects.toThrow('declined')
  })

  it('denies them when the window closes or loads a new page', async () => {
    const closed = requestApproval('command', 's1', 'web-01', 'uptime')
    win.current!.webContents.emit('destroyed')
    await expect(closed).rejects.toThrow('declined')

    const reloaded = requestApproval('command', 's1', 'web-01', 'uptime')
    win.current!.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    win.current!.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    win.current!.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await expect(reloaded).rejects.toThrow('declined')
    expect(dismissed()).toBe(0)
  })
})

describe('mcp:respond', () => {
  it('only accepts answers from the asked window, and approvals only while unlocked', async () => {
    const pending = requestApproval('command', 's1', 'web-01', 'whoami')
    respond('once', 99)
    unlocked.value = false
    expect(() => respond('once')).toThrow('Unlock noxed')
    respond('deny')
    await expect(pending).rejects.toThrow('declined')
  })

  it('validates its input', () => {
    expect(() => handlers.get('mcp:respond')!({ sender: { id: 5 } }, 'nope', 'once')).toThrow(ValidationError)
    expect(() => handlers.get('mcp:respond')!({ sender: { id: 5 } }, '00000000-0000-4000-8000-000000000000', 'always')).toThrow(ValidationError)
    expect(handlers.get('mcp:respond')!({ sender: { id: 5 } }, '00000000-0000-4000-8000-000000000000', 'once')).toBeUndefined()
  })
})
