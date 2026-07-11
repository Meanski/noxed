import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const { ipc } = vi.hoisted(() => ({
  ipc: {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    listeners: new Map<string, (...args: unknown[]) => unknown>(),
  },
}))

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

vi.mock('../sshClients', () => ({
  connectSessionClient: vi.fn(),
}))

vi.mock('../sessions', () => ({
  getSessionById: vi.fn(),
}))

import { registerRunnerHandlers, disposeRunsForSender } from '../runner'
import { connectSessionClient } from '../sshClients'
import { getSessionById } from '../sessions'
import type { Session } from '../sessions'
import { NotFoundError, OwnershipError, ValidationError } from '../errors'

registerRunnerHandlers()

interface FakeExecStream extends EventEmitter {
  stderr: EventEmitter
}

interface FakeConn {
  client: { exec: (command: string, cb: (err: Error | null, stream?: FakeExecStream) => void) => void }
  dispose: ReturnType<typeof vi.fn>
  execCalls: Array<{ command: string; cb: (err: Error | null, stream?: FakeExecStream) => void }>
}

function makeStream(): FakeExecStream {
  const stream = new EventEmitter() as FakeExecStream
  stream.stderr = new EventEmitter()
  return stream
}

function makeConn(): FakeConn {
  const execCalls: FakeConn['execCalls'] = []
  return {
    execCalls,
    dispose: vi.fn(),
    client: {
      exec: (command, cb) => {
        execCalls.push({ command, cb })
      },
    },
  }
}

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

function sshSession(id: string): Session {
  return { id, label: id, host: `${id}.example.com`, port: 22, username: 'deploy', authType: 'password', createdAt: 0, type: 'ssh' }
}

function run(event: FakeEvent, sessionIds: unknown = ['s1'], command: unknown = 'uptime'): string {
  const handler = ipc.handlers.get('runner:run')
  if (!handler) throw new Error('runner:run handler not registered')
  return handler(event, sessionIds, command) as string
}

function cancel(event: FakeEvent, runId: unknown): unknown {
  const handler = ipc.handlers.get('runner:cancel')
  if (!handler) throw new Error('runner:cancel handler not registered')
  return handler(event, runId)
}

// Flushes the microtask hops inside runOnHost without relying on real timers
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function doneCalls(event: FakeEvent) {
  return event.sender.send.mock.calls.filter((c) => c[0] === 'runner:done')
}

function outputCalls(event: FakeEvent) {
  return event.sender.send.mock.calls.filter((c) => c[0] === 'runner:output')
}

beforeEach(() => {
  vi.mocked(getSessionById).mockReset()
  vi.mocked(getSessionById).mockImplementation((id: string) => sshSession(id))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(connectSessionClient).mockReset()
})

describe('runner:run validation', () => {
  it('rejects when a session does not exist', () => {
    vi.mocked(getSessionById).mockReturnValue(undefined)
    expect(() => run(makeEvent())).toThrow(NotFoundError)
  })

  it('rejects non-SSH sessions, naming them by label or host', () => {
    vi.mocked(getSessionById).mockReturnValue({ ...sshSession('db1'), type: 'database' })
    expect(() => run(makeEvent(), ['db1'])).toThrow(ValidationError)
    expect(() => run(makeEvent(), ['db1'])).toThrow('db1 is not an SSH connection')

    vi.mocked(getSessionById).mockReturnValue({ ...sshSession('db1'), label: '', type: 'redis' })
    expect(() => run(makeEvent(), ['db1'])).toThrow('db1.example.com is not an SSH connection')
  })

  it('rejects malformed requests before touching sessions', () => {
    expect(() => run(makeEvent(), [], 'uptime')).toThrow(ValidationError)
    expect(() => run(makeEvent(), ['s1'], '  ')).toThrow(ValidationError)
    expect(getSessionById).not.toHaveBeenCalled()
  })

  it('accepts sessions without an explicit type as SSH', async () => {
    vi.mocked(getSessionById).mockReturnValue({ ...sshSession('s1'), type: undefined })
    vi.mocked(connectSessionClient).mockResolvedValue(makeConn() as never)
    expect(run(makeEvent())).toMatch(/^[0-9a-f-]{36}$/i)
    await flush()
  })
})

