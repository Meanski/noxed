import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'

const windows: Array<{ webContents: { isDestroyed: () => boolean; send: Mock } }> = []

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => windows },
}))
vi.mock('electron-store', () => ({
  default: class MockStore {
    private data = new Map<string, unknown>()
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      for (const [k, v] of Object.entries(opts?.defaults ?? {})) this.data.set(k, v)
    }
    get(key: string) { return this.data.get(key) }
    set(key: string, value: unknown) { this.data.set(key, value) }
  },
}))
vi.mock('node:net', () => ({
  createServer: vi.fn(),
  connect: vi.fn(),
}))
vi.mock('../sshClients', () => ({
  connectSessionClient: vi.fn(),
}))
vi.mock('../sessions', () => ({
  getSessionById: vi.fn(() => ({ id: 's1', label: 'server' })),
}))

import { ipcMain } from 'electron'
import { createServer, connect as netConnect } from 'node:net'
import { connectSessionClient } from '../sshClients'
import { getSessionById } from '../sessions'
import { registerTunnelHandlers, disposeAllTunnels, listTunnels, TunnelDef } from '../tunnels'
import { ValidationError, NotFoundError } from '../errors'
import { SOCKS_REPLY, socksConnectReply, socksGreetingReply } from '../socks'

registerTunnelHandlers()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => any

