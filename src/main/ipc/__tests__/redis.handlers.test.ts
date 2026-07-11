import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const { ipc, fakeRedis } = vi.hoisted(() => ({
  ipc: {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    listeners: new Map<string, (...args: unknown[]) => unknown>(),
  },
  fakeRedis: {
    instances: [] as FakeRedisClient[],
    connectError: null as Error | null,
  },
}))

interface FakeScanStream extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>
}

interface FakeRedisClient extends EventEmitter {
  options: Record<string, unknown>
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  type: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  ttl: ReturnType<typeof vi.fn>
  hgetall: ReturnType<typeof vi.fn>
  lrange: ReturnType<typeof vi.fn>
  smembers: ReturnType<typeof vi.fn>
  zrange: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  del: ReturnType<typeof vi.fn>
  call: ReturnType<typeof vi.fn>
  scanStream: ReturnType<typeof vi.fn>
  lastScanStream: FakeScanStream | undefined
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

vi.mock('ioredis', async () => {
  const { EventEmitter } = await import('node:events')

  class FakeRedis extends EventEmitter {
    options: Record<string, unknown>
    connect = vi.fn(async () => {
      if (fakeRedis.connectError) throw fakeRedis.connectError
    })
    disconnect = vi.fn()
    quit = vi.fn(async () => 'OK')
    info = vi.fn(async () => '# Server\r\nredis_version:7.0.0')
    type = vi.fn(async () => 'string')
    get = vi.fn(async () => 'the-value')
    ttl = vi.fn(async () => 60)
    hgetall = vi.fn(async () => ({ field: 'value' }))
    lrange = vi.fn(async () => ['a', 'b'])
    smembers = vi.fn(async () => ['m1', 'm2'])
    zrange = vi.fn(async () => ['m1', '1', 'm2', '2'])
    set = vi.fn(async () => 'OK')
    del = vi.fn(async () => 2)
    call = vi.fn(async () => 'PONG')
    lastScanStream: FakeScanStream | undefined
    scanStream = vi.fn(() => {
      const stream = new EventEmitter() as FakeScanStream
      stream.destroy = vi.fn()
      this.lastScanStream = stream
      return stream
    })

    constructor(options: Record<string, unknown>) {
      super()
      this.options = options
      fakeRedis.instances.push(this as unknown as FakeRedisClient)
    }
  }

  return { default: FakeRedis }
})

import { registerRedisHandlers, disposeRedisClientsForSender } from '../redis'
import { ValidationError, OwnershipError, ConnectionError, NotFoundError } from '../errors'

registerRedisHandlers()

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

const VALID_CONFIG = { host: '127.0.0.1', port: 6379, db: 0 }

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`${channel} handler not registered`)
  return Promise.resolve(handler(...args))
}

async function connect(event: FakeEvent = makeEvent(), config: unknown = VALID_CONFIG) {
  const id = (await invoke('redis:connect', event, config)) as string
  const client = fakeRedis.instances.at(-1)
  if (!client) throw new Error('no redis client created')
  return { id, client, event }
}

afterEach(() => {
  fakeRedis.connectError = null
})

