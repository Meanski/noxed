import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { Client, ClientChannel, SFTPWrapper, Stats } from 'ssh2'
import { randomUUID } from 'node:crypto'
import { ConnectionError, NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'
import { getOwnedSshClient, SSH_CONNECT_DEFAULTS, sshConnectOptions } from './ssh'
import { isInsideHome, isLikelyTextFile, validateHost, validatePort } from './security'
import { connectSessionClient, openJumpSocket, ManagedSshConnection } from './sshClients'

interface SftpClient {
  client: Client
  sftp: SFTPWrapper
  ownsClient: boolean
  senderId: number
  upstream?: ManagedSshConnection
}

interface SftpConnectConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  streamId?: string
  jumpHostId?: string
}

const sftpClients = new Map<string, SftpClient>()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_REMOTE_PATH_LENGTH = 4096
const MAX_SFTP_CONTENT_BYTES = 10 * 1024 * 1024
const MAX_USERNAME_LENGTH = 128
const MAX_KEY_BYTES = 64 * 1024
const MAX_PASSWORD_BYTES = 1024

function validateClientId(clientId: unknown): string {
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    throw new ValidationError('Invalid SFTP client id')
  }
  return clientId
}

function validateRemotePath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_REMOTE_PATH_LENGTH || path.includes('\0')) {
    throw new ValidationError('Invalid remote path')
  }
  return path
}

function validateFileContent(content: unknown): string {
  if (typeof content !== 'string') throw new ValidationError('Invalid file content')
  if (Buffer.byteLength(content, 'utf8') > MAX_SFTP_CONTENT_BYTES) {
    throw new ValidationError('File content is too large')
  }
  return content
}

function validateFileMode(mode: unknown): number {
  if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o7777) {
    throw new ValidationError('Invalid file mode')
  }
  return mode as number
}

function validateLocalPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_REMOTE_PATH_LENGTH || path.includes('\0')) {
    throw new ValidationError('Invalid local path')
  }
  const check = isInsideHome(path)
  if (!check.ok) throw new ValidationError(check.reason)
  return check.resolved
}

function validateConnectConfig(rawConfig: unknown): SftpConnectConfig {
  if (!rawConfig || typeof rawConfig !== 'object') throw new ValidationError('Invalid SFTP config')
  const candidate = rawConfig as Record<string, unknown>

  if (candidate.streamId !== undefined && (typeof candidate.streamId !== 'string' || !UUID_RE.test(candidate.streamId))) {
    throw new ValidationError('Invalid SSH stream id')
  }

  const host = validateHost(candidate.host, 'SFTP host')
  const port = validatePort(candidate.port, 'SFTP port')

  if (typeof candidate.username !== 'string' || candidate.username.trim().length === 0 || candidate.username.length > MAX_USERNAME_LENGTH) {
    throw new ValidationError('Invalid SFTP username')
  }
  if (candidate.password !== undefined && typeof candidate.password !== 'string') {
    throw new ValidationError('Invalid SFTP password')
  }
  if (typeof candidate.password === 'string' && Buffer.byteLength(candidate.password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new ValidationError('SFTP password too large')
  }
  if (candidate.privateKey !== undefined && typeof candidate.privateKey !== 'string') {
    throw new ValidationError('Invalid SFTP private key')
  }
  if (typeof candidate.privateKey === 'string' && Buffer.byteLength(candidate.privateKey, 'utf8') > MAX_KEY_BYTES) {
    throw new ValidationError('SFTP private key too large')
  }
  if (candidate.jumpHostId !== undefined && (typeof candidate.jumpHostId !== 'string' || candidate.jumpHostId.length > 128)) {
    throw new ValidationError('Invalid jump host id')
  }

  return {
    host,
    port,
    username: candidate.username,
    password: candidate.password as string | undefined,
    privateKey: candidate.privateKey as string | undefined,
    streamId: candidate.streamId as string | undefined,
    jumpHostId: candidate.jumpHostId as string | undefined,
  }
}

function requireClient(event: IpcMainInvokeEvent, rawClientId: unknown): SftpClient {
  const clientId = validateClientId(rawClientId)
  const entry = sftpClients.get(clientId)
  if (!entry) throw new NotFoundError('SFTP client')
  if (entry.senderId !== event.sender.id) throw new OwnershipError('SFTP client')
  return entry
}

function createSftpChannel(client: Client, clientId: string, ownsClient: boolean, senderId: number, upstream?: ManagedSshConnection): Promise<string> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(new ConnectionError(toMessage(err)))
      sftpClients.set(clientId, { client, sftp, ownsClient, senderId, upstream })
      resolve(clientId)
    })
  })
}

