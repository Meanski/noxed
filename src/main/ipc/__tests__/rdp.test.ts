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

function onHandler(channel: string): Handler {
  const call = (ipcMain.on as Mock).mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No on-handler registered for ${channel}`)
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

/** Builds a valid NXF2 dirty-rect frame: 32-byte header + w*h*4 RGBA bytes.
 *  Defaults to a full-desktop rect at the origin (descW/descH = w/h). */
function frame(
  w: number,
  h: number,
  fill = 0xab,
  opts: { x?: number; y?: number; descW?: number; descH?: number } = {},
): Buffer {
  const { x = 0, y = 0, descW = w, descH = h } = opts
  const data = Buffer.alloc(w * h * 4, fill)
  const head = Buffer.alloc(32)
  head.write('NXF2', 0, 'ascii')
  head.writeUInt32LE(descW, 4)
  head.writeUInt32LE(descH, 8)
  head.writeUInt32LE(x, 12)
  head.writeUInt32LE(y, 16)
  head.writeUInt32LE(w, 20)
  head.writeUInt32LE(h, 24)
  head.writeUInt32LE(data.length, 28)
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

  it('writes the password to stdin and keeps it open for input', () => {
    const { proc } = connect()
    expect(proc.stdin.write).toHaveBeenCalledWith('secret\n')
    // stdin is NOT closed: it doubles as the input channel (rdp:input).
    expect(proc.stdin.end).not.toHaveBeenCalled()
  })

  it('survives a stdin write error (EPIPE from an instantly-dead sidecar)', () => {
    const { proc } = connect()
    expect(() => proc.stdin.emit('error', new Error('EPIPE'))).not.toThrow()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('stdin write failed'))
  })
})

describe('rdp:input', () => {
  it('writes one input command line to the session stdin', () => {
    const { proc, id, event } = connect()
    onHandler('rdp:input')(event, id, 'mv 100 200')
    expect(proc.stdin.write).toHaveBeenCalledWith('mv 100 200\n')
  })

  it.each([
    ['embedded newline smuggling a second command', 'mv 1 2\nkd 30 0'],
    ['trailing newline', 'mv 1 2\n'],
    ['unknown verb', 'xx 1 2'],
    ['too few arguments', 'mv 1'],
    ['too many arguments', 'md 1 2 0 9'],
    ['non-numeric argument', 'mv a 2'],
    ['oversized number', 'mv 1234567 2'],
    ['non-ASCII padding', '\u0800'.repeat(85) + 'mv 1 2'],
  ])('drops a line that does not match the input grammar (%s)', (_label, line) => {
    const { proc, id, event } = connect()
    onHandler('rdp:input')(event, id, line)
    expect(proc.stdin.write).toHaveBeenCalledTimes(1) // password only
  })

  it('accepts every verb in the grammar, including negative wheel deltas', () => {
    const { proc, id, event } = connect()
    for (const line of ['md 1 2 0', 'mu 1 2 1', 'mw 5 5 -120', 'kd 72 1', 'ku 72 1', 'uc 1 233']) {
      onHandler('rdp:input')(event, id, line)
      expect(proc.stdin.write).toHaveBeenLastCalledWith(line + '\n')
    }
  })

  it('drops input for an unknown/unowned session without throwing', () => {
    const { proc, id } = connect()
    const other = makeEvent() // different sender → ownership mismatch
    expect(() => onHandler('rdp:input')(other, id, 'mv 1 2')).not.toThrow()
    expect(proc.stdin.write).toHaveBeenCalledTimes(1) // password only
    expect(proc.stdin.write).toHaveBeenCalledWith('secret\n')
  })

  it('ignores non-string payloads', () => {
    const { proc, id, event } = connect()
    onHandler('rdp:input')(event, id, 42)
    expect(proc.stdin.write).toHaveBeenCalledTimes(1) // password only
  })
})

describe('frame stream parsing', () => {
  it('forwards a complete frame (desktop dims, rect, pixels) to the renderer', () => {
    const { proc, id, event } = connect()
    proc.stdout.emit('data', frame(2, 2, 0xab, { x: 4, y: 6, descW: 8, descH: 8 }))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
    const [channel, sentId, { descW, descH, x, y, w, h, pixels }] = event.sender.send.mock.calls[0]
    expect(channel).toBe('rdp:frame')
    expect(sentId).toBe(id)
    expect([descW, descH]).toEqual([8, 8])
    expect([x, y]).toEqual([4, 6])
    expect([w, h]).toEqual([2, 2])
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
    expect(event.sender.send.mock.calls[0][2].w).toBe(3) // rect width
  })

  it('drains multiple frames from a single chunk', () => {
    const { proc, event } = connect()
    proc.stdout.emit('data', Buffer.concat([frame(1, 1, 0x01), frame(2, 1, 0x02)]))
    expect(event.sender.send).toHaveBeenCalledTimes(2)
    expect(event.sender.send.mock.calls[0][2].w).toBe(1) // rect width
    expect(event.sender.send.mock.calls[1][2].w).toBe(2)
  })

  it('resyncs past stray bytes before a frame', () => {
    const { proc, event } = connect()
    proc.stdout.emit('data', Buffer.concat([Buffer.from('some library log line here'), frame(1, 1)]))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('resync'))
  })

  it('drops junk with no magic while keeping a possible split-magic tail', () => {
    const { proc, event } = connect()
    proc.stdout.emit('data', Buffer.from('x'.repeat(40))) // >= header size, no NXF2 anywhere
    expect(event.sender.send).not.toHaveBeenCalled()
    // Next frame still parses even though a junk tail was retained.
    proc.stdout.emit('data', frame(1, 1))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
  })

  it('rejects an implausible header (zero dims) and resyncs to the next frame', () => {
    const { proc, event } = connect()
    const bogus = Buffer.alloc(32)
    bogus.write('NXF2', 0, 'ascii') // descW/descH/w/h/dataLen all zero
    proc.stdout.emit('data', Buffer.concat([bogus, frame(1, 1)]))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
  })

  it('rejects a header whose dataLen does not match w*h*4', () => {
    const { proc, event } = connect()
    const bad = Buffer.alloc(32)
    bad.write('NXF2', 0, 'ascii')
    bad.writeUInt32LE(2, 4) // descW
    bad.writeUInt32LE(2, 8) // descH
    bad.writeUInt32LE(2, 20) // w
    bad.writeUInt32LE(2, 24) // h
    bad.writeUInt32LE(15, 28) // dataLen — should be 16
    proc.stdout.emit('data', Buffer.concat([bad, frame(1, 1)]))
    expect(event.sender.send).toHaveBeenCalledTimes(1)
    expect(event.sender.send.mock.calls[0][2].w).toBe(1) // rect width
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