describe('redis:connect', () => {
  it('resolves with a uuid and configures the client from the validated config', async () => {
    const { id, client } = await connect(makeEvent(), {
      host: 'redis.example.com',
      port: '6380',
      password: 'secret',
      db: 3,
    })
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(client.options).toMatchObject({
      host: 'redis.example.com',
      port: 6380,
      password: 'secret',
      db: 3,
      lazyConnect: true,
      connectTimeout: 15000,
      maxRetriesPerRequest: 2,
    })
    expect(client.connect).toHaveBeenCalled()
  })

  it('defaults the port and db and maps an empty password to undefined', async () => {
    const { client } = await connect(makeEvent(), { host: 'localhost', password: '' })
    expect(client.options).toMatchObject({ host: 'localhost', port: 6379, db: 0 })
    expect(client.options.password).toBeUndefined()
  })

  it('gives up retrying after three attempts', async () => {
    const { client } = await connect()
    const retryStrategy = client.options.retryStrategy as (times: number) => number | null
    expect(retryStrategy(1)).toBe(500)
    expect(retryStrategy(3)).toBe(1500)
    expect(retryStrategy(4)).toBeNull()
    expect(retryStrategy(10)).toBeNull()
  })

  it('rejects with a ConnectionError and disposes the client when connecting fails', async () => {
    fakeRedis.connectError = new Error('ECONNREFUSED 127.0.0.1:6379')
    const pending = invoke('redis:connect', makeEvent(), VALID_CONFIG)
    await expect(pending).rejects.toThrow(ConnectionError)
    await expect(pending).rejects.toThrow('ECONNREFUSED')
    const client = fakeRedis.instances.at(-1)
    expect(client?.disconnect).toHaveBeenCalled()
    expect(client?.listenerCount('error')).toBe(0)
  })

  it('records runtime errors without crashing the process', async () => {
    const { client } = await connect()
    expect(() => client.emit('error', new Error('read ECONNRESET'))).not.toThrow()
  })

  it('rejects malformed configs', async () => {
    const event = makeEvent()
    await expect(invoke('redis:connect', event, null)).rejects.toThrow(ValidationError)
    await expect(invoke('redis:connect', event, 'nope')).rejects.toThrow(ValidationError)
    await expect(invoke('redis:connect', event, { host: 'bad host!' })).rejects.toThrow('illegal characters')
    await expect(invoke('redis:connect', event, { host: '' })).rejects.toThrow('Invalid Redis host')
    await expect(invoke('redis:connect', event, { host: 'localhost', port: 0 })).rejects.toThrow('Invalid Redis port')
    await expect(invoke('redis:connect', event, { host: 'localhost', port: 70000 })).rejects.toThrow('Invalid Redis port')
    await expect(invoke('redis:connect', event, { host: 'localhost', password: 42 })).rejects.toThrow('Invalid Redis password')
    await expect(invoke('redis:connect', event, { host: 'localhost', db: 16 })).rejects.toThrow('Invalid Redis database number')
    await expect(invoke('redis:connect', event, { host: 'localhost', db: -1 })).rejects.toThrow('Invalid Redis database number')
    await expect(invoke('redis:connect', event, { host: 'localhost', db: 1.5 })).rejects.toThrow('Invalid Redis database number')
  })
})

describe('ownership and id validation', () => {
  it('rejects invalid client ids with a ValidationError', async () => {
    const event = makeEvent()
    await expect(invoke('redis:info', event, 'not-a-uuid')).rejects.toThrow(ValidationError)
    await expect(invoke('redis:info', event, 42)).rejects.toThrow(ValidationError)
    await expect(invoke('redis:info', event, undefined)).rejects.toThrow(ValidationError)
  })

  it('rejects unknown client ids with a NotFoundError', async () => {
    await expect(invoke('redis:info', makeEvent(), '11111111-1111-4111-8111-111111111111'))
      .rejects.toThrow(NotFoundError)
  })

  it('rejects every channel when another window supplies a foreign sender id', async () => {
    const { id } = await connect()
    const intruder = makeEvent()
    await expect(invoke('redis:disconnect', intruder, id)).rejects.toThrow(OwnershipError)
    await expect(invoke('redis:info', intruder, id)).rejects.toThrow(OwnershipError)
    await expect(invoke('redis:keys', intruder, id, '*')).rejects.toThrow(OwnershipError)
    await expect(invoke('redis:get', intruder, id, 'k')).rejects.toThrow(OwnershipError)
    await expect(invoke('redis:set', intruder, id, 'k', 'v')).rejects.toThrow(OwnershipError)
    await expect(invoke('redis:del', intruder, id, 'k')).rejects.toThrow(OwnershipError)
    await expect(invoke('redis:command', intruder, id, 'PING')).rejects.toThrow(OwnershipError)
  })
})

describe('redis:info', () => {
  it('returns the raw INFO payload for the owner', async () => {
    const { id, client, event } = await connect()
    await expect(invoke('redis:info', event, id)).resolves.toContain('redis_version')
    expect(client.info).toHaveBeenCalled()
  })
})

