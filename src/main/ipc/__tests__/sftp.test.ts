import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events')
  const instances: unknown[] = []
  class Client extends EventEmitter {
    connect = vi.fn()
    end = vi.fn()
    sftp = vi.fn()
    constructor() {
      super()
      instances.push(this)
    }
  }
  return { Client, __clientInstances: instances }
})
vi.mock('../ssh', () => ({
  getOwnedSshClient: vi.fn(),
  sshConnectOptions: () => ({ readyTimeout: 1000, keepaliveInterval: 0, keepaliveCountMax: 1 }),
  SSH_CONNECT_DEFAULTS: { algorithms: { kex: [] } },
}))
vi.mock('../sshClients', () => ({
  connectSessionClient: vi.fn(),
  openJumpSocket: vi.fn(),
}))

import { ipcMain } from 'electron'
import * as ssh2 from 'ssh2'
import { getOwnedSshClient } from '../ssh'
import { connectSessionClient, openJumpSocket } from '../sshClients'
import { registerSftpHandlers, disposeSftpClientsForSender } from '../sftp'
import { ValidationError, NotFoundError, OwnershipError, ConnectionError } from '../errors'

registerSftpHandlers()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => any

function handler(channel: string): Handler {
  const call = (ipcMain.handle as Mock).mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No handler registered for ${channel}`)
  return call[1] as Handler
}

interface FakeClientInstance extends EventEmitter {
  connect: Mock
  end: Mock
  sftp: Mock
}

function lastClientInstance(): FakeClientInstance {
  const instances = (ssh2 as unknown as { __clientInstances: FakeClientInstance[] }).__clientInstances
  return instances[instances.length - 1]
}

interface FakeEvent {
  sender: { id: number; isDestroyed: () => boolean; send: Mock }
}

let senderSeq = 100
function makeEvent(): FakeEvent {
  return { sender: { id: senderSeq++, isDestroyed: () => false, send: vi.fn() } }
}

function fakeSftp() {
  return {
    readdir: vi.fn(),
    stat: vi.fn(),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    fastGet: vi.fn(),
    fastPut: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    chmod: vi.fn(),
  }
}

const BASE_CONFIG = { host: 'sftp.example.com', port: 22, username: 'deploy' }

/** Registers a client through the streamId fast-path (reuses an "owned" SSH client). */
async function connectViaStream(event: FakeEvent = makeEvent()) {
  const sftp = fakeSftp()
  const client = { sftp: vi.fn((cb: (e: Error | null, s: unknown) => void) => cb(null, sftp)), end: vi.fn() }
  ;(getOwnedSshClient as Mock).mockReturnValueOnce(client)
  const clientId = (await handler('sftp:connect')(event, { ...BASE_CONFIG, streamId: randomUUID() })) as string
  return { clientId, sftp, client, event }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('sftp:connect config validation', () => {
  const connectHandler = () => handler('sftp:connect')

  it('rejects non-object and malformed configs', () => {
    const event = makeEvent()
    expect(() => connectHandler()(event, null)).toThrow(ValidationError)
    expect(() => connectHandler()(event, { ...BASE_CONFIG, streamId: 'not-a-uuid' })).toThrow(ValidationError)
    expect(() => connectHandler()(event, { ...BASE_CONFIG, host: 'bad host!' })).toThrow()
    expect(() => connectHandler()(event, { ...BASE_CONFIG, port: 0 })).toThrow()
    expect(() => connectHandler()(event, { ...BASE_CONFIG, username: '' })).toThrow(ValidationError)
    expect(() => connectHandler()(event, { ...BASE_CONFIG, password: 5 })).toThrow(ValidationError)
    expect(() => connectHandler()(event, { ...BASE_CONFIG, password: 'x'.repeat(2000) })).toThrow(ValidationError)
    expect(() => connectHandler()(event, { ...BASE_CONFIG, privateKey: 5 })).toThrow(ValidationError)
    expect(() => connectHandler()(event, { ...BASE_CONFIG, privateKey: 'k'.repeat(65 * 1024) })).toThrow(ValidationError)
    expect(() => connectHandler()(event, { ...BASE_CONFIG, jumpHostId: 'j'.repeat(200) })).toThrow(ValidationError)
  })

  it('throws NotFoundError when the referenced SSH stream does not exist', async () => {
    ;(getOwnedSshClient as Mock).mockReturnValueOnce(undefined)
    await expect(async () => connectHandler()(makeEvent(), { ...BASE_CONFIG, streamId: randomUUID() }))
      .rejects.toBeInstanceOf(NotFoundError)
  })

  it('opens an sftp channel over an existing owned SSH stream', async () => {
    const { clientId } = await connectViaStream()
    expect(typeof clientId).toBe('string')
  })
})

describe('sftp:connect standalone client', () => {
  it('resolves once the client is ready and the sftp channel opens', async () => {
    const event = makeEvent()
    const pending = handler('sftp:connect')(event, { ...BASE_CONFIG, password: 'pw' }) as Promise<string>
    const client = lastClientInstance()
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: 'sftp.example.com',
      port: 22,
      username: 'deploy',
      password: 'pw',
      tryKeyboard: true,
    }))
    client.sftp.mockImplementation((cb: (e: Error | null, s: unknown) => void) => cb(null, fakeSftp()))
    client.emit('ready')
    await expect(pending).resolves.toEqual(expect.any(String))
  })

  it('rejects with ConnectionError on a client error and ignores later events', async () => {
    const event = makeEvent()
    const pending = handler('sftp:connect')(event, { ...BASE_CONFIG, password: 'pw' }) as Promise<string>
    const client = lastClientInstance()
    client.sftp.mockImplementation((cb: (e: Error | null, s: unknown) => void) => cb(null, fakeSftp()))
    client.emit('error', new Error('connection refused'))
    client.emit('ready') // settle() must ignore this second outcome
    await expect(pending).rejects.toBeInstanceOf(ConnectionError)
  })

  it('closes the client when the sftp channel fails after ready', async () => {
    const event = makeEvent()
    const pending = handler('sftp:connect')(event, { ...BASE_CONFIG, password: 'pw' }) as Promise<string>
    const client = lastClientInstance()
    client.sftp.mockImplementation((cb: (e: Error | null) => void) => cb(new Error('no sftp subsystem')))
    client.emit('ready')
    await expect(pending).rejects.toBeInstanceOf(ConnectionError)
    expect(client.end).toHaveBeenCalled()
  })

  it('answers keyboard-interactive prompts with the password', async () => {
    const event = makeEvent()
    const pending = handler('sftp:connect')(event, { ...BASE_CONFIG, password: 'pw' }) as Promise<string>
    const client = lastClientInstance()
    const finish = vi.fn()
    client.emit('keyboard-interactive', 'n', 'i', 'l', [{ prompt: 'Password:' }, { prompt: 'Verification:' }], finish)
    expect(finish).toHaveBeenCalledWith(['pw', 'pw'])
    client.sftp.mockImplementation((cb: (e: Error | null, s: unknown) => void) => cb(null, fakeSftp()))
    client.emit('ready')
    await pending
  })

  it('answers keyboard-interactive with no responses when there is no password', async () => {
    const event = makeEvent()
    const pending = handler('sftp:connect')(event, { ...BASE_CONFIG }) as Promise<string>
    const client = lastClientInstance()
    const finish = vi.fn()
    client.emit('keyboard-interactive', 'n', 'i', 'l', [{ prompt: 'Password:' }], finish)
    expect(finish).toHaveBeenCalledWith([])
    client.emit('error', new Error('auth failed'))
    await expect(pending).rejects.toBeInstanceOf(ConnectionError)
  })

  it('routes through a jump host and passes the socket to connect', async () => {
    const event = makeEvent()
    const upstream = { client: { fake: true }, dispose: vi.fn() }
    ;(connectSessionClient as Mock).mockResolvedValueOnce(upstream)
    ;(openJumpSocket as Mock).mockResolvedValueOnce('jump-sock')
    const pending = handler('sftp:connect')(event, { ...BASE_CONFIG, password: 'pw', jumpHostId: 'jump-1' }) as Promise<string>
    await vi.waitFor(() => expect(openJumpSocket).toHaveBeenCalledWith(upstream.client, 'sftp.example.com', 22))
    const client = lastClientInstance()
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ sock: 'jump-sock' }))
    client.sftp.mockImplementation((cb: (e: Error | null, s: unknown) => void) => cb(null, fakeSftp()))
    client.emit('ready')
    await pending
    expect(upstream.dispose).not.toHaveBeenCalled()
  })

  it('disposes the jump connection when the jump socket cannot open', async () => {
    const upstream = { client: {}, dispose: vi.fn() }
    ;(connectSessionClient as Mock).mockResolvedValueOnce(upstream)
    ;(openJumpSocket as Mock).mockRejectedValueOnce(new Error('jump refused'))
    await expect(handler('sftp:connect')(makeEvent(), { ...BASE_CONFIG, jumpHostId: 'jump-1' }))
      .rejects.toThrow('jump refused')
    expect(upstream.dispose).toHaveBeenCalled()
  })
})

describe('sftp:list', () => {
  it('maps directory entries with type and timestamps', async () => {
    const { clientId, sftp, event } = await connectViaStream()
    sftp.readdir.mockImplementation((_path: string, cb: (e: Error | null, list?: unknown[]) => void) =>
      cb(null, [
        { filename: 'notes.txt', attrs: { size: 5, mtime: 1000, mode: 0o100644 } },
        { filename: 'logs', attrs: { size: 0, mtime: 2000, mode: 0o040755 } },
      ]))
    const rows = await handler('sftp:list')(event, clientId, '/home/deploy')
    expect(rows).toEqual([
      { name: 'notes.txt', size: 5, mtime: 1_000_000, permissions: 0o100644, isDirectory: false },
      { name: 'logs', size: 0, mtime: 2_000_000, permissions: 0o040755, isDirectory: true },
    ])
  })

  it('wraps readdir failures in ConnectionError', async () => {
    const { clientId, sftp, event } = await connectViaStream()
    sftp.readdir.mockImplementation((_path: string, cb: (e: Error | null) => void) => cb(new Error('Permission denied')))
    await expect(handler('sftp:list')(event, clientId, '/root')).rejects.toBeInstanceOf(ConnectionError)
  })

  it('validates path and client id, and enforces ownership', async () => {
    const { clientId, event } = await connectViaStream()
    expect(() => handler('sftp:list')(event, clientId, '')).toThrow(ValidationError)
    expect(() => handler('sftp:list')(event, clientId, 'a\0b')).toThrow(ValidationError)
    expect(() => handler('sftp:list')(event, 'not-a-uuid', '/tmp')).toThrow(ValidationError)
    expect(() => handler('sftp:list')(event, randomUUID(), '/tmp')).toThrow(NotFoundError)
    expect(() => handler('sftp:list')(makeEvent(), clientId, '/tmp')).toThrow(OwnershipError)
  })
})

describe('sftp:readFile', () => {
  function statOk(sftp: ReturnType<typeof fakeSftp>, size = 10): void {
    sftp.stat.mockImplementation((_p: string, cb: (e: Error | null, s?: unknown) => void) => cb(null, { size }))
  }

  it('reads a small text file', async () => {
    const { clientId, sftp, event } = await connectViaStream()
    statOk(sftp)
    const stream = new EventEmitter()
    sftp.createReadStream.mockReturnValue(stream)
    const pending = handler('sftp:readFile')(event, clientId, '/etc/motd') as Promise<string>
    stream.emit('data', Buffer.from('hello '))
    stream.emit('data', Buffer.from('world'))
    stream.emit('end')
    await expect(pending).resolves.toBe('hello world')
  })

  it('rejects when stat fails', async () => {
    const { clientId, sftp, event } = await connectViaStream()
    sftp.stat.mockImplementation((_p: string, cb: (e: Error | null) => void) => cb(new Error('No such file')))
    await expect(handler('sftp:readFile')(event, clientId, '/missing')).rejects.toBeInstanceOf(ConnectionError)
  })

  it('refuses binary files by extension before streaming', async () => {
    const { clientId, sftp, event } = await connectViaStream()
    statOk(sftp)
    await expect(handler('sftp:readFile')(event, clientId, '/pics/photo.png'))
      .rejects.toBeInstanceOf(ValidationError)
    expect(sftp.createReadStream).not.toHaveBeenCalled()
  })

  it('refuses files that sniff as binary (null byte in first 8KB)', async () => {
    const { clientId, sftp, event } = await connectViaStream()
    statOk(sftp)
    const stream = new EventEmitter()
    sftp.createReadStream.mockReturnValue(stream)
    const pending = handler('sftp:readFile')(event, clientId, '/bin/data')
    stream.emit('data', Buffer.from([0x41, 0x00, 0x42]))
    stream.emit('end')
    await expect(pending).rejects.toBeInstanceOf(ValidationError)
  })

  it('wraps read stream errors in ConnectionError', async () => {
    const { clientId, sftp, event } = await connectViaStream()
    statOk(sftp)
    const stream = new EventEmitter()
    sftp.createReadStream.mockReturnValue(stream)
    const pending = handler('sftp:readFile')(event, clientId, '/etc/motd')
    stream.emit('error', new Error('read reset'))
    await expect(pending).rejects.toBeInstanceOf(ConnectionError)
  })
})

describe('sftp:writeFile', () => {
  it('writes content and resolves on finish', async () => {
    const { clientId, sftp, event } = await connectViaStream()
    const stream = new EventEmitter() as EventEmitter & { end: Mock }
    stream.end = vi.fn(() => stream.emit('finish'))
    sftp.createWriteStream.mockReturnValue(stream)
    await expect(handler('sftp:writeFile')(event, clientId, '/tmp/out.txt', 'data')).resolves.toBe(true)
    expect(stream.end).toHaveBeenCalledWith(Buffer.from('data', 'utf8'))
  })

  it('rejects invalid content and stream errors', async () => {
    const { clientId, sftp, event } = await connectViaStream()
    expect(() => handler('sftp:writeFile')(event, clientId, '/tmp/out.txt', 42)).toThrow(ValidationError)
    const stream = new EventEmitter() as EventEmitter & { end: Mock }
    stream.end = vi.fn(() => stream.emit('error', new Error('disk full')))
    sftp.createWriteStream.mockReturnValue(stream)
    await expect(handler('sftp:writeFile')(event, clientId, '/tmp/out.txt', 'data')).rejects.toBeInstanceOf(ConnectionError)
  })
})

describe('sftp:disconnect and sender cleanup', () => {
  it('validates ownership on disconnect', async () => {
    const { clientId } = await connectViaStream()
    expect(() => handler('sftp:disconnect')(makeEvent(), clientId)).toThrow(OwnershipError)
  })

  it('ignores disconnects for unknown clients', () => {
    expect(handler('sftp:disconnect')(makeEvent(), randomUUID())).toBeUndefined()
  })

  it('does not end a shared (stream-backed) client on disconnect', async () => {
    const { clientId, client, event } = await connectViaStream()
    handler('sftp:disconnect')(event, clientId)
    expect(client.end).not.toHaveBeenCalled()
    expect(() => handler('sftp:list')(event, clientId, '/tmp')).toThrow(NotFoundError)
  })

  it('ends owned clients when their sender goes away', async () => {
    const event = makeEvent()
    const pending = handler('sftp:connect')(event, { ...BASE_CONFIG, password: 'pw' }) as Promise<string>
    const client = lastClientInstance()
    client.sftp.mockImplementation((cb: (e: Error | null, s: unknown) => void) => cb(null, fakeSftp()))
    client.emit('ready')
    const clientId = await pending
    disposeSftpClientsForSender(event.sender.id)
    expect(client.end).toHaveBeenCalled()
    expect(() => handler('sftp:list')(event, clientId, '/tmp')).toThrow(NotFoundError)
  })
})
