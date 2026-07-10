import { ipcMain, BrowserWindow } from 'electron'
import Store from 'electron-store'
import { createServer, connect as netConnect, Server, Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { connectSessionClient, ManagedSshConnection } from './sshClients'
import { getSessionById } from './sessions'
import { NotFoundError, ValidationError, toMessage } from './errors'
import { validateHost, validatePort } from './security'
import {
  isSocksGreeting,
  socksGreetingReply,
  socksConnectReply,
  parseSocksConnectRequest,
  SOCKS_REPLY,
} from './socks'

export type TunnelType = 'local' | 'remote' | 'dynamic'

export interface TunnelDef {
  id: string
  sessionId: string
  type: TunnelType
  label?: string
  // local:   listen on 127.0.0.1:listenPort, forward to targetHost:targetPort from the server
  // remote:  listen on the server's 127.0.0.1:listenPort, forward to targetHost:targetPort locally
  // dynamic: SOCKS5 proxy on 127.0.0.1:listenPort
  listenPort: number
  targetHost?: string
  targetPort?: number
}

export type TunnelStatus = 'active' | 'error'

interface ActiveTunnel {
  conn: ManagedSshConnection
  server?: Server
  sockets: Set<Socket>
  status: TunnelStatus
  error?: string
  connections: number
}

interface TunnelStoreSchema {
  tunnels: TunnelDef[]
}

const store = new Store<TunnelStoreSchema>({ defaults: { tunnels: [] } })
const active = new Map<string, ActiveTunnel>()

const MAX_LABEL_LENGTH = 64

function broadcastChange(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('tunnel:changed')
  }
}

function validateTunnelDef(raw: unknown): Omit<TunnelDef, 'id'> {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Invalid tunnel definition')
  const r = raw as Record<string, unknown>

  if (r.type !== 'local' && r.type !== 'remote' && r.type !== 'dynamic') {
    throw new ValidationError('Invalid tunnel type')
  }
  if (typeof r.sessionId !== 'string' || !getSessionById(r.sessionId)) {
    throw new NotFoundError('Connection for tunnel')
  }
  if (r.label !== undefined && (typeof r.label !== 'string' || r.label.length > MAX_LABEL_LENGTH)) {
    throw new ValidationError('Invalid tunnel label')
  }
  const listenPort = validatePort(r.listenPort, 'listen port')

  if (r.type === 'dynamic') {
    return { sessionId: r.sessionId, type: r.type, label: r.label as string | undefined, listenPort }
  }

  return {
    sessionId: r.sessionId,
    type: r.type,
    label: r.label as string | undefined,
    listenPort,
    targetHost: validateHost(r.targetHost, 'target host'),
    targetPort: validatePort(r.targetPort, 'target port'),
  }
}

function requireDef(rawId: unknown): TunnelDef {
  if (typeof rawId !== 'string') throw new ValidationError('Invalid tunnel id')
  const def = store.get('tunnels').find((t) => t.id === rawId)
  if (!def) throw new NotFoundError('Tunnel')
  return def
}

function trackSocket(entry: ActiveTunnel, socket: Socket): void {
  entry.sockets.add(socket)
  entry.connections++
  socket.on('close', () => entry.sockets.delete(socket))
}

function pipeBoth(a: Duplex, b: Duplex): void {
  a.pipe(b)
  b.pipe(a)
  const teardown = () => {
    a.destroy()
    b.destroy()
  }
  a.on('error', teardown)
  b.on('error', teardown)
  a.on('close', teardown)
  b.on('close', teardown)
}

function listenLocally(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new ValidationError(`Cannot listen on 127.0.0.1:${port}: ${toMessage(err)}`)))
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

async function startLocalForward(def: TunnelDef, entry: ActiveTunnel): Promise<void> {
  const server = createServer((socket) => {
    trackSocket(entry, socket)
    entry.conn.client.forwardOut(
      socket.remoteAddress ?? '127.0.0.1',
      socket.remotePort ?? 0,
      def.targetHost!,
      def.targetPort!,
      (err, stream) => {
        if (err) { socket.destroy(); return }
        pipeBoth(socket, stream)
      },
    )
  })
  entry.server = server
  await listenLocally(server, def.listenPort)
}

// Second phase of the SOCKS5 handshake: parse the CONNECT request and open
// the forwarded channel over the SSH connection.
function handleSocksConnect(entry: ActiveTunnel, socket: Socket, request: Buffer): void {
  const parsed = parseSocksConnectRequest(request)
  if ('errorCode' in parsed) {
    socket.end(socksConnectReply(parsed.errorCode))
    return
  }
  // forwardOut's callback can hang indefinitely on an unresponsive target;
  // reply connection-refused after a deadline and ignore a late callback.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    socket.end(socksConnectReply(SOCKS_REPLY.connectionRefused))
  }, 30_000)
  entry.conn.client.forwardOut(
    socket.remoteAddress ?? '127.0.0.1',
    socket.remotePort ?? 0,
    parsed.host,
    parsed.port,
    (err, stream) => {
      clearTimeout(timer)
      if (timedOut) { stream?.destroy(); return }
      if (err) { socket.end(socksConnectReply(SOCKS_REPLY.connectionRefused)); return }
      socket.write(socksConnectReply(SOCKS_REPLY.success))
      pipeBoth(socket, stream)
    },
  )
}

