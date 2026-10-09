import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) } }))
const env = vi.hoisted(() => ({
  unlocked: true,
  secrets: new Map<string, string>(),
  settings: { mcpEnabled: false, mcpPort: 39_847 } as { mcpEnabled: boolean; mcpPort: number },
  startError: null as (Error & { code?: string }) | null,
  started: [] as Array<{ port: number; token: string; tools: Array<{ name: string; run: (a: Record<string, unknown>) => Promise<string> }> }>,
}))
vi.mock('../../keychain', () => ({
  isUnlocked: () => env.unlocked,
  getAppSecret: async (name: string) => env.secrets.get(name) ?? null,
  saveAppSecret: async (name: string, value: string) => { env.secrets.set(name, value) },
}))
vi.mock('../../settings', () => ({
  getStoredSettings: () => env.settings,
  setStoredSetting: (key: 'mcpEnabled', value: boolean) => { env.settings[key] = value },
}))
vi.mock('../mcpApprovals', () => ({ resetApprovals: vi.fn(), registerMcpApprovalHandlers: vi.fn() }))
vi.mock('../mcpTools', () => ({ MCP_TOOLS: [{ name: 'list_connections', run: async () => '[]' }] }))
vi.mock('../mcpServer', () => ({
  startMcpServer: vi.fn(async (port: number, token: string, tools: never) => {
    if (env.startError) throw env.startError
    env.started.push({ port, token, tools })
    return { close: (cb: () => void) => cb(), closeAllConnections: vi.fn() }
  }),
}))

import { registerMcpHandlers, startMcpIfEnabled } from '../mcp'
import { resetApprovals } from '../mcpApprovals'

registerMcpHandlers()
const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!({}, ...args) as Promise<Record<string, unknown>>

beforeEach(async () => {
  env.unlocked = true
  env.startError = null
  await call('mcp:setEnabled', false)
  env.started.length = 0
})

describe('MCP access', () => {
  it('is off by default and starts with a fresh keychain token when enabled', async () => {
    expect(await call('mcp:status')).toEqual({ enabled: false, running: false, port: 39_847, error: null })
    expect(await call('mcp:setEnabled', true)).toMatchObject({ enabled: true, running: true })
    expect(env.started[0].port).toBe(39_847)
    expect(env.started[0].token).toMatch(/^[\w-]{43}$/)
    expect(env.secrets.get('mcp-token')).toBe(env.started[0].token)
  })

  it('hands out the setup command only while unlocked', async () => {
    await call('mcp:setEnabled', true)
    const info = await call('mcp:connectionInfo')
    expect(info.command).toBe(`claude mcp add --transport http noxed http://127.0.0.1:39847/mcp --header "Authorization: Bearer ${env.secrets.get('mcp-token')}"`)
    env.unlocked = false
    await expect(call('mcp:connectionInfo')).rejects.toThrow('Unlock noxed')
    await expect(call('mcp:setEnabled', true)).rejects.toThrow('Unlock noxed')
    await expect(call('mcp:regenerateToken')).rejects.toThrow('Unlock noxed')
  })

  it('refuses every tool while noxed is locked', async () => {
    await call('mcp:setEnabled', true)
    const [listTool] = env.started[0].tools
    expect(await listTool.run({})).toBe('[]')
    env.unlocked = false
    await expect(listTool.run({})).rejects.toThrow('noxed is locked')
  })

  it('restarts with a new token, and forgets approvals when stopping', async () => {
    await call('mcp:setEnabled', true)
    const before = env.started[0].token
    await call('mcp:regenerateToken')
    expect(env.started[1].token).not.toBe(before)
    vi.mocked(resetApprovals).mockClear()
    expect(await call('mcp:setEnabled', false)).toMatchObject({ enabled: false, running: false })
    expect(resetApprovals).toHaveBeenCalled()
  })

  it('reports a port that is already taken', async () => {
    env.startError = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    expect(await call('mcp:setEnabled', true)).toMatchObject({ running: false, error: 'Port 39847 is already in use' })
    env.startError = new Error('weird')
    expect(await call('mcp:setEnabled', true)).toMatchObject({ error: 'weird' })
  })

  it('starts at launch only if left on, and validates input', async () => {
    await startMcpIfEnabled()
    expect(env.started).toHaveLength(0)
    env.settings.mcpEnabled = true
    await startMcpIfEnabled()
    expect(env.started).toHaveLength(1)
    await expect(call('mcp:setEnabled', 'yes')).rejects.toThrow('Invalid MCP setting')
  })
})