describe('redis:keys', () => {
  it('scans with the given pattern and resolves deduplicated keys', async () => {
    const { id, client, event } = await connect()
    const pending = invoke('redis:keys', event, id, 'user:*')
    await new Promise((r) => setImmediate(r))
    expect(client.scanStream).toHaveBeenCalledWith({ match: 'user:*', count: 200 })
    const stream = client.lastScanStream
    if (!stream) throw new Error('no scan stream created')
    stream.emit('data', ['user:1', 'user:2'])
    stream.emit('data', ['user:2', 'user:3'])
    stream.emit('end')
    await expect(pending).resolves.toEqual(['user:1', 'user:2', 'user:3'])
  })

  it('falls back to * when the pattern is missing or empty', async () => {
    const { id, client, event } = await connect()
    const first = invoke('redis:keys', event, id, undefined)
    await new Promise((r) => setImmediate(r))
    client.lastScanStream?.emit('end')
    await expect(first).resolves.toEqual([])
    expect(client.scanStream).toHaveBeenLastCalledWith({ match: '*', count: 200 })

    const second = invoke('redis:keys', event, id, '')
    await new Promise((r) => setImmediate(r))
    client.lastScanStream?.emit('end')
    await expect(second).resolves.toEqual([])
    expect(client.scanStream).toHaveBeenLastCalledWith({ match: '*', count: 200 })
  })

  it('stops scanning and truncates once 10k keys have arrived', async () => {
    const { id, client, event } = await connect()
    const pending = invoke('redis:keys', event, id, '*')
    await new Promise((r) => setImmediate(r))
    const stream = client.lastScanStream
    if (!stream) throw new Error('no scan stream created')
    const batch = Array.from({ length: 10_001 }, (_, i) => `key:${i}`)
    stream.emit('data', batch)
    expect(stream.destroy).toHaveBeenCalled()
    stream.emit('end')
    const keys = (await pending) as string[]
    expect(keys).toHaveLength(10_000)
  })

  it('rejects with a ConnectionError when the scan stream errors', async () => {
    const { id, client, event } = await connect()
    const pending = invoke('redis:keys', event, id, '*')
    await new Promise((r) => setImmediate(r))
    client.lastScanStream?.emit('error', new Error('LOADING Redis is loading the dataset'))
    await expect(pending).rejects.toThrow(ConnectionError)
    await expect(pending).rejects.toThrow('LOADING')
  })

  it('rejects oversized and non-string patterns', async () => {
    const { id, event } = await connect()
    await expect(invoke('redis:keys', event, id, 'p'.repeat(513))).rejects.toThrow('pattern exceeds 512 bytes')
    await expect(invoke('redis:keys', event, id, 42)).rejects.toThrow(ValidationError)
  })
})

describe('redis:get', () => {
  it('returns string values with their ttl', async () => {
    const { id, client, event } = await connect()
    await expect(invoke('redis:get', event, id, 'greeting')).resolves.toEqual({
      type: 'string',
      value: 'the-value',
      ttl: 60,
    })
    expect(client.get).toHaveBeenCalledWith('greeting')
  })

  it('returns hash, list, set, and zset values by type', async () => {
    const { id, client, event } = await connect()

    client.type.mockResolvedValueOnce('hash')
    await expect(invoke('redis:get', event, id, 'h')).resolves.toEqual({
      type: 'hash',
      value: { field: 'value' },
      ttl: 60,
    })
    expect(client.hgetall).toHaveBeenCalledWith('h')

    client.type.mockResolvedValueOnce('list')
    await expect(invoke('redis:get', event, id, 'l')).resolves.toEqual({
      type: 'list',
      value: ['a', 'b'],
      ttl: 60,
    })
    expect(client.lrange).toHaveBeenCalledWith('l', 0, 99)

    client.type.mockResolvedValueOnce('set')
    await expect(invoke('redis:get', event, id, 's')).resolves.toEqual({
      type: 'set',
      value: ['m1', 'm2'],
      ttl: 60,
    })
    expect(client.smembers).toHaveBeenCalledWith('s')

    client.type.mockResolvedValueOnce('zset')
    await expect(invoke('redis:get', event, id, 'z')).resolves.toEqual({
      type: 'zset',
      value: ['m1', '1', 'm2', '2'],
      ttl: 60,
    })
    expect(client.zrange).toHaveBeenCalledWith('z', 0, 99, 'WITHSCORES')
  })

  it('returns a null value for missing or exotic types', async () => {
    const { id, client, event } = await connect()
    client.type.mockResolvedValueOnce('none')
    await expect(invoke('redis:get', event, id, 'gone')).resolves.toEqual({
      type: 'none',
      value: null,
      ttl: -1,
    })
  })

  it('rejects oversized and non-string keys', async () => {
    const { id, event } = await connect()
    await expect(invoke('redis:get', event, id, 'k'.repeat(4 * 1024 + 1))).rejects.toThrow('key exceeds 4096 bytes')
    await expect(invoke('redis:get', event, id, { key: 'x' })).rejects.toThrow(ValidationError)
  })
})

