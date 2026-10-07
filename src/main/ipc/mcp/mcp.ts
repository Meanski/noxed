import { ipcMain } from 'electron'
import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { AuthError, ValidationError, toMessage } from '../errors'
import { getAppSecret, isUnlocked, saveAppSecret } from '../keychain'
import { getStoredSettings, setStoredSetting } from '../settings'
import { clearApprovalGrants, registerMcpApprovalHandlers } from './mcpApprovals'
import { startMcpServer, type McpTool } from './mcpServer'
import { MCP_TOOLS } from './mcpTools'

// Turns noxed's MCP server on and off. Off by default; enabling it, and
// reading its token, both need noxed unlocked.

export interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  error: string | null
}

const TOKEN_SECRET = 'mcp-token'

let server: Server | null = null
let lastError: string | null = null

// While noxed is locked the server answers, but every tool refuses: not even
// the list of saved servers is shared.
const LOCK_GUARDED_TOOLS: readonly McpTool[] = MCP_TOOLS.map((tool) => ({
  ...tool,
  run: async (args) => {
    if (!isUnlocked()) throw new AuthError('noxed is locked. Ask the user to unlock it, then try again.')
    return tool.run(args)
  },
}))

async function token(): Promise<string> {
  const existing = await getAppSecret(TOKEN_SECRET)
  if (existing) return existing
  const fresh = randomBytes(32).toString('base64url')
  await saveAppSecret(TOKEN_SECRET, fresh)
  return fresh
}

function status(): McpStatus {
  const { mcpEnabled, mcpPort } = getStoredSettings()
  return { enabled: mcpEnabled, running: server !== null, port: mcpPort, error: lastError }
}

async function stop(): Promise<void> {
  clearApprovalGrants()
  const running = server
  server = null
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()))
}

async function start(): Promise<void> {
  await stop()
  const { mcpPort } = getStoredSettings()
  try {
    server = await startMcpServer(mcpPort, await token(), LOCK_GUARDED_TOOLS)
    lastError = null
  } catch (err) {
    lastError = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? `Port ${mcpPort} is already in use`
      : toMessage(err)
  }
}

/** Starts the server at launch when the user left it on. */
export async function startMcpIfEnabled(): Promise<void> {
  if (getStoredSettings().mcpEnabled) await start()
}

function requireUnlocked(): void {
  if (!isUnlocked()) throw new AuthError('Unlock noxed to change Claude Code access')
}

export function registerMcpHandlers(): void {
  registerMcpApprovalHandlers()

  ipcMain.handle('mcp:status', () => status())

  ipcMain.handle('mcp:setEnabled', async (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new ValidationError('Invalid MCP setting')
    requireUnlocked()
    setStoredSetting('mcpEnabled', enabled)
    if (enabled) await start()
    else await stop()
    return status()
  })

  ipcMain.handle('mcp:connectionInfo', async () => {
    requireUnlocked()
    const { mcpPort } = getStoredSettings()
    const url = `http://127.0.0.1:${mcpPort}/mcp`
    const bearer = await token()
    return { url, token: bearer, command: `claude mcp add --transport http noxed ${url} --header "Authorization: Bearer ${bearer}"` }
  })

  // A new token cuts off every client configured with the old one.
  ipcMain.handle('mcp:regenerateToken', async () => {
    requireUnlocked()
    await saveAppSecret(TOKEN_SECRET, randomBytes(32).toString('base64url'))
    if (server) await start()
    return status()
  })
}
