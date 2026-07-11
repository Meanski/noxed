import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

interface FakeSshClient extends EventEmitter {
  connectConfig: Record<string, unknown>
  forwardOutCalls: Array<{ destHost: string; destPort: number }>
  end: ReturnType<typeof vi.fn>
  setNoDelay: ReturnType<typeof vi.fn>
  connect: (config: unknown) => void
  forwardOut: (srcIp: string, srcPort: number, destHost: string, destPort: number, cb: (err: Error | null, stream?: unknown) => void) => void
}

const { fakeSsh } = vi.hoisted(() => ({
  fakeSsh: {
    clients: [] as unknown[],
    connectImpl: null as null | ((client: unknown) => void),
    forwardOutImpl: null as null | ((destHost: string, destPort: number, cb: (err: Error | null, stream?: unknown) => void) => void),
  },
}))

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events')

  class FakeClient extends EventEmitter {
    connectConfig: Record<string, unknown> = {}
    forwardOutCalls: Array<{ destHost: string; destPort: number }> = []
    end = vi.fn()
    setNoDelay = vi.fn()

    constructor() {
      super()
      fakeSsh.clients.push(this)
    }

    connect(config: Record<string, unknown>): void {
      this.connectConfig = config
      fakeSsh.connectImpl?.(this)
    }

    forwardOut(_srcIp: string, _srcPort: number, destHost: string, destPort: number, cb: (err: Error | null, stream?: unknown) => void): void {
      this.forwardOutCalls.push({ destHost, destPort })
      fakeSsh.forwardOutImpl?.(destHost, destPort, cb)
    }
  }

  return { Client: FakeClient }
})

vi.mock('../sessions', () => ({
  getSessionById: vi.fn(),
}))
vi.mock('../keychain', () => ({
  getCredential: vi.fn(),
  isUnlocked: vi.fn(),
}))
vi.mock('../security', () => ({
  isAllowedKeyPath: vi.fn(),
}))
vi.mock('../settings', () => ({
  getStoredSettings: vi.fn(),
}))
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}))

import { readFileSync } from 'node:fs'
import { Client } from 'ssh2'
import {
  parseKeepaliveIntervalMs,
  sshConnectOptions,
  connectRawClient,
  openJumpSocket,
  credentialsForSession,
  connectSessionClient,
} from '../sshClients'
import { getSessionById } from '../sessions'
import type { Session } from '../sessions'
import { getCredential, isUnlocked } from '../keychain'
import { isAllowedKeyPath } from '../security'
import { getStoredSettings } from '../settings'
import { AuthError, ConnectionError, NotFoundError, ValidationError } from '../errors'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    label: 'Prod Web',
    host: 'web.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    createdAt: 0,
    ...overrides,
  }
}

function lastClient(): FakeSshClient {
  const client = fakeSsh.clients.at(-1) as FakeSshClient | undefined
  if (!client) throw new Error('no ssh client created')
  return client
}

beforeEach(() => {
  fakeSsh.clients.length = 0
  fakeSsh.connectImpl = (client) => {
    queueMicrotask(() => (client as FakeSshClient).emit('ready'))
  }
  fakeSsh.forwardOutImpl = (destHost, destPort, cb) => {
    cb(null, { tunnelTo: `${destHost}:${destPort}` })
  }
  vi.mocked(getStoredSettings).mockReturnValue({} as never)
  vi.mocked(isUnlocked).mockReturnValue(true)
  vi.mocked(getCredential).mockResolvedValue('secret-pw')
  vi.mocked(isAllowedKeyPath).mockReturnValue({ ok: true, resolved: '/home/me/.ssh/id_ed25519' })
  vi.mocked(readFileSync).mockReturnValue('PRIVATE KEY DATA')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseKeepaliveIntervalMs', () => {
  it('maps each setting to its interval, defaulting to 30s', () => {
    expect(parseKeepaliveIntervalMs('Off')).toBe(0)
    expect(parseKeepaliveIntervalMs('15 seconds')).toBe(15_000)
    expect(parseKeepaliveIntervalMs('60 seconds')).toBe(60_000)
    expect(parseKeepaliveIntervalMs('30 seconds')).toBe(30_000)
    expect(parseKeepaliveIntervalMs(undefined)).toBe(30_000)
  })
})

describe('sshConnectOptions', () => {
  it('applies the stored keepalive setting over the defaults', () => {
    vi.mocked(getStoredSettings).mockReturnValue({ sshKeepalive: '15 seconds' } as never)
    const opts = sshConnectOptions()
    expect(opts.keepaliveInterval).toBe(15_000)
    expect(opts.readyTimeout).toBe(30_000)
    expect(opts.keepaliveCountMax).toBe(4)
  })
})