describe('redis:set', () => {
  it('sets a plain value without a ttl', async () => {
    const { id, client, event } = await connect()
    await expect(invoke('redis:set', event, id, 'k', 'v')).resolves.toBe('OK')
    expect(client.set).toHaveBeenCalledWith('k', 'v')
  })

  it('treats a null ttl like no ttl', async () => {
    const { id, client, event } = await connect()
    await invoke('redis:set', event, id, 'k', 'v', null)
    expect(client.set).toHaveBeenCalledWith('k', 'v')
  })

  it('applies a positive ttl with EX, flooring fractions', async () => {
    const { id, client, event } = await connect()
    await invoke('redis:set', event, id, 'k', 'v', 90.7)
    expect(client.set).toHaveBeenCalledWith('k', 'v', 'EX', 90)
  })

  it('accepts a numeric string ttl', async () => {
    const { id, client, event } = await connect()
    await invoke('redis:set', event, id, 'k', 'v', '30')
    expect(client.set).toHaveBeenCalledWith('k', 'v', 'EX', 30)
  })

  it('a ttl of zero means no expiry', async () => {
    const { id, client, event } = await connect()
    await invoke('redis:set', event, id, 'k', 'v', 0)
    expect(client.set).toHaveBeenCalledWith('k', 'v')
  })

  it('rejects invalid ttls', async () => {
    const { id, client, event } = await connect()
    await expect(invoke('redis:set', event, id, 'k', 'v', -1)).rejects.toThrow('Invalid TTL')
    await expect(invoke('redis:set', event, id, 'k', 'v', 'soon')).rejects.toThrow('Invalid TTL')
    await expect(invoke('redis:set', event, id, 'k', 'v', Infinity)).rejects.toThrow('Invalid TTL')
    await expect(invoke('redis:set', event, id, 'k', 'v', 60 * 60 * 24 * 365 + 1)).rejects.toThrow('Invalid TTL')
    expect(client.set).not.toHaveBeenCalled()
  })

  it('rejects oversized values and invalid keys', async () => {
    const { id, event } = await connect()
    await expect(invoke('redis:set', event, id, 'k', 'v'.repeat(1024 * 1024 + 1)))
      .rejects.toThrow('value exceeds 1048576 bytes')
    await expect(invoke('redis:set', event, id, 'k', 42)).rejects.toThrow('Invalid Redis value')
    await expect(invoke('redis:set', event, id, null, 'v')).rejects.toThrow('Invalid Redis key')
  })
})

