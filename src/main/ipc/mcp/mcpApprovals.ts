import { BrowserWindow, ipcMain, type Event, type WebContentsDidStartNavigationEventParams } from 'electron'
import { randomUUID } from 'node:crypto'
import { AuthError, ValidationError } from '../errors'
import { isUnlocked, onLock } from '../keychain'
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
  /** Denies the request and withdraws its prompt. */
  cancel: () => void
}

export const APPROVAL_TIMEOUT_MS = 2 * 60 * 1000
const DECISIONS = new Set<ApprovalDecision>(['once', 'session', 'deny'])

const pending = new Map<string, Pending>()
const grants = new Set<string>()

/**
 * Forgets every "for this session" approval and denies every request still
 * waiting, so nothing approved afterwards can act once MCP is off or noxed locks.
 */
export function resetApprovals(): void {
  grants.clear()
  // Deleting entries while iterating a Map is safe: each is visited once.
  for (const entry of pending.values()) entry.cancel()
}

/** Resolves once the user approves; throws AuthError when they don't (or can't). */
export async function requestApproval(kind: ApprovalKind, sessionId: string, connection: string, detail: string): Promise<void> {
  if (!isUnlocked()) throw new AuthError('noxed is locked. Ask the user to unlock it, then try again.')
  const grant = `${kind}:${sessionId}`
  if (grants.has(grant)) return

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) throw new AuthError('noxed has no open window to ask the user in')

  const requestId = randomUUID()
  const contents = win.webContents
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    const finish = (d: ApprovalDecision, withdraw: boolean) => {
      if (!pending.delete(requestId)) return
      clearTimeout(timer)
      contents.off('destroyed', onGone)
      contents.off('did-start-navigation', onNavigate)
      if (withdraw && !contents.isDestroyed()) contents.send('mcp:approvalDismiss', requestId)
      resolve(d)
    }
    // A reloaded or closed window has lost its prompt; nobody can answer it.
    const onGone = () => finish('deny', false)
    const onNavigate = (e: Event<WebContentsDidStartNavigationEventParams>) => {
      if (e.isMainFrame && !e.isSameDocument) finish('deny', false)
    }
    const timer = setTimeout(() => finish('deny', true), APPROVAL_TIMEOUT_MS)
    contents.on('destroyed', onGone)
    contents.on('did-start-navigation', onNavigate)
    pending.set(requestId, {
      webContentsId: contents.id,
      decide: (d) => finish(d, false),
      cancel: () => finish('deny', true),
    })
    const request: ApprovalRequest = { requestId, kind, connection, detail }
    contents.send('mcp:approval', request)
  })

  if (decision === 'deny') throw new AuthError('The user declined this request in noxed.')
  if (decision === 'session') grants.add(grant)
}

export function registerMcpApprovalHandlers(): void {
  onLock(resetApprovals)

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