describe('connectRawClient', () => {
  it('resolves once the client is ready and disables Nagle', async () => {
    const client = await connectRawClient({ host: 'h', port: 2222, username: 'u', password: 'pw' }) as unknown as FakeSshClient
    expect(client.setNoDelay).toHaveBeenCalledWith(true)
    expect(client.connectConfig).toMatchObject({
      host: 'h',
      port: 2222,
      username: 'u',
      password: 'pw',
      tryKeyboard: true,
    })
    expect(client.connectConfig.algorithms).toBeTruthy()
  })

  it('rejects with a ConnectionError when the connection fails', async () => {
    fakeSsh.connectImpl = (client) => {
      queueMicrotask(() => (client as FakeSshClient).emit('error', new Error('ECONNREFUSED')))
    }
    await expect(connectRawClient({ host: 'h', port: 22, username: 'u' }))
      .rejects.toThrow(ConnectionError)
  })

  it('ignores errors after the connection has settled', async () => {
    const client = await connectRawClient({ host: 'h', port: 22, username: 'u' }) as unknown as FakeSshClient
    expect(() => client.emit('error', new Error('late failure'))).not.toThrow()
  })

  it('answers keyboard-interactive prompts with the password', async () => {
    fakeSsh.connectImpl = null
    const pending = connectRawClient({ host: 'h', port: 22, username: 'u', password: 'pw' })
    const client = lastClient()
    const finish = vi.fn()
    client.emit('keyboard-interactive', '', '', '', ['Password:', 'Verification:'], finish)
    expect(finish).toHaveBeenCalledWith(['pw', 'pw'])
    client.emit('ready')
    await expect(pending).resolves.toBeTruthy()
  })

  it('answers keyboard-interactive with an empty list when no password is set', async () => {
    fakeSsh.connectImpl = null
    const pending = connectRawClient({ host: 'h', port: 22, username: 'u' })
    const client = lastClient()
    const finish = vi.fn()
    client.emit('keyboard-interactive', '', '', '', ['Password:'], finish)
    expect(finish).toHaveBeenCalledWith([])
    client.emit('ready')
    await pending
  })
})

describe('openJumpSocket', () => {
  it('resolves with the forwarded stream', async () => {
    const via = new Client() as unknown as FakeSshClient
    const sock = await openJumpSocket(via as never, 'inner.example.com', 2200)
    expect(sock).toEqual({ tunnelTo: 'inner.example.com:2200' })
    expect(via.forwardOutCalls).toEqual([{ destHost: 'inner.example.com', destPort: 2200 }])
  })

  it('rejects with a ConnectionError naming the unreachable destination', async () => {
    fakeSsh.forwardOutImpl = (_h, _p, cb) => cb(new Error('administratively prohibited'))
    const via = new Client() as unknown as FakeSshClient
    await expect(openJumpSocket(via as never, 'inner.example.com', 2200))
      .rejects.toThrow('Jump host could not reach inner.example.com:2200: administratively prohibited')
  })
})

describe('credentialsForSession', () => {
  it('rejects key auth without a configured key file', async () => {
    await expect(credentialsForSession(session({ authType: 'key' })))
      .rejects.toThrow(ValidationError)
    await expect(credentialsForSession(session({ authType: 'key' })))
      .rejects.toThrow('Prod Web: key authentication selected but no key file configured')
  })

  it('rejects key paths outside the allowlist with the checker\'s reason', async () => {
    vi.mocked(isAllowedKeyPath).mockReturnValue({ ok: false, reason: 'Key file is outside your home directory' })
    await expect(credentialsForSession(session({ authType: 'key', keyPath: '/etc/shadow' })))
      .rejects.toThrow('Key file is outside your home directory')
  })

  it('reads the private key from the resolved allowlisted path', async () => {
    const creds = await credentialsForSession(session({ authType: 'key', keyPath: '~/.ssh/id_ed25519' }))
    expect(isAllowedKeyPath).toHaveBeenCalledWith('~/.ssh/id_ed25519')
    expect(readFileSync).toHaveBeenCalledWith('/home/me/.ssh/id_ed25519', 'utf-8')
    expect(creds).toEqual({ privateKey: 'PRIVATE KEY DATA' })
  })

  it('rejects password auth while the app is locked', async () => {
    vi.mocked(isUnlocked).mockReturnValue(false)
    await expect(credentialsForSession(session())).rejects.toThrow(AuthError)
    expect(getCredential).not.toHaveBeenCalled()
  })

  it('rejects when no password is stored for the session', async () => {
    vi.mocked(getCredential).mockResolvedValue(null)
    await expect(credentialsForSession(session())).rejects.toThrow('No password stored for Prod Web')
  })

  it('returns the stored password', async () => {
    await expect(credentialsForSession(session())).resolves.toEqual({ password: 'secret-pw' })
    expect(getCredential).toHaveBeenCalledWith('s1', 'password')
  })
})

