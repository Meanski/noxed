import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}))
vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}))

import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { registerRdpHandlers, disposeRdpSessionsForSender } from '../rdp'
import { ValidationError, NotFoundError, OwnershipError, ConnectionError } from '../errors'

registerRdpHandlers()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => any

function handler(channel: string): Handler {
  const call = (ipcMain.handle as Mock).mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No handler registered for ${channel}`)
  return call[1] as Handler
}

class FakeStdin extends EventEmitter {
  write = vi.fn()
  end = vi.fn()
}

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = new FakeStdin()
  kill = vi.fn()
}

interface FakeEvent {
  sender: { id: number; isDestroyed: () => boolean; send: Mock }
}

let senderSeq = 1
function makeEvent(destroyed = false): FakeEvent {
  return { sender: { id: senderSeq++, isDestroyed: () => destroyed, send: vi.fn() } }
}

const VALID_CONFIG = { host: 'rdp.example.com', username: 'admin', password: 'secret' }

function connect(config: Record<string, unknown> = VALID_CONFIG, event: FakeEvent = makeEvent()) {
  const proc = new FakeProc()
  ;(spawn as Mock).mockReturnValueOnce(proc)
  const id = handler('rdp:connect')(event, config) as string
  return { proc, id, event }
}

/** Builds a valid NXF1 frame: 16-byte header + w*h*4 BGRA bytes. */
function frame(w: number, h: number, fill = 0xab): Buffer {
  const data = Buffer.alloc(w * h * 4, fill)
  const head = Buffer.alloc(16)
  head.write('NXF1', 0, 'ascii')
  head.writeUInt32LE(w, 4)
  head.writeUInt32LE(h, 8)
  head.writeUInt32LE(data.length, 12)
  return Buffer.concat([head, data])
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;(existsSync as Mock).mockReturnValue(true)
})

describe('rdp:connect validation', () => {
  it('rejects missing or invalid host, username, and password', () => {
    const connectHandler = handler('rdp:connect')
    const event = makeEvent()
    expect(() => connectHandler(event, { username: 'u', password: 'p' })).toThrow(ValidationError)
    expect(() => connectHandler(event, { host: '', username: 'u', password: 'p' })).toThrow(ValidationError)
    expect(() => connectHandler(event, { host: 'h', password: 'p' })).toThrow(ValidationError)
    expect(() => connectHandler(event, { host: 'h', username: 'u', password: 42 })).toThrow(ValidationError)
    expect(() => connectHandler(event, null)).toThrow(ValidationError)
  })

  it('throws a ConnectionError when the sidecar binary is missing', () => {
    ;(existsSync as Mock).mockReturnValue(false)
    expect(() => handler('rdp:connect')(makeEvent(), VALID_CONFIG)).toThrow(ConnectionError)
  })

  it('spawns the sidecar with defaults when optional numbers are absent', () => {
    connect()
    const [, args, opts] = (spawn as Mock).mock.calls.at(-1)!
    expect(args).toEqual(['rdp.example.com', '3389', 'admin', '1280', '800'])
    expect(opts).toEqual({ stdio: ['pipe', 'pipe', 'pipe'] })
  })

  it('clamps out-of-range port, width, and height', () => {
    connect({ ...VALID_CONFIG, port: 99_999, width: 100, height: 100_000 })
    const [, args] = (spawn as Mock).mock.calls.at(-1)!
    expect(args).toEqual(['rdp.example.com', '65535', 'admin', '640', '7680'])
  })

  it('writes the password to stdin and closes it', () => {
    const { proc } = connect()
    expect(proc.stdin.write).toHaveBeenCalledWith('secret\n')
    expect(proc.stdin.end).toHaveBeenCalled()
  })

  it('survives a stdin write error (EPIPE from an instantly-dead sidecar)', () => {
    const { proc } = connect()
    expect(() => proc.stdin.emit('error', new Error('EPIPE'))).not.toThrow()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('stdin write failed'))
  })
})

describe('frame stream parsing', () => {
  it('forwards a complete frame to the renderer', () => {
    const { proc, id, event } = connect()
    proc.stdout.emit('data', frame(2, 2))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
    const [channel, sentId, w, h, pixels] = event.sender.send.mock.calls[0]
    expect(channel).toBe('rdp:frame')
    expect(sentId).toBe(id)
    expect(w).toBe(2)
    expect(h).toBe(2)
    expect(pixels as Buffer).toHaveLength(16)
  })

  it('buffers partial frames across chunks', () => {
    const { proc, event } = connect()
    const full = frame(3, 2)
    proc.stdout.emit('data', full.subarray(0, 10)) // partial header
    expect(event.sender.send).not.toHaveBeenCalled()
    proc.stdout.emit('data', full.subarray(10, 20)) // header complete, pixels partial
    expect(event.sender.send).not.toHaveBeenCalled()
    proc.stdout.emit('data', full.subarray(20))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
    expect(event.sender.send.mock.calls[0][2]).toBe(3)
  })

  it('drains multiple frames from a single chunk', () => {
    const { proc, event } = connect()
    proc.stdout.emit('data', Buffer.concat([frame(1, 1, 0x01), frame(2, 1, 0x02)]))
    expect(event.sender.send).toHaveBeenCalledTimes(2)
    expect(event.sender.send.mock.calls[0][2]).toBe(1)
    expect(event.sender.send.mock.calls[1][2]).toBe(2)
  })

  it('resyncs past stray bytes before a frame', () => {
    const { proc, event } = connect()
    proc.stdout.emit('data', Buffer.concat([Buffer.from('some library log line here'), frame(1, 1)]))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('resync'))
  })

  it('drops junk with no magic while keeping a possible split-magic tail', () => {
    const { proc, event } = connect()
    proc.stdout.emit('data', Buffer.from('x'.repeat(20))) // >= header size, no NXF1 anywhere
    expect(event.sender.send).not.toHaveBeenCalled()
    // Next frame still parses even though 3 junk bytes were retained.
    proc.stdout.emit('data', frame(1, 1))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
  })

  it('rejects an implausible header (zero dims) and resyncs to the next frame', () => {
    const { proc, event } = connect()
    const bogus = Buffer.alloc(16)
    bogus.write('NXF1', 0, 'ascii') // width/height/dataLen all zero
    proc.stdout.emit('data', Buffer.concat([bogus, frame(1, 1)]))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
  })

  it('rejects a header whose dataLen does not match width*height*4', () => {
    const { proc, event } = connect()
    const bad = Buffer.alloc(16)
    bad.write('NXF1', 0, 'ascii')
    bad.writeUInt32LE(2, 4)
    bad.writeUInt32LE(2, 8)
    bad.writeUInt32LE(15, 12) // should be 16
    proc.stdout.emit('data', Buffer.concat([bad, frame(1, 1)]))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
    expect(event.sender.send.mock.calls[0][2]).toBe(1)
  })

  it('does not send frames to a destroyed sender', () => {
    const { proc, event } = connect(VALID_CONFIG, makeEvent(true))
    proc.stdout.emit('data', frame(1, 1))
    expect(event.sender.send).not.toHaveBeenCalled()
  })
})

describe('stderr [sidecar] parsing and exit reasons', () => {
  it('prefers the last "error:" detail over informational lines', () => {
    const { proc, id, event } = connect()
    proc.stderr.emit('data', Buffer.from('[sidecar] connecting to host:3389\n'))
    proc.stderr.emit('data', Buffer.from('freerdp noise\n[sidecar] error: Logon failed\n'))
    proc.stderr.emit('data', Buffer.from('[sidecar] disconnecting\n'))
    proc.emit('exit', 1)
    expect(event.sender.send).toHaveBeenCalledWith('rdp:closed', id, 'Logon failed')
  })

  it.each([
    {
      name: 'falls back to the last informational sidecar message on failure',
      stderr: '[sidecar] certificate accepted\n',
      exitCode: 3,
      reason: 'certificate accepted',
    },
    {
      name: 'keeps "error:" with no detail as a plain message, not an error detail',
      stderr: '[sidecar] error:\n',
      exitCode: 1,
      reason: 'error:',
    },
    {
      name: 'ignores empty sidecar lines and reports a generic exit reason',
      stderr: '[sidecar]   \nplain freerdp output\n',
      exitCode: 2,
      reason: 'sidecar exited (2)',
    },
  ])('$name', ({ stderr, exitCode, reason }) => {
    const { proc, id, event } = connect()
    proc.stderr.emit('data', Buffer.from(stderr))
    proc.emit('exit', exitCode)
    expect(event.sender.send).toHaveBeenCalledWith('rdp:closed', id, reason)
  })

  it('sends a null reason on clean exit', () => {
    const { proc, id, event } = connect()
    proc.stderr.emit('data', Buffer.from('[sidecar] error: transient\n'))
    proc.emit('exit', 0)
    expect(event.sender.send).toHaveBeenCalledWith('rdp:closed', id, null)
  })

  it('does not send rdp:closed to a destroyed sender', () => {
    const { proc, event } = connect(VALID_CONFIG, makeEvent(true))
    proc.emit('exit', 1)
    expect(event.sender.send).not.toHaveBeenCalled()
  })

  it('reports spawn errors and removes the session', () => {
    const { proc, id, event } = connect()
    proc.emit('error', new Error('spawn ENOENT'))
    expect(event.sender.send).toHaveBeenCalledWith('rdp:closed', id, 'spawn ENOENT')
    expect(() => handler('rdp:disconnect')(event, id)).toThrow(NotFoundError)
  })
})

describe('rdp:disconnect and session ownership', () => {
  it('validates the session id shape', () => {
    expect(() => handler('rdp:disconnect')(makeEvent(), 42)).toThrow(ValidationError)
  })

  it('throws NotFoundError for unknown sessions', () => {
    expect(() => handler('rdp:disconnect')(makeEvent(), 'nope')).toThrow(NotFoundError)
  })

  it('rejects a disconnect from a different sender', () => {
    const { id } = connect()
    expect(() => handler('rdp:disconnect')(makeEvent(), id)).toThrow(OwnershipError)
  })

  it('kills the sidecar on disconnect and forgets the session', () => {
    const { proc, id, event } = connect()
    handler('rdp:disconnect')(event, id)
    expect(proc.kill).toHaveBeenCalled()
    expect(() => handler('rdp:disconnect')(event, id)).toThrow(NotFoundError)
  })

  it('swallows kill failures during dispose', () => {
    const { proc, id, event } = connect()
    proc.kill.mockImplementation(() => { throw new Error('already dead') })
    expect(() => handler('rdp:disconnect')(event, id)).not.toThrow()
  })

  it('disposeRdpSessionsForSender only kills that sender\'s sessions', () => {
    const mine = makeEvent()
    const a = connect(VALID_CONFIG, mine)
    const b = connect(VALID_CONFIG, mine)
    const other = connect()
    disposeRdpSessionsForSender(mine.sender.id)
    expect(a.proc.kill).toHaveBeenCalled()
    expect(b.proc.kill).toHaveBeenCalled()
    expect(other.proc.kill).not.toHaveBeenCalled()
    handler('rdp:disconnect')(other.event, other.id) // still alive for its own sender
  })
})
