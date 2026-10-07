import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const win = vi.hoisted(() => ({
  current: null as null | { isDestroyed: () => boolean; webContents: { id: number; send: ReturnType<typeof vi.fn> } },
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { getFocusedWindow: () => win.current, getAllWindows: () => (win.current ? [win.current] : []) },
}))
const unlocked = vi.hoisted(() => ({ value: true }))
vi.mock('../../keychain', () => ({ isUnlocked: () => unlocked.value }))

import { APPROVAL_TIMEOUT_MS, clearApprovalGrants, registerMcpApprovalHandlers, requestApproval } from '../mcpApprovals'
import { AuthError, ValidationError } from '../../errors'

registerMcpApprovalHandlers()

const sent = () => win.current!.webContents.send.mock.calls
const lastRequest = () => sent().filter((c) => c[0] === 'mcp:approval').at(-1)![1] as { requestId: string; kind: string; connection: string; detail: string }
const respond = (decision: string, senderId = 5) => handlers.get('mcp:respond')!({ sender: { id: senderId } }, lastRequest().requestId, decision)
const flush = () => new Promise((r) => setImmediate(r))

beforeEach(() => {
  unlocked.value = true
  clearApprovalGrants()
  win.current = { isDestroyed: () => false, webContents: { id: 5, send: vi.fn() } }
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
    expect(sent().length).toBe(asked)
    const other = requestApproval('command', 's1', 'web-01', 'ls')
    await flush()
    expect(sent().length).toBe(asked + 1)
    respond('deny')
    await expect(other).rejects.toThrow(AuthError)
    clearApprovalGrants()
    const afterClear = requestApproval('read', 's1', 'web-01', 'read x')
    expect(sent().length).toBe(asked + 2)
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