async function openSftp(event: IpcMainInvokeEvent, config: SftpConnectConfig): Promise<string> {
  if (config.streamId) {
    const client = getOwnedSshClient(event, config.streamId)
    if (!client) throw new NotFoundError('SSH stream')
    return createSftpChannel(client, randomUUID(), false, event.sender.id)
  }

  let upstream: ManagedSshConnection | undefined
  let sock: ClientChannel | undefined
  if (config.jumpHostId) {
    upstream = await connectSessionClient(config.jumpHostId)
    try {
      sock = await openJumpSocket(upstream.client, config.host, config.port)
    } catch (err) {
      upstream.dispose()
      throw err
    }
  }

  return new Promise((resolve, reject) => {
    const client = new Client()
    const clientId = randomUUID()
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    client.on('ready', () => {
      createSftpChannel(client, clientId, true, event.sender.id, upstream).then(
        (id) => settle(() => resolve(id)),
        (err) => { client.end(); upstream?.dispose(); settle(() => reject(err)) },
      )
    })
    client.on('error', (err) => settle(() => { upstream?.dispose(); reject(new ConnectionError(toMessage(err))) }))
    client.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
      if (!config.password) { finish([]); return }
      finish(prompts.map(() => config.password ?? ''))
    })
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      privateKey: config.privateKey,
      sock,
      agent: process.env.SSH_AUTH_SOCK,
      tryKeyboard: true,
      ...sshConnectOptions(),
      algorithms: { ...SSH_CONNECT_DEFAULTS.algorithms },
    })
  })
}

function listDir(sftp: SFTPWrapper, path: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) return reject(new ConnectionError(toMessage(err)))
      resolve(list.map((f) => ({
        name: f.filename,
        size: f.attrs.size,
        mtime: f.attrs.mtime * 1000,
        permissions: f.attrs.mode,
        isDirectory: (f.attrs.mode & 0o170000) === 0o040000,
      })))
    })
  })
}

function readTextFile(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (statErr, stats: Stats) => {
      if (statErr) return reject(new ConnectionError(toMessage(statErr)))

      const filename = remotePath.split('/').pop() ?? ''
      if (!isLikelyTextFile(filename, stats.size ?? 0)) {
        return reject(new ValidationError('Cannot open binary file in editor. Use download instead.'))
      }

      const chunks: Buffer[] = []
      const stream = sftp.createReadStream(remotePath)
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => {
        const buf = Buffer.concat(chunks)
        const sample = buf.subarray(0, 8192)
        if (sample.includes(0)) {
          return reject(new ValidationError('File appears to be binary. Use download instead.'))
        }
        resolve(buf.toString('utf8'))
      })
      stream.on('error', (err: unknown) => reject(new ConnectionError(toMessage(err))))
    })
  })
}

function disposeClient(clientId: string): void {
  const entry = sftpClients.get(clientId)
  if (!entry) return
  sftpClients.delete(clientId)
  if (entry.ownsClient) {
    try { entry.client.end() } catch (err) { console.error(`[sftp] end ${clientId}: ${toMessage(err)}`) }
    entry.upstream?.dispose()
  }
}

export function disposeSftpClientsForSender(senderId: number): void {
  for (const [id, entry] of sftpClients) {
    if (entry.senderId === senderId) disposeClient(id)
  }
}

