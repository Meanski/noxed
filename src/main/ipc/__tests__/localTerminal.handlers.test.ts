import { describe, it, expect, vi, afterEach } from 'vitest'

const { ipc, fake, osState } = vi.hoisted(() => ({
  ipc: {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    listeners: new Map<string, (...args: unknown[]) => unknown>(),
  },
  fake: { ptys: [] as FakePty[] },
  osState: { platform: 'darwin' },
}))

interface FakePty {
  shell: string
  args: string[]
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  dataCb?: (data: string) => void
  exitCb?: (e: { exitCode: number; signal?: number }) => void
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void
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

vi.mock('node:os', () => ({
  homedir: () => '/home/tester',
  platform: () => osState.platform,
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn((shell: string, args: string[], opts: FakePty['opts']) => {
    const pty: FakePty = {
      shell,
      args,
      opts,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (cb) => { pty.dataCb = cb },
      onExit: (cb) => { pty.exitCb = cb },
    }
    fake.ptys.push(pty)
    return pty
  }),
}))

import { registerLocalTerminalHandlers, defaultShell, disposeLocalPtysForSender } from '../localTerminal'
import { ValidationError, NotFoundError, OwnershipError } from '../errors'

registerLocalTerminalHandlers()

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

function start(event: FakeEvent = makeEvent(), cols = 80, rows = 24) {
  const handler = ipc.handlers.get('localpty:start')
  if (!handler) throw new Error('localpty:start handler not registered')
  const id = handler(event, cols, rows) as string
  const pty = fake.ptys.at(-1)
  if (!pty) throw new Error('no pty spawned')
  return { id, pty, event }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  osState.platform = 'darwin'
})

describe('defaultShell', () => {
  it('uses PowerShell on Windows', () => {
    osState.platform = 'win32'
    expect(defaultShell()).toEqual({ shell: 'powershell.exe', args: [] })
  })

  it('prefers the SHELL environment variable as a login shell', () => {
    vi.stubEnv('SHELL', '/opt/homebrew/bin/fish')
    expect(defaultShell()).toEqual({ shell: '/opt/homebrew/bin/fish', args: ['-l'] })
  })

  it('falls back to zsh on macOS when SHELL is unset', () => {
    vi.stubEnv('SHELL', undefined)
    expect(defaultShell()).toEqual({ shell: '/bin/zsh', args: ['-l'] })
  })

  it('falls back to bash on Linux when SHELL is unset', () => {
    osState.platform = 'linux'
    vi.stubEnv('SHELL', undefined)
    expect(defaultShell()).toEqual({ shell: '/bin/bash', args: ['-l'] })
  })
})

