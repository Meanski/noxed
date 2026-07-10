import { ipcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { ClientChannel } from 'ssh2'
import { randomUUID } from 'node:crypto'
import { connectSessionClient, ManagedSshConnection } from './sshClients'
import { ConnectionError, NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'

// Docker support works over the plain SSH connection — no agent, no exposed
// daemon socket. Everything is the docker CLI with `--format json` output.

interface DockerSession {
  conn: ManagedSshConnection
  sender: WebContents
}

interface LogStream {
  channel: ClientChannel
  senderId: number
}

const sessions = new Map<string, DockerSession>()
const logStreams = new Map<string, LogStream>()

const EXEC_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024
const MAX_LOG_TAIL = 10_000

// Container ids, names, and image references. Strict on purpose: these are
// interpolated into a remote shell command line.
const CONTAINER_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

const CONTAINER_ACTIONS = new Set(['start', 'stop', 'restart', 'rm'] as const)
export type ContainerAction = 'start' | 'stop' | 'restart' | 'rm'

export function validateContainerRef(ref: unknown): string {
  if (typeof ref !== 'string' || !CONTAINER_REF_RE.test(ref)) {
    throw new ValidationError('Invalid container reference')
  }
  return ref
}

export function validateContainerAction(action: unknown): ContainerAction {
  if (typeof action !== 'string' || !CONTAINER_ACTIONS.has(action as ContainerAction)) {
    throw new ValidationError('Invalid container action')
  }
  return action as ContainerAction
}

/** Parses `--format '{{json .}}'` output: one JSON object per line, bad lines skipped. */
export function parseJsonLines(output: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // Partial line from a truncated buffer — skip it
    }
  }
  return rows
}

// Wires a `docker logs -f` channel to the renderer and returns the stream id.
function attachLogStream(sender: WebContents, stream: ClientChannel): string {
  const logId = randomUUID()
  logStreams.set(logId, { channel: stream, senderId: sender.id })

  const send = (data: Buffer) => {
    if (!sender.isDestroyed()) sender.send('docker:logChunk', logId, data.toString('utf8'))
  }
  stream.on('data', send)
  stream.stderr.on('data', send)
  stream.on('close', () => {
    logStreams.delete(logId)
    if (!sender.isDestroyed()) sender.send('docker:logEnd', logId, null)
  })
  stream.on('error', (e: unknown) => {
    logStreams.delete(logId)
    if (!sender.isDestroyed()) sender.send('docker:logEnd', logId, toMessage(e))
  })
  return logId
}

function requireSession(event: IpcMainInvokeEvent, rawId: unknown): DockerSession {
  if (typeof rawId !== 'string') throw new ValidationError('Invalid Docker session id')
  const entry = sessions.get(rawId)
  if (!entry) throw new NotFoundError('Docker session')
  if (entry.sender.id !== event.sender.id) throw new OwnershipError('Docker session')
  return entry
}

function execCollect(entry: DockerSession, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    entry.conn.client.exec(command, (err, stream) => {
      if (err) return reject(new ConnectionError(toMessage(err)))

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        stream.close()
        reject(new ConnectionError('Remote command timed out'))
      }, EXEC_TIMEOUT_MS)

      stream.on('data', (d: Buffer) => {
        // Over-limit output is dropped; parseJsonLines skips the partial tail line.
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString('utf8')
      })
      stream.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 16 * 1024) stderr += d.toString('utf8')
      })
      stream.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code === 0 || (code === null && stdout)) {
          resolve(stdout)
        } else if (code === 127) {
          reject(new ConnectionError('Docker CLI not found on this host'))
        } else {
          reject(new ConnectionError(stderr.trim() || `Command failed (exit ${code})`))
        }
      })
      stream.on('error', (e: unknown) => {
        clearTimeout(timer)
        reject(new ConnectionError(toMessage(e)))
      })
    })
  })
}

function disposeSession(id: string): void {
  const entry = sessions.get(id)
  if (!entry) return
  sessions.delete(id)
  for (const [logId, log] of logStreams) {
    if (log.senderId === entry.sender.id) stopLogStream(logId)
  }
  entry.conn.dispose()
}

function stopLogStream(logId: string): void {
  const log = logStreams.get(logId)
  if (!log) return
  logStreams.delete(logId)
  try { log.channel.close() } catch (err) { console.error(`[docker] close log ${logId}: ${toMessage(err)}`) }
}

export function disposeDockerSessionsForSender(senderId: number): void {
  for (const [id, entry] of sessions) {
    if (entry.sender.id === senderId) disposeSession(id)
  }
}

export function registerDockerHandlers(): void {
  ipcMain.handle('docker:connect', async (event, rawSessionId: unknown) => {
    if (typeof rawSessionId !== 'string') throw new ValidationError('Invalid connection id')
    const conn = await connectSessionClient(rawSessionId)
    const id = randomUUID()
    const entry: DockerSession = { conn, sender: event.sender }
    sessions.set(id, entry)
    conn.client.on('close', () => disposeSession(id))
    return id
  })

  ipcMain.handle('docker:disconnect', (event, rawId: unknown) => {
    requireSession(event, rawId)
    disposeSession(rawId as string)
  })

  ipcMain.handle('docker:containers', async (event, rawId: unknown) => {
    const entry = requireSession(event, rawId)
    const out = await execCollect(entry, "docker ps -a --no-trunc --format '{{json .}}'")
    return parseJsonLines(out)
  })

  ipcMain.handle('docker:stats', async (event, rawId: unknown) => {
    const entry = requireSession(event, rawId)
    const out = await execCollect(entry, "docker stats --no-stream --format '{{json .}}'")
    return parseJsonLines(out)
  })

  ipcMain.handle('docker:images', async (event, rawId: unknown) => {
    const entry = requireSession(event, rawId)
    const out = await execCollect(entry, "docker images --format '{{json .}}'")
    return parseJsonLines(out)
  })

  ipcMain.handle('docker:info', async (event, rawId: unknown) => {
    const entry = requireSession(event, rawId)
    const out = await execCollect(entry, "docker info --format '{{json .}}'")
    return parseJsonLines(out)[0] ?? null
  })

  ipcMain.handle('docker:action', async (event, rawId: unknown, rawContainer: unknown, rawAction: unknown) => {
    const entry = requireSession(event, rawId)
    const container = validateContainerRef(rawContainer)
    const action = validateContainerAction(rawAction)
    const force = action === 'rm' ? ' -f' : ''
    await execCollect(entry, `docker ${action}${force} ${container}`)
  })

  ipcMain.handle('docker:logsStart', (event, rawId: unknown, rawContainer: unknown, rawTail: unknown) => {
    const entry = requireSession(event, rawId)
    const container = validateContainerRef(rawContainer)
    const tail = Number.isInteger(rawTail) && (rawTail as number) > 0
      ? Math.min(rawTail as number, MAX_LOG_TAIL)
      : 200

    return new Promise<string>((resolve, reject) => {
      entry.conn.client.exec(`docker logs --tail ${tail} -f ${container} 2>&1`, (err, stream) => {
        if (err) return reject(new ConnectionError(toMessage(err)))
        resolve(attachLogStream(event.sender, stream))
      })
    })
  })

  ipcMain.handle('docker:logsStop', (event, rawLogId: unknown) => {
    if (typeof rawLogId !== 'string') throw new ValidationError('Invalid log stream id')
    const log = logStreams.get(rawLogId)
    if (!log) return
    if (log.senderId !== event.sender.id) throw new OwnershipError('Docker log stream')
    stopLogStream(rawLogId)
  })
}