export function registerSftpHandlers(): void {
  ipcMain.handle('sftp:connect', (event, rawConfig: unknown) => {
    const config = validateConnectConfig(rawConfig)
    return openSftp(event, config)
  })

  ipcMain.handle('sftp:list', (event, rawClientId: unknown, rawPath: unknown) => {
    const path = validateRemotePath(rawPath)
    const entry = requireClient(event, rawClientId)
    return listDir(entry.sftp, path)
  })

  ipcMain.handle('sftp:readFile', (event, rawClientId: unknown, rawRemotePath: unknown) => {
    const remotePath = validateRemotePath(rawRemotePath)
    const entry = requireClient(event, rawClientId)
    return readTextFile(entry.sftp, remotePath)
  })

  ipcMain.handle('sftp:writeFile', (event, rawClientId: unknown, rawRemotePath: unknown, rawContent: unknown) => {
    const remotePath = validateRemotePath(rawRemotePath)
    const content = validateFileContent(rawContent)
    return new Promise((resolve, reject) => {
      const entry = requireClient(event, rawClientId)
      const stream = entry.sftp.createWriteStream(remotePath)
      stream.on('finish', () => resolve(true))
      stream.on('error', (err: unknown) => reject(new ConnectionError(toMessage(err))))
      stream.end(Buffer.from(content, 'utf8'))
    })
  })

  ipcMain.handle('sftp:download', (event, rawClientId: unknown, rawRemotePath: unknown, rawLocalPath: unknown) => {
    const remotePath = validateRemotePath(rawRemotePath)
    const localPath = validateLocalPath(rawLocalPath)
    return new Promise((resolve, reject) => {
      const entry = requireClient(event, rawClientId)
      entry.sftp.fastGet(remotePath, localPath, (err) => {
        if (err) reject(new ConnectionError(toMessage(err)))
        else resolve(localPath)
      })
    })
  })

  ipcMain.handle('sftp:upload', (event, rawClientId: unknown, rawLocalPath: unknown, rawRemotePath: unknown) => {
    const localPath = validateLocalPath(rawLocalPath)
    const remotePath = validateRemotePath(rawRemotePath)
    return new Promise((resolve, reject) => {
      const entry = requireClient(event, rawClientId)
      entry.sftp.fastPut(localPath, remotePath, (err) => {
        if (err) reject(new ConnectionError(toMessage(err)))
        else resolve(true)
      })
    })
  })

  ipcMain.handle('sftp:delete', (event, rawClientId: unknown, rawRemotePath: unknown) => {
    const remotePath = validateRemotePath(rawRemotePath)
    return new Promise<void>((resolve, reject) => {
      const entry = requireClient(event, rawClientId)
      entry.sftp.unlink(remotePath, (err) => {
        if (err) return reject(new ConnectionError(toMessage(err)))
        resolve()
      })
    })
  })

  ipcMain.handle('sftp:rename', (event, rawClientId: unknown, rawOldPath: unknown, rawNewPath: unknown) => {
    const oldPath = validateRemotePath(rawOldPath)
    const newPath = validateRemotePath(rawNewPath)
    return new Promise<void>((resolve, reject) => {
      const entry = requireClient(event, rawClientId)
      entry.sftp.rename(oldPath, newPath, (err) => {
        if (err) return reject(new ConnectionError(toMessage(err)))
        resolve()
      })
    })
  })

  ipcMain.handle('sftp:mkdir', (event, rawClientId: unknown, rawRemotePath: unknown) => {
    const remotePath = validateRemotePath(rawRemotePath)
    return new Promise<void>((resolve, reject) => {
      const entry = requireClient(event, rawClientId)
      entry.sftp.mkdir(remotePath, (err) => {
        if (err) return reject(new ConnectionError(toMessage(err)))
        resolve()
      })
    })
  })

  ipcMain.handle('sftp:rmdir', (event, rawClientId: unknown, rawRemotePath: unknown) => {
    const remotePath = validateRemotePath(rawRemotePath)
    return new Promise<void>((resolve, reject) => {
      const entry = requireClient(event, rawClientId)
      entry.sftp.rmdir(remotePath, (err) => {
        if (err) return reject(new ConnectionError(toMessage(err)))
        resolve()
      })
    })
  })

  ipcMain.handle('sftp:chmod', (event, rawClientId: unknown, rawRemotePath: unknown, rawMode: unknown) => {
    const remotePath = validateRemotePath(rawRemotePath)
    const mode = validateFileMode(rawMode)
    return new Promise<void>((resolve, reject) => {
      const entry = requireClient(event, rawClientId)
      entry.sftp.chmod(remotePath, mode, (err) => {
        if (err) return reject(new ConnectionError(toMessage(err)))
        resolve()
      })
    })
  })

  ipcMain.handle('sftp:stat', (event, rawClientId: unknown, rawRemotePath: unknown) => {
    const remotePath = validateRemotePath(rawRemotePath)
    return new Promise((resolve, reject) => {
      const entry = requireClient(event, rawClientId)
      entry.sftp.stat(remotePath, (err, stats: Stats) => {
        if (err) return reject(new ConnectionError(toMessage(err)))
        resolve({
          size: stats.size,
          mtime: stats.mtime * 1000,
          atime: stats.atime * 1000,
          mode: stats.mode,
          uid: stats.uid,
          gid: stats.gid,
          isDirectory: (stats.mode & 0o170000) === 0o040000,
        })
      })
    })
  })

  ipcMain.handle('sftp:disconnect', (event, rawClientId: unknown) => {
    const clientId = validateClientId(rawClientId)
    const entry = sftpClients.get(clientId)
    if (!entry) return
    if (entry.senderId !== event.sender.id) throw new OwnershipError('SFTP client')
    disposeClient(clientId)
  })
}
