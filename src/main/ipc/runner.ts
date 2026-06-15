import { ipcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { connectSessionClient, ManagedSshConnection } from './sshClients'
import { getSessionById } from './sessions'
import { NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'

// Runs one command across several hosts over short-lived SSH connections,
// streaming output back per host. The renderer owns presentation; this module
// owns connections, limits, and teardown.

const MAX_HOSTS = 50
const MAX_COMMAND_LENGTH = 4096
const MAX_OUTPUT_PER_HOST = 1024 * 1024
const RUN_TIMEOUT_MS = 120_000

interface ActiveRun {
  sender: WebContents
  connections: Map<string, ManagedSshConnection>
  timers: Set<NodeJS.Timeout>
  finished: Set<string>
  pending: number
  cancelled: boolean
}

const runs = new Map<string, ActiveRun>()

export function validateRunRequest(rawSessionIds: unknown, rawCommand: unknown): { sessionIds: string[]; command: string } {
  if (!Array.isArray(rawSessionIds) || rawSessionIds.length === 0 || rawSessionIds.length > MAX_HOSTS) {
    throw new ValidationError(`Select between 1 and ${MAX_HOSTS} hosts`)
  }
  const sessionIds = [...new Set(rawSessionIds)].map((id) => {
    if (typeof id !== 'string') throw new ValidationError('Invalid connection id')
    return id
  })
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) {
    throw new ValidationError('Command is required')
  }
  if (rawCommand.length > MAX_COMMAND_LENGTH) {
    throw new ValidationError('Command is too long')
  }
  return { sessionIds, command: rawCommand }
}

// A host can reach this twice (e.g. timeout, then the closing stream) —
// only the first outcome counts.
function finishHost(run: ActiveRun, runId: string, sessionId: string, exitCode: number | null, error: string | null): void {
  if (run.cancelled || run.finished.has(sessionId)) return
  run.finished.add(sessionId)
  const conn = run.connections.get(sessionId)
  if (conn) {
    run.connections.delete(sessionId)
    conn.dispose()
  }
  if (!run.sender.isDestroyed()) {
    run.sender.send('runner:done', runId, sessionId, exitCode, error)
  }
  run.pending--
  if (run.pending <= 0) disposeRun(runId)
}

function disposeRun(runId: string): void {
  const run = runs.get(runId)
  if (!run) return
  runs.delete(runId)
  run.cancelled = true
  for (const timer of run.timers) clearTimeout(timer)
  for (const conn of run.connections.values()) conn.dispose()
  run.connections.clear()
}

export function disposeRunsForSender(senderId: number): void {
  for (const [id, run] of runs) {
    if (run.sender.id === senderId) disposeRun(id)
  }
}

async function runOnHost(run: ActiveRun, runId: string, sessionId: string, command: string): Promise<void> {
  let conn: ManagedSshConnection
  try {
    conn = await connectSessionClient(sessionId)
  } catch (err) {
    finishHost(run, runId, sessionId, null, toMessage(err))
    return
  }
  if (run.cancelled) { conn.dispose(); return }
  run.connections.set(sessionId, conn)

  conn.client.exec(command, (err, stream) => {
    if (err) {
      finishHost(run, runId, sessionId, null, toMessage(err))
      return
    }

    let sent = 0
    const timer = setTimeout(() => {
      finishHost(run, runId, sessionId, null, 'Timed out after 120s')
    }, RUN_TIMEOUT_MS)
    run.timers.add(timer)

    const forward = (data: Buffer) => {
      if (run.sender.isDestroyed() || sent >= MAX_OUTPUT_PER_HOST) return
      sent += data.length
      run.sender.send('runner:output', runId, sessionId, data.toString('utf8'))
    }
    stream.on('data', forward)
    stream.stderr.on('data', forward)
    stream.on('close', (code: number | null) => {
      clearTimeout(timer)
      run.timers.delete(timer)
      finishHost(run, runId, sessionId, code, null)
    })
    stream.on('error', (e: unknown) => {
      clearTimeout(timer)
      run.timers.delete(timer)
      finishHost(run, runId, sessionId, null, toMessage(e))
    })
  })
}

export function registerRunnerHandlers(): void {
  ipcMain.handle('runner:run', (event: IpcMainInvokeEvent, rawSessionIds: unknown, rawCommand: unknown) => {
    const { sessionIds, command } = validateRunRequest(rawSessionIds, rawCommand)
    for (const id of sessionIds) {
      const session = getSessionById(id)
      if (!session) throw new NotFoundError(`Connection ${id}`)
      if (session.type && session.type !== 'ssh') {
        throw new ValidationError(`${session.label || session.host} is not an SSH connection`)
      }
    }

    const runId = randomUUID()
    const run: ActiveRun = {
      sender: event.sender,
      connections: new Map(),
      timers: new Set(),
      finished: new Set(),
      pending: sessionIds.length,
      cancelled: false,
    }
    runs.set(runId, run)

    for (const id of sessionIds) {
      void runOnHost(run, runId, id, command)
    }
    return runId
  })

  ipcMain.handle('runner:cancel', (event, rawRunId: unknown) => {
    if (typeof rawRunId !== 'string') throw new ValidationError('Invalid run id')
    const run = runs.get(rawRunId)
    if (!run) return
    if (run.sender.id !== event.sender.id) throw new OwnershipError('Command run')
    disposeRun(rawRunId)
  })
}