describe('runner:run execution', () => {
  it('executes the command per host and streams stdout/stderr to the renderer', async () => {
    const conn = makeConn()
    vi.mocked(connectSessionClient).mockResolvedValue(conn as never)
    const event = makeEvent()

    const runId = run(event, ['s1'], 'uptime')
    expect(runId).toMatch(/^[0-9a-f-]{36}$/i)
    await flush()

    expect(connectSessionClient).toHaveBeenCalledWith('s1')
    expect(conn.execCalls).toHaveLength(1)
    expect(conn.execCalls[0].command).toBe('uptime')

    const stream = makeStream()
    conn.execCalls[0].cb(null, stream)
    stream.emit('data', Buffer.from('load average'))
    stream.stderr.emit('data', Buffer.from('a warning'))

    expect(event.sender.send).toHaveBeenCalledWith('runner:output', runId, 's1', 'load average')
    expect(event.sender.send).toHaveBeenCalledWith('runner:output', runId, 's1', 'a warning')

    stream.emit('close', 0)
    expect(event.sender.send).toHaveBeenCalledWith('runner:done', runId, 's1', 0, null)
    expect(conn.dispose).toHaveBeenCalled()
  })

  it('runs on every host and reports each outcome independently', async () => {
    const conns = [makeConn(), makeConn()]
    let next = 0
    vi.mocked(connectSessionClient).mockImplementation(async () => conns[next++] as never)
    const event = makeEvent()

    const runId = run(event, ['s1', 's2'], 'hostname')
    await flush()

    const streamA = makeStream()
    conns[0].execCalls[0].cb(null, streamA)
    streamA.emit('close', 0)

    const streamB = makeStream()
    conns[1].execCalls[0].cb(null, streamB)
    streamB.emit('error', new Error('broken pipe'))

    expect(event.sender.send).toHaveBeenCalledWith('runner:done', runId, 's1', 0, null)
    expect(event.sender.send).toHaveBeenCalledWith('runner:done', runId, 's2', null, 'broken pipe')

    // All hosts finished, so the run is gone: cancelling is a silent no-op
    expect(cancel(makeEvent(), runId)).toBeUndefined()
  })

  it('reports a connection failure without an exit code', async () => {
    vi.mocked(connectSessionClient).mockRejectedValue(new Error('no route to host'))
    const event = makeEvent()
    const runId = run(event)
    await flush()
    expect(event.sender.send).toHaveBeenCalledWith('runner:done', runId, 's1', null, 'no route to host')
  })

  it('reports an exec failure and disposes the connection', async () => {
    const conn = makeConn()
    vi.mocked(connectSessionClient).mockResolvedValue(conn as never)
    const event = makeEvent()
    const runId = run(event)
    await flush()

    conn.execCalls[0].cb(new Error('exec rejected by server'))
    expect(event.sender.send).toHaveBeenCalledWith('runner:done', runId, 's1', null, 'exec rejected by server')
    expect(conn.dispose).toHaveBeenCalled()
  })

  it('times out after 120s and ignores the late close', async () => {
    vi.useFakeTimers()
    const conn = makeConn()
    vi.mocked(connectSessionClient).mockResolvedValue(conn as never)
    const event = makeEvent()
    const runId = run(event)
    await flush()

    const stream = makeStream()
    conn.execCalls[0].cb(null, stream)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(event.sender.send).toHaveBeenCalledWith('runner:done', runId, 's1', null, 'Timed out after 120s')

    // The eventual close of the dead stream must not double-report the host
    stream.emit('close', 0)
    expect(doneCalls(event)).toHaveLength(1)
  })

  it('stops forwarding output past the per-host cap', async () => {
    const conn = makeConn()
    vi.mocked(connectSessionClient).mockResolvedValue(conn as never)
    const event = makeEvent()
    run(event)
    await flush()

    const stream = makeStream()
    conn.execCalls[0].cb(null, stream)
    stream.emit('data', Buffer.alloc(1024 * 1024, 'a'))
    stream.emit('data', Buffer.from('over the limit'))

    expect(outputCalls(event)).toHaveLength(1)
  })

  it('does not send output or completion to a destroyed renderer', async () => {
    const conn = makeConn()
    vi.mocked(connectSessionClient).mockResolvedValue(conn as never)
    const event = makeEvent()
    run(event)
    await flush()

    const stream = makeStream()
    conn.execCalls[0].cb(null, stream)
    event.sender.isDestroyed.mockReturnValue(true)
    stream.emit('data', Buffer.from('too late'))
    stream.emit('close', 0)

    expect(event.sender.send).not.toHaveBeenCalled()
    expect(conn.dispose).toHaveBeenCalled()
  })
})

describe('runner:cancel', () => {
  it('validates the run id and ignores unknown runs', () => {
    const event = makeEvent()
    expect(() => cancel(event, 42)).toThrow(ValidationError)
    expect(cancel(event, 'not-a-known-run')).toBeUndefined()
  })

  it('refuses to cancel another window\'s run', async () => {
    const conn = makeConn()
    vi.mocked(connectSessionClient).mockResolvedValue(conn as never)
    const owner = makeEvent()
    const runId = run(owner)
    await flush()

    expect(() => cancel(makeEvent(), runId)).toThrow(OwnershipError)
  })

  it('disposes connections and timers, and later stream events are ignored', async () => {
    vi.useFakeTimers()
    const conn = makeConn()
    vi.mocked(connectSessionClient).mockResolvedValue(conn as never)
    const event = makeEvent()
    const runId = run(event)
    await flush()

    const stream = makeStream()
    conn.execCalls[0].cb(null, stream)
    cancel(event, runId)
    expect(conn.dispose).toHaveBeenCalled()

    // Neither the timeout nor the eventual close report anything after cancel
    await vi.advanceTimersByTimeAsync(120_000)
    stream.emit('close', 0)
    expect(doneCalls(event)).toHaveLength(0)
  })

  it('disposes a connection that finishes connecting after the cancel', async () => {
    const conn = makeConn()
    let release: (value: FakeConn) => void = () => {}
    vi.mocked(connectSessionClient).mockImplementation(
      () => new Promise((resolve) => { release = resolve as never }) as never
    )
    const event = makeEvent()
    const runId = run(event)
    await flush()

    cancel(event, runId)
    release(conn)
    await flush()

    expect(conn.dispose).toHaveBeenCalled()
    expect(conn.execCalls).toHaveLength(0)
  })
})

describe('disposeRunsForSender', () => {
  it('tears down only the runs owned by that sender', async () => {
    const conns = [makeConn(), makeConn()]
    let next = 0
    vi.mocked(connectSessionClient).mockImplementation(async () => conns[next++] as never)

    const mine = makeEvent()
    const theirs = makeEvent()
    run(mine, ['s1'])
    run(theirs, ['s2'])
    await flush()

    disposeRunsForSender(mine.sender.id)
    expect(conns[0].dispose).toHaveBeenCalled()
    expect(conns[1].dispose).not.toHaveBeenCalled()
  })
})