async function startDynamicForward(def: TunnelDef, entry: ActiveTunnel): Promise<void> {
  const server = createServer((socket) => {
    trackSocket(entry, socket)
    socket.once('data', (greeting: Buffer) => {
      if (!isSocksGreeting(greeting)) { socket.destroy(); return }
      socket.write(socksGreetingReply())
      socket.once('data', (request: Buffer) => handleSocksConnect(entry, socket, request))
    })
    socket.on('error', () => socket.destroy())
  })
  entry.server = server
  await listenLocally(server, def.listenPort)
}

function startRemoteForward(def: TunnelDef, entry: ActiveTunnel): Promise<void> {
  return new Promise((resolve, reject) => {
    entry.conn.client.on('tcp connection', (_info, accept) => {
      const channel = accept()
      const local = netConnect(def.targetPort!, def.targetHost!)
      local.on('connect', () => pipeBoth(channel, local))
      local.on('error', () => channel.destroy())
    })
    entry.conn.client.forwardIn('127.0.0.1', def.listenPort, (err) => {
      if (err) reject(new ValidationError(`Server refused to listen on port ${def.listenPort}: ${toMessage(err)}`))
      else resolve()
    })
  })
}

function stopTunnel(id: string): void {
  const entry = active.get(id)
  if (!entry) return
  active.delete(id)
  entry.server?.close()
  for (const socket of entry.sockets) socket.destroy()
  entry.conn.dispose()
}

async function startTunnel(id: string): Promise<void> {
  const def = requireDef(id)
  if (active.has(id)) return

  const conn = await connectSessionClient(def.sessionId)
  const entry: ActiveTunnel = { conn, sockets: new Set(), status: 'active', connections: 0 }
  active.set(id, entry)

  // A dropped SSH connection kills the tunnel; surface it instead of leaving
  // a dead listener around.
  conn.client.on('close', () => {
    if (active.get(id) !== entry) return
    stopTunnel(id)
    broadcastChange()
  })
  conn.client.on('error', (err) => {
    if (active.get(id) !== entry) return
    entry.status = 'error'
    entry.error = toMessage(err)
    broadcastChange()
  })

  try {
    if (def.type === 'local') await startLocalForward(def, entry)
    else if (def.type === 'dynamic') await startDynamicForward(def, entry)
    else await startRemoteForward(def, entry)
  } catch (err) {
    stopTunnel(id)
    throw err
  }
  broadcastChange()
}

export function listTunnels(): Array<TunnelDef & { status: TunnelStatus | 'stopped'; error?: string; connections: number }> {
  return store.get('tunnels').map((def) => {
    const entry = active.get(def.id)
    return {
      ...def,
      status: entry?.status ?? 'stopped',
      error: entry?.error,
      connections: entry?.connections ?? 0,
    }
  })
}

export function disposeAllTunnels(): void {
  for (const id of active.keys()) {
    try {
      stopTunnel(id)
    } catch (e) {
      // One tunnel failing to clean up must not strand the rest on shutdown
      console.error(`[tunnels] failed to stop ${id}:`, toMessage(e))
    }
  }
}

export function registerTunnelHandlers(): void {
  ipcMain.handle('tunnels:list', () => listTunnels())

  ipcMain.handle('tunnels:save', (_e, rawDef: unknown, rawId: unknown) => {
    const def = validateTunnelDef(rawDef)
    const tunnels = store.get('tunnels')

    if (rawId !== undefined && rawId !== null) {
      const existing = requireDef(rawId)
      if (active.has(existing.id)) stopTunnel(existing.id)
      store.set('tunnels', tunnels.map((t) => (t.id === existing.id ? { ...def, id: existing.id } : t)))
      broadcastChange()
      return { ...def, id: existing.id }
    }

    const created: TunnelDef = { ...def, id: randomUUID() }
    store.set('tunnels', [...tunnels, created])
    broadcastChange()
    return created
  })

  ipcMain.handle('tunnels:delete', (_e, rawId: unknown) => {
    const def = requireDef(rawId)
    stopTunnel(def.id)
    store.set('tunnels', store.get('tunnels').filter((t) => t.id !== def.id))
    broadcastChange()
  })

  ipcMain.handle('tunnels:start', async (_e, rawId: unknown) => {
    const def = requireDef(rawId)
    await startTunnel(def.id)
  })

  ipcMain.handle('tunnels:stop', (_e, rawId: unknown) => {
    const def = requireDef(rawId)
    stopTunnel(def.id)
    broadcastChange()
  })
}
