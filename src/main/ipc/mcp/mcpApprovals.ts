import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { AuthError, ValidationError } from '../errors'
import { isUnlocked } from '../keychain'
import { isUuid } from '../security'

// Nothing an AI agent asks for over MCP happens until the user approves it
// in noxed. "session" approves that kind of request on that connection until
// noxed quits or MCP is turned off.

export type ApprovalKind = 'command' | 'read'
export type ApprovalDecision = 'once' | 'session' | 'deny'

export interface ApprovalRequest {
  requestId: string
  kind: ApprovalKind
  connection: string
  detail: string
}

interface Pending {
  webContentsId: number
  decide: (decision: ApprovalDecision) => void
}

export const APPROVAL_TIMEOUT_MS = 2 * 60 * 1000
const DECISIONS = new Set<ApprovalDecision>(['once', 'session', 'deny'])

const pending = new Map<string, Pending>()
const grants = new Set<string>()

/** Forgets every "for this session" approval. */
export function clearApprovalGrants(): void {
  grants.clear()
}

/** Resolves once the user approves; throws AuthError when they don't (or can't). */
export async function requestApproval(kind: ApprovalKind, sessionId: string, connection: string, detail: string): Promise<void> {
  if (!isUnlocked()) throw new AuthError('noxed is locked. Ask the user to unlock it, then try again.')
  const grant = `${kind}:${sessionId}`
  if (grants.has(grant)) return

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) throw new AuthError('noxed has no open window to ask the user in')

  const requestId = randomUUID()
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      if (!win.isDestroyed()) win.webContents.send('mcp:approvalDismiss', requestId)
      resolve('deny')
    }, APPROVAL_TIMEOUT_MS)
    pending.set(requestId, {
      webContentsId: win.webContents.id,
      decide: (d) => {
        clearTimeout(timer)
        pending.delete(requestId)
        resolve(d)
      },
    })
    const request: ApprovalRequest = { requestId, kind, connection, detail }
    win.webContents.send('mcp:approval', request)
  })

  if (decision === 'deny') throw new AuthError('The user declined this request in noxed.')
  if (decision === 'session') grants.add(grant)
}

export function registerMcpApprovalHandlers(): void {
  ipcMain.handle('mcp:respond', (event, rawRequestId: unknown, rawDecision: unknown) => {
    if (!isUuid(rawRequestId) || !DECISIONS.has(rawDecision as ApprovalDecision)) {
      throw new ValidationError('Invalid approval response')
    }
    const entry = pending.get(rawRequestId)
    if (entry?.webContentsId !== event.sender.id) return
    if (rawDecision !== 'deny' && !isUnlocked()) throw new AuthError('Unlock noxed to approve requests')
    entry.decide(rawDecision as ApprovalDecision)
  })
}
