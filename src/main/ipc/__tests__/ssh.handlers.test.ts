import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const { ipc, fakeSsh } = vi.hoisted(() => ({
  ipc: {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    listeners: new Map<string, (...args: unknown[]) => unknown>(),
  },
  fakeSsh: { clients: [] as FakeSshClient[] },
}))

interface FakeShellStream extends EventEmitter {
  stderr: EventEmitter
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  setWindow: ReturnType<typeof vi.fn>
}

interface FakeSshClient extends EventEmitter {
  connectConfig: unknown
  shellImpl: (opts: unknown, cb: (err: Error | null, stream?: unknown) => void) => void
  execCalls: Array<{ command: string; cb: (err: Error | null, channel?: unknown) => void }>
  lastShellStream: FakeShellStream | undefined
  end: ReturnType<typeof vi.fn>
  setNoDelay: ReturnType<typeof vi.fn>
  connect: (config: unknown) => void
  shell: (opts: unknown, cb: (err: Error | null, stream?: unknown) => void) => void
  exec: (command: string, cb: (err: Error | null, channel?: unknown) => void) => void
}

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipc.handlers.set(channel, fn)
    }),
    on: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipc.listeners.set(channel, fn)
    }),
  },
}))
vi.mock('electron-store', () => ({
  default: class MockStore {
    private data = new Map<string, unknown>()
    get(key: string) { return this.data.get(key) }
    set(key: string, value: unknown) { this.data.set(key, value) }
  },
}))

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events')

  function makeShellStream(): FakeShellStream {
    const stream = new EventEmitter() as FakeShellStream
    stream.stderr = new EventEmitter()
    stream.write = vi.fn()
    stream.end = vi.fn()
    stream.setWindow = vi.fn()
    return stream
  }

  class FakeClient extends EventEmitter {
    connectConfig: unknown
    shellImpl: (opts: unknown, cb: (err: Error | null, stream?: unknown) => void) => void
    execCalls: Array<{ command: string; cb: (err: Error | null, channel?: unknown) => void }> = []
    lastShellStream: FakeShellStream | undefined
    end = vi.fn()
    setNoDelay = vi.fn()

    constructor() {
      super()
      this.shellImpl = (_opts, cb) => {
        this.lastShellStream = makeShellStream()
        cb(null, this.lastShellStream)
      }
      fakeSsh.clients.push(this as unknown as FakeSshClient)
    }

    connect(config: unknown): void {
      this.connectConfig = config
    }

    shell(opts: unknown, cb: (err: Error | null, stream?: unknown) => void): void {
      this.shellImpl(opts, cb)
    }

    exec(command: string, cb: (err: Error | null, channel?: unknown) => void): void {
      this.execCalls.push({ command, cb })
    }
  }

  return { Client: FakeClient }
})

vi.mock('../sshClients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sshClients')>()
  return {
    ...actual,
    connectSessionClient: vi.fn(),
    openJumpSocket: vi.fn(),
  }
})

import { registerSshHandlers, getOwnedSshClient, disposeSshStreamsForSender } from '../ssh'
import { connectSessionClient, openJumpSocket } from '../sshClients'
import { METRICS_COMMAND } from '../metrics'
import { ValidationError, OwnershipError, ConnectionError } from '../errors'

registerSshHandlers()

const LINUX_METRICS_OUTPUT = [
  'cpu  100 0 100 700 100 0 0 0 0 0',
  '::MEM::MemTotal:        4096000 kB',
  'MemAvailable:    1024000 kB',
  '::DISK::/dev/vda1  102400000 51200000 51200000  50% /',
  '::LOAD::0.42 0.36 0.30 1/123 4567',
  '::UP::123456.78 654321.00',
].join('\n')

let nextSenderId = 1

interface FakeEvent {
  sender: {
    id: number
    isDestroyed: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
  }
}