describe('localpty:start', () => {
  it('spawns a pty in the home directory and returns a uuid', () => {
    const { id, pty } = start(makeEvent(), 120, 40)
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(pty.opts).toMatchObject({
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: '/home/tester',
    })
    expect(pty.opts.env.TERM).toBe('xterm-256color')
  })

  it('rejects invalid dimensions', () => {
    const handler = ipc.handlers.get('localpty:start')
    const event = makeEvent()
    expect(() => handler?.(event, 0, 24)).toThrow(ValidationError)
    expect(() => handler?.(event, 80, 1001)).toThrow(ValidationError)
    expect(() => handler?.(event, 1.5, 24)).toThrow(ValidationError)
    expect(() => handler?.(event, 80, 'tall')).toThrow(ValidationError)
  })

  it('forwards pty output to the renderer', () => {
    const { id, pty, event } = start()
    pty.dataCb?.('hello from shell')
    expect(event.sender.send).toHaveBeenCalledWith('localpty:data', id, 'hello from shell')
  })

  it('does not send output to a destroyed renderer', () => {
    const { pty, event } = start()
    event.sender.isDestroyed.mockReturnValue(true)
    pty.dataCb?.('late output')
    expect(event.sender.send).not.toHaveBeenCalled()
  })

  it('notifies the renderer and unregisters the pty on exit', () => {
    const { id, pty, event } = start()
    pty.exitCb?.({ exitCode: 0 })
    expect(event.sender.send).toHaveBeenCalledWith('localpty:exit', id, 0)

    // Entry is gone: further writes are ignored
    ipc.listeners.get('localpty:write')?.(event, id, 'ls\n')
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('does not send the exit event to a destroyed renderer', () => {
    const { pty, event } = start()
    event.sender.isDestroyed.mockReturnValue(true)
    pty.exitCb?.({ exitCode: 1 })
    expect(event.sender.send).not.toHaveBeenCalled()
  })
})

describe('localpty:write', () => {
  it('writes renderer input to the pty', () => {
    const { id, pty, event } = start()
    ipc.listeners.get('localpty:write')?.(event, id, 'echo hi\n')
    expect(pty.write).toHaveBeenCalledWith('echo hi\n')
  })

  it('silently drops invalid ids, unknown ids, foreign senders, and bad payloads', () => {
    const { id, pty, event } = start()
    const write = ipc.listeners.get('localpty:write')
    write?.(event, 42, 'x')
    write?.(event, '11111111-1111-4111-8111-111111111111', 'x')
    write?.(makeEvent(), id, 'stolen input')
    write?.(event, id, Buffer.from('not a string'))
    write?.(event, id, 'y'.repeat(65 * 1024))
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('rethrows unexpected internal errors instead of swallowing them', () => {
    const { id } = start()
    const broken = { sender: null } as never
    expect(() => ipc.listeners.get('localpty:write')?.(broken, id, 'x')).toThrow(TypeError)
  })
})

describe('localpty:resize', () => {
  it('resizes the pty with validated dimensions', () => {
    const { id, pty, event } = start()
    ipc.listeners.get('localpty:resize')?.(event, id, 132, 50)
    expect(pty.resize).toHaveBeenCalledWith(132, 50)
  })

  it('ignores invalid dimensions, unknown ids, and foreign senders', () => {
    const { id, pty, event } = start()
    const resize = ipc.listeners.get('localpty:resize')
    resize?.(event, id, 0, 24)
    resize?.(event, id, 80, 2000)
    resize?.(event, 'not-registered', 80, 24)
    resize?.(makeEvent(), id, 80, 24)
    expect(pty.resize).not.toHaveBeenCalled()
  })

  it('rethrows unexpected internal errors instead of swallowing them', () => {
    const { id } = start()
    const broken = { sender: null } as never
    expect(() => ipc.listeners.get('localpty:resize')?.(broken, id, 80, 24)).toThrow(TypeError)
  })
})

describe('localpty:kill', () => {
  it('kills the pty and unregisters it', () => {
    const { id, pty, event } = start()
    ipc.handlers.get('localpty:kill')?.(event, id)
    expect(pty.kill).toHaveBeenCalled()

    // Entry is gone: further writes are ignored
    ipc.listeners.get('localpty:write')?.(event, id, 'x')
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('validates the id and enforces ownership', () => {
    const { id, pty } = start()
    const kill = ipc.handlers.get('localpty:kill')
    expect(() => kill?.(makeEvent(), 42)).toThrow(ValidationError)
    expect(() => kill?.(makeEvent(), '11111111-1111-4111-8111-111111111111')).toThrow(NotFoundError)
    expect(() => kill?.(makeEvent(), id)).toThrow(OwnershipError)
    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('logs instead of crashing when killing the pty throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { id, pty, event } = start()
    pty.kill.mockImplementation(() => { throw new Error('already dead') })
    ipc.handlers.get('localpty:kill')?.(event, id)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('already dead'))
  })
})

describe('disposeLocalPtysForSender', () => {
  it('kills every pty owned by that sender and leaves others alone', () => {
    const event = makeEvent()
    const first = start(event)
    const second = start(event)
    const other = start()

    disposeLocalPtysForSender(event.sender.id)
    expect(first.pty.kill).toHaveBeenCalled()
    expect(second.pty.kill).toHaveBeenCalled()
    expect(other.pty.kill).not.toHaveBeenCalled()

    // Disposed ptys no longer accept writes
    ipc.listeners.get('localpty:write')?.(event, first.id, 'x')
    expect(first.pty.write).not.toHaveBeenCalled()
  })
})