describe('connectSessionClient', () => {
  it('rejects unknown sessions', async () => {
    vi.mocked(getSessionById).mockReturnValue(undefined)
    await expect(connectSessionClient('missing')).rejects.toThrow(NotFoundError)
  })

  it('rejects sessions missing a host or username', async () => {
    vi.mocked(getSessionById).mockReturnValue(session({ host: '' }))
    await expect(connectSessionClient('s1')).rejects.toThrow(ValidationError)
    vi.mocked(getSessionById).mockReturnValue(session({ username: '' }))
    await expect(connectSessionClient('s1')).rejects.toThrow('Prod Web is missing a host or username')
  })

  it('connects with keychain credentials and disposes exactly once', async () => {
    vi.mocked(getSessionById).mockReturnValue(session())
    const managed = await connectSessionClient('s1')
    const client = lastClient()
    expect(client.connectConfig).toMatchObject({
      host: 'web.example.com',
      port: 22,
      username: 'deploy',
      password: 'secret-pw',
    })

    managed.dispose()
    managed.dispose()
    expect(client.end).toHaveBeenCalledTimes(1)
  })

  it('disposes itself when the client closes', async () => {
    vi.mocked(getSessionById).mockReturnValue(session())
    await connectSessionClient('s1')
    const client = lastClient()
    client.emit('close')
    expect(client.end).toHaveBeenCalledTimes(1)
  })

  it('logs instead of throwing when ending the client fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getSessionById).mockReturnValue(session())
    const managed = await connectSessionClient('s1')
    lastClient().end.mockImplementation(() => { throw new Error('already gone') })

    expect(() => managed.dispose()).not.toThrow()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[ssh] end client for s1'))
  })

  it('tunnels through a jump host and tears down the whole chain on dispose', async () => {
    const bastion = session({ id: 'bastion', label: 'Bastion', host: 'bastion.example.com' })
    const leaf = session({ id: 'leaf', label: 'Leaf', host: 'leaf.internal', port: 2222, jumpHostId: 'bastion' })
    vi.mocked(getSessionById).mockImplementation((id: string) => (id === 'bastion' ? bastion : id === 'leaf' ? leaf : undefined))

    const managed = await connectSessionClient('leaf')
    expect(fakeSsh.clients).toHaveLength(2)
    const bastionClient = fakeSsh.clients[0] as FakeSshClient
    const leafClient = fakeSsh.clients[1] as FakeSshClient

    expect(bastionClient.connectConfig.host).toBe('bastion.example.com')
    expect(bastionClient.forwardOutCalls).toEqual([{ destHost: 'leaf.internal', destPort: 2222 }])
    expect(leafClient.connectConfig).toMatchObject({
      host: 'leaf.internal',
      port: 2222,
      sock: { tunnelTo: 'leaf.internal:2222' },
    })

    managed.dispose()
    expect(leafClient.end).toHaveBeenCalled()
    expect(bastionClient.end).toHaveBeenCalled()
  })

  it('rejects jump chains deeper than three hops', async () => {
    vi.mocked(getSessionById).mockImplementation((id: string) => session({ id, jumpHostId: id }))
    await expect(connectSessionClient('loop')).rejects.toThrow(ConnectionError)
    await expect(connectSessionClient('loop')).rejects.toThrow('Jump host chain deeper than 3 hops')
    expect(fakeSsh.clients).toHaveLength(0)
  })

  it('disposes the bastion when the jump tunnel cannot be opened', async () => {
    const bastion = session({ id: 'bastion', host: 'bastion.example.com' })
    const leaf = session({ id: 'leaf', host: 'leaf.internal', jumpHostId: 'bastion' })
    vi.mocked(getSessionById).mockImplementation((id: string) => (id === 'bastion' ? bastion : leaf))
    fakeSsh.forwardOutImpl = (_h, _p, cb) => cb(new Error('no route'))

    await expect(connectSessionClient('leaf')).rejects.toThrow(ConnectionError)
    expect((fakeSsh.clients[0] as FakeSshClient).end).toHaveBeenCalled()
  })

  it('disposes the bastion when the leaf credentials are unavailable', async () => {
    const bastion = session({ id: 'bastion', host: 'bastion.example.com' })
    const leaf = session({ id: 'leaf', host: 'leaf.internal', jumpHostId: 'bastion' })
    vi.mocked(getSessionById).mockImplementation((id: string) => (id === 'bastion' ? bastion : leaf))
    vi.mocked(getCredential).mockImplementation(async (id: string) => (id === 'bastion' ? 'secret-pw' : null))

    await expect(connectSessionClient('leaf')).rejects.toThrow(AuthError)
    expect((fakeSsh.clients[0] as FakeSshClient).end).toHaveBeenCalled()
  })

  it('disposes the bastion when the leaf connection fails', async () => {
    const bastion = session({ id: 'bastion', host: 'bastion.example.com' })
    const leaf = session({ id: 'leaf', host: 'leaf.internal', jumpHostId: 'bastion' })
    vi.mocked(getSessionById).mockImplementation((id: string) => (id === 'bastion' ? bastion : leaf))
    fakeSsh.connectImpl = (client) => {
      const isLeaf = fakeSsh.clients.indexOf(client) === 1
      queueMicrotask(() => {
        const c = client as FakeSshClient
        if (isLeaf) c.emit('error', new Error('auth failed'))
        else c.emit('ready')
      })
    }

    await expect(connectSessionClient('leaf')).rejects.toThrow(ConnectionError)
    expect((fakeSsh.clients[0] as FakeSshClient).end).toHaveBeenCalled()
  })
})