function handler(channel: string): Handler {
  const call = (ipcMain.handle as Mock).mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No handler registered for ${channel}`)
  return call[1] as Handler
}

class FakeServer extends EventEmitter {
  listen = vi.fn((_port: number, _host: string, cb: () => void) => cb())
  close = vi.fn()
}

type ConnHandler = (socket: FakeSocket) => void

interface NetState {
  server: FakeServer
  connHandler: ConnHandler | undefined
}

function primeCreateServer(): NetState {
  const state: NetState = { server: new FakeServer(), connHandler: undefined }
  // Replace (not queue) the implementation so an unused priming can't leak
  // into a later test.
  ;(createServer as Mock).mockImplementation((h: ConnHandler) => {
    state.connHandler = h
    return state.server
  })
  return state
}

interface FakeSshClient extends EventEmitter {
  forwardOut: Mock
  forwardIn: Mock
}

function fakeConn() {
  const client = new EventEmitter() as FakeSshClient
  client.forwardOut = vi.fn()
  client.forwardIn = vi.fn()
  return { client, dispose: vi.fn() }
}

interface FakeSocket extends EventEmitter {
  write: Mock
  end: Mock
  destroy: Mock
  pipe: Mock
  remoteAddress?: string
  remotePort?: number
}

function fakeSocket(): FakeSocket {
  const s = new EventEmitter() as FakeSocket
  s.write = vi.fn()
  s.end = vi.fn()
  s.destroy = vi.fn()
  s.pipe = vi.fn()
  return s
}

function fakeStream(): FakeSocket {
  return fakeSocket()
}

const DYNAMIC_DEF = { type: 'dynamic', sessionId: 's1', listenPort: 1080 }
const LOCAL_DEF = { type: 'local', sessionId: 's1', listenPort: 15432, targetHost: 'db.internal', targetPort: 5432 }
const REMOTE_DEF = { type: 'remote', sessionId: 's1', listenPort: 9000, targetHost: 'localhost', targetPort: 8080 }

async function saveAndStart(rawDef: Record<string, unknown>, conn = fakeConn()) {
  const def = (await handler('tunnels:save')({}, rawDef, undefined)) as TunnelDef
  const net = primeCreateServer()
  ;(connectSessionClient as Mock).mockResolvedValueOnce(conn)
  await handler('tunnels:start')({}, def.id)
  return { def, conn, net }
}

beforeEach(() => {
  disposeAllTunnels()
  windows.length = 0
  ;(connectSessionClient as Mock).mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('tunnels:save validation and persistence', () => {
  it('rejects malformed definitions', () => {
    const save = handler('tunnels:save')
    expect(() => save({}, null, undefined)).toThrow(ValidationError)
    expect(() => save({}, { ...DYNAMIC_DEF, type: 'socks' }, undefined)).toThrow(ValidationError)
    expect(() => save({}, { ...DYNAMIC_DEF, label: 'x'.repeat(65) }, undefined)).toThrow(ValidationError)
    expect(() => save({}, { ...DYNAMIC_DEF, listenPort: 0 }, undefined)).toThrow('Invalid listen port')
    expect(() => save({}, { ...LOCAL_DEF, targetHost: 'bad host!' }, undefined)).toThrow('illegal characters')
    ;(getSessionById as Mock).mockReturnValueOnce(undefined)
    expect(() => save({}, DYNAMIC_DEF, undefined)).toThrow(NotFoundError)
  })

  it('creates, lists, updates in place, and deletes tunnels', async () => {
    const win = { webContents: { isDestroyed: () => false, send: vi.fn() } }
    windows.push(win)
    const created = (await handler('tunnels:save')({}, { ...DYNAMIC_DEF, label: 'proxy' }, undefined)) as TunnelDef
    expect(created.id).toEqual(expect.any(String))
    expect(win.webContents.send).toHaveBeenCalledWith('tunnel:changed')

    const listed = listTunnels().find((t) => t.id === created.id)
    expect(listed).toMatchObject({ label: 'proxy', status: 'stopped', connections: 0 })

    const updated = (await handler('tunnels:save')({}, { ...DYNAMIC_DEF, listenPort: 1081 }, created.id)) as TunnelDef
    expect(updated.id).toBe(created.id)
    expect(listTunnels().find((t) => t.id === created.id)?.listenPort).toBe(1081)

    await handler('tunnels:delete')({}, created.id)
    expect(listTunnels().find((t) => t.id === created.id)).toBeUndefined()
  })

  it('rejects operations on unknown or malformed tunnel ids', async () => {
    expect(() => handler('tunnels:delete')({}, 42)).toThrow(ValidationError)
    await expect(handler('tunnels:start')({}, 'missing')).rejects.toBeInstanceOf(NotFoundError)
    expect(() => handler('tunnels:stop')({}, 'missing')).toThrow(NotFoundError)
  })
})

describe('local forward', () => {
  it('forwards accepted sockets through the SSH connection', async () => {
    const { def, conn, net } = await saveAndStart(LOCAL_DEF)
    expect(net.server.listen).toHaveBeenCalledWith(15432, '127.0.0.1', expect.any(Function))
    expect(listTunnels().find((t) => t.id === def.id)?.status).toBe('active')

    const socket = fakeSocket()
    socket.remoteAddress = '127.0.0.1'
    socket.remotePort = 50000
    net.connHandler!(socket)
    expect(conn.client.forwardOut).toHaveBeenCalledWith('127.0.0.1', 50000, 'db.internal', 5432, expect.any(Function))

    const stream = fakeStream()
    conn.client.forwardOut.mock.calls[0][4](null, stream)
    expect(socket.pipe).toHaveBeenCalledWith(stream)
    expect(stream.pipe).toHaveBeenCalledWith(socket)
    expect(listTunnels().find((t) => t.id === def.id)?.connections).toBe(1)
  })

  it('destroys the socket when the SSH channel cannot open', async () => {
    const { conn, net } = await saveAndStart(LOCAL_DEF)
    const socket = fakeSocket()
    net.connHandler!(socket)
    conn.client.forwardOut.mock.calls[0][4](new Error('refused'))
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('fails to start when the local port cannot be bound', async () => {
    const def = (await handler('tunnels:save')({}, LOCAL_DEF, undefined)) as TunnelDef
    const net = primeCreateServer()
    net.server.listen.mockImplementation(() => {
      net.server.emit('error', new Error('EADDRINUSE'))
    })
    const conn = fakeConn()
    ;(connectSessionClient as Mock).mockResolvedValueOnce(conn)
    await expect(handler('tunnels:start')({}, def.id)).rejects.toThrow('Cannot listen on 127.0.0.1:15432')
    expect(conn.dispose).toHaveBeenCalled()
    expect(listTunnels().find((t) => t.id === def.id)?.status).toBe('stopped')
  })

  it('does not start the same tunnel twice', async () => {
    const { def } = await saveAndStart(LOCAL_DEF)
    await handler('tunnels:start')({}, def.id)
    expect(connectSessionClient).toHaveBeenCalledTimes(1)
  })
})

describe('dynamic (SOCKS5) forward', () => {
  function socksClient(net: NetState): FakeSocket {
    const socket = fakeSocket()
    net.connHandler!(socket)
    return socket
  }

  it('destroys sockets that do not speak SOCKS', async () => {
    const { net } = await saveAndStart(DYNAMIC_DEF)
    const socket = socksClient(net)
    socket.emit('data', Buffer.from([0x04, 0x01])) // SOCKS4, unsupported
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('negotiates no-auth and connects an IPv4 CONNECT request', async () => {
    const { conn, net } = await saveAndStart(DYNAMIC_DEF)
    const socket = socksClient(net)

    socket.emit('data', Buffer.from([0x05, 0x01, 0x00]))
    expect(socket.write).toHaveBeenCalledWith(socksGreetingReply())

    socket.emit('data', Buffer.from([0x05, 0x01, 0x00, 0x01, 10, 0, 0, 7, 0x00, 0x50]))
    expect(conn.client.forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '10.0.0.7', 80, expect.any(Function))

    const stream = fakeStream()
    conn.client.forwardOut.mock.calls[0][4](null, stream)
    expect(socket.write).toHaveBeenCalledWith(socksConnectReply(SOCKS_REPLY.success))
    expect(socket.pipe).toHaveBeenCalledWith(stream)
  })

  it('replies with an error code for unsupported SOCKS commands', async () => {
    const { conn, net } = await saveAndStart(DYNAMIC_DEF)
    const socket = socksClient(net)
    socket.emit('data', Buffer.from([0x05, 0x01, 0x00]))
    socket.emit('data', Buffer.from([0x05, 0x02, 0x00, 0x01, 10, 0, 0, 7, 0x00, 0x50])) // BIND
    expect(socket.end).toHaveBeenCalledWith(socksConnectReply(SOCKS_REPLY.commandNotSupported))
    expect(conn.client.forwardOut).not.toHaveBeenCalled()
  })

  it('replies connection-refused when the SSH channel cannot open', async () => {
    const { conn, net } = await saveAndStart(DYNAMIC_DEF)
    const socket = socksClient(net)
    socket.emit('data', Buffer.from([0x05, 0x01, 0x00]))
    socket.emit('data', Buffer.from([0x05, 0x01, 0x00, 0x01, 10, 0, 0, 7, 0x00, 0x50]))
    conn.client.forwardOut.mock.calls[0][4](new Error('no route'))
    expect(socket.end).toHaveBeenCalledWith(socksConnectReply(SOCKS_REPLY.connectionRefused))
  })

  it('destroys sockets on socket errors', async () => {
    const { net } = await saveAndStart(DYNAMIC_DEF)
    const socket = socksClient(net)
    socket.emit('error', new Error('reset'))
    expect(socket.destroy).toHaveBeenCalled()
  })
})

describe('remote forward', () => {
  it('asks the server to listen and pipes accepted connections to the local target', async () => {
    const conn = fakeConn()
    conn.client.forwardIn.mockImplementation((_h: string, _p: number, cb: (e?: Error) => void) => cb())
    const { def } = await saveAndStart(REMOTE_DEF, conn)
    expect(conn.client.forwardIn).toHaveBeenCalledWith('127.0.0.1', 9000, expect.any(Function))
    expect(listTunnels().find((t) => t.id === def.id)?.status).toBe('active')

    const channel = fakeStream()
    const local = fakeSocket()
    ;(netConnect as Mock).mockReturnValueOnce(local)
    conn.client.emit('tcp connection', {}, () => channel)
    expect(netConnect).toHaveBeenCalledWith(8080, 'localhost')

    local.emit('connect')
    expect(channel.pipe).toHaveBeenCalledWith(local)
    expect(local.pipe).toHaveBeenCalledWith(channel)
  })

  it('destroys the channel when the local connection fails', async () => {
    const conn = fakeConn()
    conn.client.forwardIn.mockImplementation((_h: string, _p: number, cb: (e?: Error) => void) => cb())
    await saveAndStart(REMOTE_DEF, conn)

    const channel = fakeStream()
    const local = fakeSocket()
    ;(netConnect as Mock).mockReturnValueOnce(local)
    conn.client.emit('tcp connection', {}, () => channel)
    local.emit('error', new Error('ECONNREFUSED'))
    expect(channel.destroy).toHaveBeenCalled()
  })

  it('rejects when the server refuses the remote listen', async () => {
    const def = (await handler('tunnels:save')({}, REMOTE_DEF, undefined)) as TunnelDef
    const conn = fakeConn()
    conn.client.forwardIn.mockImplementation((_h: string, _p: number, cb: (e?: Error) => void) => cb(new Error('denied')))
    ;(connectSessionClient as Mock).mockResolvedValueOnce(conn)
    await expect(handler('tunnels:start')({}, def.id)).rejects.toThrow('Server refused to listen on port 9000')
    expect(conn.dispose).toHaveBeenCalled()
  })
})

describe('lifecycle: stop, SSH drops, disposeAllTunnels', () => {
  it('tunnels:stop closes the listener, sockets, and connection', async () => {
    const { def, conn, net } = await saveAndStart(DYNAMIC_DEF)
    const socket = fakeSocket()
    net.connHandler!(socket)
    await handler('tunnels:stop')({}, def.id)
    expect(net.server.close).toHaveBeenCalled()
    expect(socket.destroy).toHaveBeenCalled()
    expect(conn.dispose).toHaveBeenCalled()
    expect(listTunnels().find((t) => t.id === def.id)?.status).toBe('stopped')
  })

  it('a dropped SSH connection tears the tunnel down', async () => {
    const { def, conn, net } = await saveAndStart(DYNAMIC_DEF)
    conn.client.emit('close')
    expect(net.server.close).toHaveBeenCalled()
    expect(listTunnels().find((t) => t.id === def.id)?.status).toBe('stopped')
  })

  it('an SSH error marks the tunnel as errored but keeps it listed', async () => {
    const { def, conn } = await saveAndStart(DYNAMIC_DEF)
    conn.client.emit('error', new Error('keepalive timeout'))
    const listed = listTunnels().find((t) => t.id === def.id)
    expect(listed?.status).toBe('error')
    expect(listed?.error).toBe('keepalive timeout')
  })

  it('updating an active tunnel stops it first', async () => {
    const { def, conn } = await saveAndStart(DYNAMIC_DEF)
    await handler('tunnels:save')({}, { ...DYNAMIC_DEF, listenPort: 1082 }, def.id)
    expect(conn.dispose).toHaveBeenCalled()
    expect(listTunnels().find((t) => t.id === def.id)?.status).toBe('stopped')
  })

  it('disposeAllTunnels stops every active tunnel', async () => {
    const a = await saveAndStart(DYNAMIC_DEF)
    const b = await saveAndStart(LOCAL_DEF)
    disposeAllTunnels()
    expect(a.conn.dispose).toHaveBeenCalled()
    expect(b.conn.dispose).toHaveBeenCalled()
    expect(a.net.server.close).toHaveBeenCalled()
    expect(b.net.server.close).toHaveBeenCalled()
    expect(listTunnels().every((t) => t.status === 'stopped')).toBe(true)
  })
})
