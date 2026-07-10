import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))
vi.mock('electron-store', () => ({
  default: class MockStore {
    private data = new Map<string, unknown>()
    get(key: string) { return this.data.get(key) }
    set(key: string, value: unknown) { this.data.set(key, value) }
  },
}))
vi.mock('../sshClients', () => ({
  connectSessionClient: vi.fn(),
}))

import { ipcMain } from 'electron'
import { connectSessionClient } from '../sshClients'
import {
  parseJsonLines,
  validateContainerRef,
  validateContainerAction,
  registerDockerHandlers,
  disposeDockerSessionsForSender,
} from '../docker'
import { ValidationError, NotFoundError, OwnershipError, ConnectionError } from '../errors'

registerDockerHandlers()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => any

function handler(channel: string): Handler {
  const call = (ipcMain.handle as Mock).mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No handler registered for ${channel}`)
  return call[1] as Handler
}

describe('parseJsonLines', () => {
  it('parses one JSON object per line', () => {
    const out = '{"ID":"abc","Names":"web"}\n{"ID":"def","Names":"db"}\n'
    expect(parseJsonLines(out)).toEqual([
      { ID: 'abc', Names: 'web' },
      { ID: 'def', Names: 'db' },
    ])
  })

  it('skips blank lines, noise, and truncated JSON', () => {
    const out = '\nWARNING: something\n{"ID":"abc"}\n{"ID":"trunc'
    expect(parseJsonLines(out)).toEqual([{ ID: 'abc' }])
  })

  it('returns an empty array for empty output', () => {
    expect(parseJsonLines('')).toEqual([])
  })
})

describe('validateContainerRef', () => {
  it('accepts ids and conventional names', () => {
    expect(validateContainerRef('3f4a9b2c1d')).toBe('3f4a9b2c1d')
    expect(validateContainerRef('my-app_1.web')).toBe('my-app_1.web')
  })

  it('rejects shell metacharacters and bad shapes', () => {
    for (const bad of ['a; rm -rf /', 'a b', '$(reboot)', '-leading-dash', '', 'a'.repeat(200), 42]) {
      expect(() => validateContainerRef(bad)).toThrow(ValidationError)
    }
  })
})

describe('validateContainerAction', () => {
  it('accepts the four supported actions', () => {
    for (const action of ['start', 'stop', 'restart', 'rm']) {
      expect(validateContainerAction(action)).toBe(action)
    }
  })

  it('rejects anything else', () => {
    for (const bad of ['exec', 'kill --signal', '', undefined]) {
      expect(() => validateContainerAction(bad)).toThrow(ValidationError)
    }
  })
})

// ── Handler-level tests (fake SSH connection + exec channels) ────────────────

class FakeExecStream extends EventEmitter {
  stderr = new EventEmitter()
  close = vi.fn()
}

interface FakeSshClient extends EventEmitter {
  exec: Mock
}

function fakeConn() {
  const client = new EventEmitter() as FakeSshClient
  client.exec = vi.fn()
  return { client, dispose: vi.fn() }
}

interface FakeEvent {
  sender: { id: number; isDestroyed: () => boolean; send: Mock }
}

let senderSeq = 500
function makeEvent(): FakeEvent {
  return { sender: { id: senderSeq++, isDestroyed: () => false, send: vi.fn() } }
}

async function connectDocker(event: FakeEvent = makeEvent()) {
  const conn = fakeConn()
  ;(connectSessionClient as Mock).mockResolvedValueOnce(conn)
  const id = (await handler('docker:connect')(event, 'session-1')) as string
  return { id, conn, event }
}

/** Sets up exec to hand back a fresh stream for each call and returns them in order. */
function execYields(conn: ReturnType<typeof fakeConn>): FakeExecStream[] {
  const streams: FakeExecStream[] = []
  conn.client.exec.mockImplementation((_cmd: string, cb: (e: Error | null, s?: FakeExecStream) => void) => {
    const stream = new FakeExecStream()
    streams.push(stream)
    cb(null, stream)
  })
  return streams
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('docker:connect / docker:disconnect', () => {
  it('rejects a non-string connection id', async () => {
    await expect(handler('docker:connect')(makeEvent(), 42)).rejects.toBeInstanceOf(ValidationError)
  })

  it('creates a session and disposes it on disconnect', async () => {
    const { id, conn, event } = await connectDocker()
    handler('docker:disconnect')(event, id)
    expect(conn.dispose).toHaveBeenCalled()
    expect(() => handler('docker:disconnect')(event, id)).toThrow(NotFoundError)
  })

  it('enforces session ownership and id shape', async () => {
    const { id } = await connectDocker()
    expect(() => handler('docker:disconnect')(makeEvent(), id)).toThrow(OwnershipError)
    expect(() => handler('docker:disconnect')(makeEvent(), 7)).toThrow(ValidationError)
  })

  it('disposes the session when the SSH connection closes', async () => {
    const { id, conn, event } = await connectDocker()
    conn.client.emit('close')
    expect(conn.dispose).toHaveBeenCalled()
    expect(() => handler('docker:disconnect')(event, id)).toThrow(NotFoundError)
  })

  it('disposeDockerSessionsForSender cleans up only that sender', async () => {
    const mine = await connectDocker()
    const other = await connectDocker()
    disposeDockerSessionsForSender(mine.event.sender.id)
    expect(mine.conn.dispose).toHaveBeenCalled()
    expect(other.conn.dispose).not.toHaveBeenCalled()
    handler('docker:disconnect')(other.event, other.id)
  })
})

describe('docker exec-based handlers', () => {
  it('lists containers by parsing json-lines stdout', async () => {
    const { id, conn, event } = await connectDocker()
    const streams = execYields(conn)
    const pending = handler('docker:containers')(event, id) as Promise<unknown[]>
    const stream = streams[0]
    stream.emit('data', Buffer.from('{"ID":"abc","Names":"web"}\n'))
    stream.emit('data', Buffer.from('{"ID":"def","Names":"db"}\n'))
    stream.emit('close', 0)
    await expect(pending).resolves.toEqual([
      { ID: 'abc', Names: 'web' },
      { ID: 'def', Names: 'db' },
    ])
    expect(conn.client.exec.mock.calls[0][0]).toContain('docker ps -a')
  })

  it('resolves stdout when the channel closes without an exit code but with output', async () => {
    const { id, conn, event } = await connectDocker()
    const streams = execYields(conn)
    const pending = handler('docker:stats')(event, id) as Promise<unknown[]>
    streams[0].emit('data', Buffer.from('{"CPUPerc":"1.0%"}\n'))
    streams[0].emit('close', null)
    await expect(pending).resolves.toEqual([{ CPUPerc: '1.0%' }])
  })

  it('maps exit code 127 to a missing-docker error', async () => {
    const { id, conn, event } = await connectDocker()
    const streams = execYields(conn)
    const pending = handler('docker:images')(event, id)
    streams[0].emit('close', 127)
    await expect(pending).rejects.toThrow('Docker CLI not found on this host')
  })

  it('surfaces stderr on non-zero exit, falling back to the exit code', async () => {
    const { id, conn, event } = await connectDocker()
    const streams = execYields(conn)
    const withStderr = handler('docker:containers')(event, id)
    streams[0].stderr.emit('data', Buffer.from('permission denied\n'))
    streams[0].emit('close', 1)
    await expect(withStderr).rejects.toThrow('permission denied')

    const bare = handler('docker:containers')(event, id)
    streams[1].emit('close', 2)
    await expect(bare).rejects.toThrow('Command failed (exit 2)')
  })

  it('rejects when exec itself fails or the stream errors', async () => {
    const { id, conn, event } = await connectDocker()
    conn.client.exec.mockImplementationOnce((_c: string, cb: (e: Error | null) => void) => cb(new Error('channel open failed')))
    await expect(handler('docker:containers')(event, id)).rejects.toBeInstanceOf(ConnectionError)

    const streams = execYields(conn)
    const pending = handler('docker:containers')(event, id)
    streams[0].emit('error', new Error('reset'))
    await expect(pending).rejects.toBeInstanceOf(ConnectionError)
  })

  it('times out long-running commands', async () => {
    vi.useFakeTimers()
    try {
      const { id, conn, event } = await connectDocker()
      const streams = execYields(conn)
      const pending = handler('docker:containers')(event, id)
      vi.advanceTimersByTime(20_000)
      await expect(pending).rejects.toThrow('Remote command timed out')
      expect(streams[0].close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns the first parsed object for docker:info, or null', async () => {
    const { id, conn, event } = await connectDocker()
    const streams = execYields(conn)
    const withInfo = handler('docker:info')(event, id)
    streams[0].emit('data', Buffer.from('{"ServerVersion":"27.0"}\n'))
    streams[0].emit('close', 0)
    await expect(withInfo).resolves.toEqual({ ServerVersion: '27.0' })

    const empty = handler('docker:info')(event, id)
    streams[1].emit('close', 0)
    await expect(empty).resolves.toBeNull()
  })

  it('runs validated container actions, forcing rm', async () => {
    const { id, conn, event } = await connectDocker()
    const streams = execYields(conn)
    const pending = handler('docker:action')(event, id, 'web-1', 'rm')
    streams[0].emit('close', 0)
    await pending
    expect(conn.client.exec.mock.calls[0][0]).toBe('docker rm -f web-1')
    await expect(handler('docker:action')(event, id, 'web;rm -rf /', 'stop')).rejects.toBeInstanceOf(ValidationError)
    await expect(handler('docker:action')(event, id, 'web-1', 'exec')).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('docker log streaming', () => {
  it('starts a log stream and forwards stdout/stderr chunks to the renderer', async () => {
    const { id, conn, event } = await connectDocker()
    const streams = execYields(conn)
    const logId = (await handler('docker:logsStart')(event, id, 'web-1', 500)) as string
    expect(typeof logId).toBe('string')
    expect(conn.client.exec.mock.calls[0][0]).toBe('docker logs --tail 500 -f web-1 2>&1')

    streams[0].emit('data', Buffer.from('line one\n'))
    streams[0].stderr.emit('data', Buffer.from('warn line\n'))
    expect(event.sender.send).toHaveBeenCalledWith('docker:logChunk', logId, 'line one\n')
    expect(event.sender.send).toHaveBeenCalledWith('docker:logChunk', logId, 'warn line\n')

    streams[0].emit('close')
    expect(event.sender.send).toHaveBeenCalledWith('docker:logEnd', logId, null)
  })

  it('clamps the tail and defaults it for invalid values', async () => {
    const { id, conn, event } = await connectDocker()
    execYields(conn)
    await handler('docker:logsStart')(event, id, 'web-1', 1_000_000)
    expect(conn.client.exec.mock.calls[0][0]).toContain('--tail 10000 ')
    await handler('docker:logsStart')(event, id, 'web-1', 'lots')
    expect(conn.client.exec.mock.calls[1][0]).toContain('--tail 200 ')
  })

  it('reports stream errors through docker:logEnd', async () => {
    const { id, conn, event } = await connectDocker()
    const streams = execYields(conn)
    const logId = (await handler('docker:logsStart')(event, id, 'web-1', 100)) as string
    streams[0].emit('error', new Error('broken pipe'))
    expect(event.sender.send).toHaveBeenCalledWith('docker:logEnd', logId, 'broken pipe')
  })

  it('rejects when the log exec fails and validates the container ref', async () => {
    const { id, conn, event } = await connectDocker()
    conn.client.exec.mockImplementationOnce((_c: string, cb: (e: Error | null) => void) => cb(new Error('nope')))
    await expect(handler('docker:logsStart')(event, id, 'web-1', 100)).rejects.toBeInstanceOf(ConnectionError)
    expect(() => handler('docker:logsStart')(event, id, 'bad name', 100)).toThrow(ValidationError)
  })

  it('stops log streams with ownership checks', async () => {
    const { id, conn, event } = await connectDocker()
    const streams = execYields(conn)
    const logId = (await handler('docker:logsStart')(event, id, 'web-1', 100)) as string

    expect(() => handler('docker:logsStop')(makeEvent(), logId)).toThrow(OwnershipError)
    expect(() => handler('docker:logsStop')(event, 42)).toThrow(ValidationError)
    expect(handler('docker:logsStop')(event, 'unknown-id')).toBeUndefined()

    handler('docker:logsStop')(event, logId)
    expect(streams[0].close).toHaveBeenCalled()
  })

  it('stops a sender\'s log streams when its session is disposed', async () => {
    const { id, conn, event } = await connectDocker()
    const streams = execYields(conn)
    await handler('docker:logsStart')(event, id, 'web-1', 100)
    handler('docker:disconnect')(event, id)
    expect(streams[0].close).toHaveBeenCalled()
    expect(conn.dispose).toHaveBeenCalled()
  })
})