function makeEvent(): FakeEvent {
  return {
    sender: {
      id: nextSenderId++,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  }
}

const VALID_CONFIG = { host: 'example.com', port: 22, username: 'deploy', password: 'pw' }

function invokeConnect(event: FakeEvent, config: unknown = VALID_CONFIG): Promise<string> {
  const handler = ipc.handlers.get('ssh:connect')
  if (!handler) throw new Error('ssh:connect handler not registered')
  return handler(event, config) as Promise<string>
}

async function connect(event: FakeEvent = makeEvent()) {
  const pending = invokeConnect(event)
  const client = fakeSsh.clients.at(-1)
  if (!client) throw new Error('no ssh client created')
  client.emit('ready')
  const streamId = await pending
  const stream = client.lastShellStream
  if (!stream) throw new Error('no shell stream opened')
  return { streamId, client, stream, event }
}

function makeExecChannel(): FakeShellStream {
  const chan = new EventEmitter() as FakeShellStream
  chan.stderr = new EventEmitter()
  chan.write = vi.fn()
  chan.end = vi.fn()
  chan.setWindow = vi.fn()
  return chan
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ssh:connect', () => {
  it('resolves with a stream id once the shell is open', async () => {
    const { streamId, client } = await connect()
    expect(streamId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(client.setNoDelay).toHaveBeenCalledWith(true)
    expect(client.connectConfig).toMatchObject({
      host: 'example.com',
      port: 22,
      username: 'deploy',
      password: 'pw',
      tryKeyboard: true,
    })
  })

  it('forwards stdout and stderr shell data to the renderer', async () => {
    const { streamId, stream, event } = await connect()
    stream.emit('data', Buffer.from('hello'))
    stream.stderr.emit('data', Buffer.from('oops'))
    expect(event.sender.send).toHaveBeenCalledWith('ssh:data', streamId, 'hello')
    expect(event.sender.send).toHaveBeenCalledWith('ssh:data', streamId, 'oops')
  })

  it('does not send data to a destroyed renderer', async () => {
    const { stream, event } = await connect()
    event.sender.isDestroyed.mockReturnValue(true)
    stream.emit('data', Buffer.from('late'))
    expect(event.sender.send).not.toHaveBeenCalled()
  })

  it('notifies the renderer and cleans up when the shell stream closes', async () => {
    const { streamId, stream, event } = await connect()
    stream.emit('close')
    expect(event.sender.send).toHaveBeenCalledWith('ssh:closed', streamId)

    // The stream is gone: further writes are ignored
    ipc.listeners.get('ssh:data')?.(event, streamId, 'ls\n')
    expect(stream.write).not.toHaveBeenCalled()
  })

  it('rejects with a ConnectionError when opening the shell fails', async () => {
    const event = makeEvent()
    const pending = invokeConnect(event)
    const client = fakeSsh.clients.at(-1)
    if (!client) throw new Error('no ssh client created')
    client.shellImpl = (_opts, cb) => cb(new Error('no shell for you'))
    client.emit('ready')
    await expect(pending).rejects.toThrow(ConnectionError)
    await expect(pending).rejects.toThrow('no shell for you')
    expect(client.end).toHaveBeenCalled()
  })

  it('rejects with a ConnectionError when the client errors before ready', async () => {
    const event = makeEvent()
    const pending = invokeConnect(event)
    const client = fakeSsh.clients.at(-1)
    if (!client) throw new Error('no ssh client created')
    client.emit('error', new Error('ECONNREFUSED'))
    await expect(pending).rejects.toThrow(ConnectionError)
  })

  it('settles only once when error follows ready', async () => {
    const { streamId, client, event } = await connect()
    client.emit('error', new Error('connection reset'))
    expect(event.sender.send).toHaveBeenCalledWith('ssh:closed', streamId)
    expect(client.end).toHaveBeenCalled()

    // Stream is unregistered after the late error
    ipc.listeners.get('ssh:data')?.(event, streamId, 'x')
    expect(client.lastShellStream?.write).not.toHaveBeenCalled()
  })

  it('answers keyboard-interactive prompts with the configured password', async () => {
    const event = makeEvent()
    const pending = invokeConnect(event)
    const client = fakeSsh.clients.at(-1)
    if (!client) throw new Error('no ssh client created')
    const finish = vi.fn()
    client.emit('keyboard-interactive', '', '', '', ['Password:', 'Again:'], finish)
    expect(finish).toHaveBeenCalledWith(['pw', 'pw'])
    client.emit('ready')
    await expect(pending).resolves.toBeTruthy()
  })

  it('answers keyboard-interactive with an empty list when no password is set', async () => {
    const event = makeEvent()
    void invokeConnect(event, { host: 'example.com', port: 22, username: 'deploy' })
    const client = fakeSsh.clients.at(-1)
    if (!client) throw new Error('no ssh client created')
    const finish = vi.fn()
    client.emit('keyboard-interactive', '', '', '', ['Password:'], finish)
    expect(finish).toHaveBeenCalledWith([])
  })

  it('rejects malformed configs', async () => {
    const event = makeEvent()
    await expect(invokeConnect(event, null)).rejects.toThrow(ValidationError)
    await expect(invokeConnect(event, { host: 'example.com', port: 22, username: '' })).rejects.toThrow(ValidationError)
    await expect(invokeConnect(event, { host: 'example.com', port: 22, username: 'u', password: 42 })).rejects.toThrow(ValidationError)
    await expect(invokeConnect(event, { host: 'example.com', port: 22, username: 'u', privateKey: 42 })).rejects.toThrow(ValidationError)
    await expect(invokeConnect(event, { host: 'example.com', port: 22, username: 'u', privateKey: 'k'.repeat(65 * 1024) })).rejects.toThrow(ValidationError)
    await expect(invokeConnect(event, { host: 'example.com', port: 22, username: 'u', password: 'p'.repeat(2048) })).rejects.toThrow(ValidationError)
    await expect(invokeConnect(event, { host: 'example.com', port: 22, username: 'u', jumpHostId: 42 })).rejects.toThrow(ValidationError)
    await expect(invokeConnect(event, { host: 'bad host!', port: 22, username: 'u' })).rejects.toThrow()
    await expect(invokeConnect(event, { host: 'example.com', port: 0, username: 'u' })).rejects.toThrow()
  })
})

describe('ssh:connect through a jump host', () => {
  it('resolves the bastion in main and tunnels the leaf connection through it', async () => {
    const upstream = { client: {} as never, dispose: vi.fn() }
    const sock = { jump: 'socket' }
    vi.mocked(connectSessionClient).mockResolvedValue(upstream)
    vi.mocked(openJumpSocket).mockResolvedValue(sock as never)

    const event = makeEvent()
    const pending = invokeConnect(event, { ...VALID_CONFIG, jumpHostId: 'bastion-session' })
    // Let the awaited bastion connection settle so the leaf client is created
    await new Promise((r) => setImmediate(r))

    expect(connectSessionClient).toHaveBeenCalledWith('bastion-session')
    expect(openJumpSocket).toHaveBeenCalledWith(upstream.client, 'example.com', 22)

    const client = fakeSsh.clients.at(-1)
    if (!client) throw new Error('no ssh client created')
    client.emit('ready')
    const streamId = await pending
    expect((client.connectConfig as { sock?: unknown }).sock).toBe(sock)

    // Closing the leaf shell tears down the bastion chain too
    client.lastShellStream?.emit('close')
    expect(upstream.dispose).toHaveBeenCalled()
    expect(event.sender.send).toHaveBeenCalledWith('ssh:closed', streamId)
  })

  it('disposes the bastion when the jump socket cannot be opened', async () => {
    const upstream = { client: {} as never, dispose: vi.fn() }
    vi.mocked(connectSessionClient).mockResolvedValue(upstream)
    vi.mocked(openJumpSocket).mockRejectedValue(new ConnectionError('jump host unreachable'))

    const event = makeEvent()
    await expect(invokeConnect(event, { ...VALID_CONFIG, jumpHostId: 'bastion-session' }))
      .rejects.toThrow('jump host unreachable')
    expect(upstream.dispose).toHaveBeenCalled()
  })

  it('disposes the bastion when the leaf connection fails', async () => {
    const upstream = { client: {} as never, dispose: vi.fn() }
    vi.mocked(connectSessionClient).mockResolvedValue(upstream)
    vi.mocked(openJumpSocket).mockResolvedValue({} as never)

    const event = makeEvent()
    const pending = invokeConnect(event, { ...VALID_CONFIG, jumpHostId: 'bastion-session' })
    await new Promise((r) => setImmediate(r))
    const client = fakeSsh.clients.at(-1)
    if (!client) throw new Error('no ssh client created')
    client.emit('error', new Error('auth failed'))
    await expect(pending).rejects.toThrow(ConnectionError)
    expect(upstream.dispose).toHaveBeenCalled()
  })
})

describe('ssh:data and ssh:resize', () => {
  it('writes renderer input to the shell stream', async () => {
    const { streamId, stream, event } = await connect()
    ipc.listeners.get('ssh:data')?.(event, streamId, 'ls -la\n')
    expect(stream.write).toHaveBeenCalledWith('ls -la\n')
  })

  it('silently drops invalid stream ids, oversized payloads, and foreign senders', async () => {
    const { streamId, stream, event } = await connect()
    const dataListener = ipc.listeners.get('ssh:data')
    dataListener?.(event, 'not-a-uuid', 'x')
    dataListener?.(event, streamId, 'y'.repeat(65 * 1024))
    dataListener?.(makeEvent(), streamId, 'stolen input')
    expect(stream.write).not.toHaveBeenCalled()
  })

  it('resizes the pty via setWindow', async () => {
    const { streamId, stream, event } = await connect()
    ipc.listeners.get('ssh:resize')?.(event, streamId, 120, 40)
    expect(stream.setWindow).toHaveBeenCalledWith(40, 120, 0, 0)
  })

  it('rethrows unexpected internal errors instead of swallowing them', async () => {
    const { streamId } = await connect()
    const broken = { sender: null } as never
    expect(() => ipc.listeners.get('ssh:data')?.(broken, streamId, 'x')).toThrow(TypeError)
    expect(() => ipc.listeners.get('ssh:resize')?.(broken, streamId, 80, 24)).toThrow(TypeError)
    expect(() => ipc.listeners.get('ssh:metrics-stop')?.(broken, streamId)).toThrow(TypeError)
  })

  it('ignores invalid dimensions', async () => {
    const { streamId, stream, event } = await connect()
    const resize = ipc.listeners.get('ssh:resize')
    resize?.(event, streamId, 0, 40)
    resize?.(event, streamId, 120, 1001)
    resize?.(event, streamId, 1.5, 40)
    expect(stream.setWindow).not.toHaveBeenCalled()
  })
})

describe('ssh:disconnect and ownership', () => {
  it('ends the stream and the client', async () => {
    const { streamId, stream, client, event } = await connect()
    ipc.handlers.get('ssh:disconnect')?.(event, streamId)
    expect(stream.end).toHaveBeenCalled()
    expect(client.end).toHaveBeenCalled()
  })

  it('throws OwnershipError when another window tries to disconnect', async () => {
    const { streamId } = await connect()
    expect(() => ipc.handlers.get('ssh:disconnect')?.(makeEvent(), streamId)).toThrow(OwnershipError)
  })

  it('getOwnedSshClient returns the client for the owner and validates ids', async () => {
    const { streamId, client, event } = await connect()
    expect(getOwnedSshClient(event as never, streamId)).toBe(client)
    expect(getOwnedSshClient(event as never, '11111111-1111-4111-8111-111111111111')).toBeUndefined()
    expect(() => getOwnedSshClient(event as never, 'nope')).toThrow(ValidationError)
    expect(() => getOwnedSshClient(makeEvent() as never, streamId)).toThrow(OwnershipError)
  })

  it('disposeSshStreamsForSender disposes every stream owned by that sender', async () => {
    const { stream, client, event } = await connect()
    const other = await connect()
    disposeSshStreamsForSender(event.sender.id)
    expect(stream.end).toHaveBeenCalled()
    expect(client.end).toHaveBeenCalled()
    expect(other.stream.end).not.toHaveBeenCalled()
  })
})

describe('ssh metrics polling', () => {
  it('fetches metrics immediately and emits parsed results to the renderer', async () => {
    vi.useFakeTimers()
    const { streamId, client, event } = await connect()

    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)
    expect(client.execCalls).toHaveLength(1)
    expect(client.execCalls[0].command).toBe(METRICS_COMMAND)

    const chan = makeExecChannel()
    client.execCalls[0].cb(null, chan)
    chan.emit('data', Buffer.from(LINUX_METRICS_OUTPUT))
    chan.stderr.emit('data', Buffer.from('cat: /proc/stat: No such file'))
    chan.emit('close')

    expect(event.sender.send).toHaveBeenCalledWith(
      'ssh:metrics',
      streamId,
      expect.objectContaining({ available: true, memTotal: 4096000 * 1024, load1: 0.42 })
    )
  })

  it('computes a CPU delta on the second sample', async () => {
    vi.useFakeTimers()
    const { streamId, client, event } = await connect()
    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)

    const first = makeExecChannel()
    client.execCalls[0].cb(null, first)
    first.emit('data', Buffer.from(LINUX_METRICS_OUTPUT))
    first.emit('close')

    vi.advanceTimersByTime(2000)
    expect(client.execCalls).toHaveLength(2)
    const second = makeExecChannel()
    client.execCalls[1].cb(null, second)
    // 1000 more jiffies, 200 of them idle → 80% busy
    second.emit('data', Buffer.from(LINUX_METRICS_OUTPUT.replace(
      'cpu  100 0 100 700 100 0 0 0 0 0',
      'cpu  500 0 500 850 150 0 0 0 0 0',
    )))
    second.emit('close')

    const metricsCalls = event.sender.send.mock.calls.filter((c) => c[0] === 'ssh:metrics')
    expect(metricsCalls).toHaveLength(2)
    expect(metricsCalls[0][2].cpu).toBe(0)
    expect(metricsCalls[1][2].cpu).toBe(80)
  })

  it('skips overlapping fetches while one is in flight, then resumes on the interval', async () => {
    vi.useFakeTimers()
    const { streamId, client, event } = await connect()
    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)
    expect(client.execCalls).toHaveLength(1)

    // First exec never completes: the 2s and 5s timers must not stack requests
    vi.advanceTimersByTime(7000)
    expect(client.execCalls).toHaveLength(1)

    const chan = makeExecChannel()
    client.execCalls[0].cb(null, chan)
    chan.emit('data', Buffer.from(LINUX_METRICS_OUTPUT))
    chan.emit('close')

    vi.advanceTimersByTime(5000)
    expect(client.execCalls).toHaveLength(2)
  })

  it('clears the in-flight flag when exec itself fails', async () => {
    vi.useFakeTimers()
    const { streamId, client, event } = await connect()
    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)
    client.execCalls[0].cb(new Error('exec failed'))

    vi.advanceTimersByTime(5000)
    expect(client.execCalls).toHaveLength(2)
  })

  it('logs and recovers when the metrics channel errors', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { streamId, client, event } = await connect()
    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)

    const chan = makeExecChannel()
    client.execCalls[0].cb(null, chan)
    chan.emit('error', new Error('channel torn down'))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('metrics exec'))

    vi.advanceTimersByTime(5000)
    expect(client.execCalls).toHaveLength(2)
  })

  it('logs instead of crashing when emitting metrics throws', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { streamId, client, event } = await connect()
    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)

    event.sender.send.mockImplementationOnce(() => { throw new Error('renderer gone') })
    const chan = makeExecChannel()
    client.execCalls[0].cb(null, chan)
    chan.emit('data', Buffer.from(LINUX_METRICS_OUTPUT))
    chan.emit('close')

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('metrics parse'))
  })

  it('stops polling on ssh:metrics-stop', async () => {
    vi.useFakeTimers()
    const { streamId, client, event } = await connect()
    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)
    const chan = makeExecChannel()
    client.execCalls[0].cb(null, chan)
    chan.emit('close')

    ipc.listeners.get('ssh:metrics-stop')?.(event, streamId)
    vi.advanceTimersByTime(60_000)
    expect(client.execCalls).toHaveLength(1)
  })

  it('ignores metrics-stop for invalid ids and foreign senders', async () => {
    vi.useFakeTimers()
    const { streamId, client, event } = await connect()
    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)
    const chan = makeExecChannel()
    client.execCalls[0].cb(null, chan)
    chan.emit('close')

    const stop = ipc.listeners.get('ssh:metrics-stop')
    stop?.(event, 'not-a-uuid')
    stop?.(makeEvent(), streamId)

    // Polling continues because neither call was allowed to stop it
    vi.advanceTimersByTime(2000)
    expect(client.execCalls).toHaveLength(2)
  })

  it('stops polling when the stream is disconnected', async () => {
    vi.useFakeTimers()
    const { streamId, client, event } = await connect()
    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)
    const chan = makeExecChannel()
    client.execCalls[0].cb(null, chan)
    chan.emit('close')

    ipc.handlers.get('ssh:disconnect')?.(event, streamId)
    vi.advanceTimersByTime(60_000)
    expect(client.execCalls).toHaveLength(1)
  })

  it('does nothing when metrics-start targets an unknown stream', async () => {
    const { event } = await connect()
    ipc.handlers.get('ssh:metrics-start')?.(event, '11111111-1111-4111-8111-111111111111')
    expect(() => ipc.handlers.get('ssh:metrics-start')?.(event, 'bogus')).toThrow(ValidationError)
  })

  it('restarting metrics replaces the previous timers', async () => {
    vi.useFakeTimers()
    const { streamId, client, event } = await connect()
    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)
    const first = makeExecChannel()
    client.execCalls[0].cb(null, first)
    first.emit('close')

    // Restart clears the old timers and fetches again immediately
    ipc.handlers.get('ssh:metrics-start')?.(event, streamId)
    expect(client.execCalls).toHaveLength(2)
    const second = makeExecChannel()
    client.execCalls[1].cb(null, second)
    second.emit('close')

    vi.advanceTimersByTime(2000)
    expect(client.execCalls).toHaveLength(3)
  })
})