describe('redis:del', () => {
  it('deletes the given keys', async () => {
    const { id, client, event } = await connect()
    await expect(invoke('redis:del', event, id, 'a', 'b')).resolves.toBe(2)
    expect(client.del).toHaveBeenCalledWith('a', 'b')
  })

  it('returns 0 without touching redis when no keys are given', async () => {
    const { id, client, event } = await connect()
    await expect(invoke('redis:del', event, id)).resolves.toBe(0)
    expect(client.del).not.toHaveBeenCalled()
  })

  it('rejects more than 256 keys per call', async () => {
    const { id, client, event } = await connect()
    const keys = Array.from({ length: 257 }, (_, i) => `k${i}`)
    await expect(invoke('redis:del', event, id, ...keys))
      .rejects.toThrow('Cannot delete more than 256 keys at once')
    expect(client.del).not.toHaveBeenCalled()
  })

  it('rejects non-string keys', async () => {
    const { id, client, event } = await connect()
    await expect(invoke('redis:del', event, id, 'ok', 42)).rejects.toThrow('Invalid Redis key')
    expect(client.del).not.toHaveBeenCalled()
  })
})

describe('redis:command', () => {
  it('dispatches the verb and arguments through client.call', async () => {
    const { id, client, event } = await connect()
    await expect(invoke('redis:command', event, id, '  GET   user:1  ')).resolves.toBe('PONG')
    expect(client.call).toHaveBeenCalledWith('GET', 'user:1')
  })

  it('handles single-word commands', async () => {
    const { id, client, event } = await connect()
    await invoke('redis:command', event, id, 'PING')
    expect(client.call).toHaveBeenCalledWith('PING')
  })

  it('rejects blocked commands regardless of case, naming the verb', async () => {
    const { id, client, event } = await connect()
    await expect(invoke('redis:command', event, id, 'flushall'))
      .rejects.toThrow('Command blocked for safety: "FLUSHALL" is not allowed')
    await expect(invoke('redis:command', event, id, 'CONFIG GET maxmemory'))
      .rejects.toThrow('"CONFIG" is not allowed')
    await expect(invoke('redis:command', event, id, 'Shutdown NOSAVE')).rejects.toThrow(ValidationError)
    expect(client.call).not.toHaveBeenCalled()
  })

  it('rejects empty, non-string, and oversized commands', async () => {
    const { id, event } = await connect()
    await expect(invoke('redis:command', event, id, '   ')).rejects.toThrow('Empty command')
    await expect(invoke('redis:command', event, id, 42)).rejects.toThrow('Invalid Redis command')
    await expect(invoke('redis:command', event, id, `GET ${'x'.repeat(16 * 1024)}`))
      .rejects.toThrow('command exceeds 16384 bytes')
  })

  it('wraps execution failures in a ConnectionError', async () => {
    const { id, client, event } = await connect()
    client.call.mockRejectedValueOnce(new Error('ERR unknown command'))
    const pending = invoke('redis:command', event, id, 'NOTACOMMAND')
    await expect(pending).rejects.toThrow(ConnectionError)
    await expect(pending).rejects.toThrow('ERR unknown command')
  })
})

describe('redis:disconnect and cleanup', () => {
  it('quits gracefully and disposes the client', async () => {
    const { id, client, event } = await connect()
    await invoke('redis:disconnect', event, id)
    expect(client.quit).toHaveBeenCalled()
    expect(client.disconnect).toHaveBeenCalled()

    // The client is gone: further calls report NotFoundError
    await expect(invoke('redis:info', event, id)).rejects.toThrow(NotFoundError)
  })

  it('force-disconnects when quit fails', async () => {
    const { id, client, event } = await connect()
    client.quit.mockRejectedValueOnce(new Error('Connection is closed.'))
    await invoke('redis:disconnect', event, id)
    expect(client.disconnect).toHaveBeenCalled()
    await expect(invoke('redis:info', event, id)).rejects.toThrow(NotFoundError)
  })

  it('disposeRedisClientsForSender tears down only that sender\'s clients', async () => {
    const mine = await connect()
    const other = await connect()
    disposeRedisClientsForSender(mine.event.sender.id)

    expect(mine.client.disconnect).toHaveBeenCalled()
    expect(other.client.disconnect).not.toHaveBeenCalled()

    await expect(invoke('redis:info', mine.event, mine.id)).rejects.toThrow(NotFoundError)
    await expect(invoke('redis:info', other.event, other.id)).resolves.toContain('redis_version')
  })
})
