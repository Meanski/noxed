import { ipcMain, IpcMainInvokeEvent } from 'electron'
import Redis from 'ioredis'
import { randomUUID } from 'crypto'
import { isBlockedRedisCommand, validateHost, validatePort } from './security'
import { ConnectionError, NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'

interface RedisEntry {
  client: Redis
  senderId: number
  lastError?: string
}

interface RedisConnectConfig {
  host: string
  port: number
  password?: string
  db: number
}

const clients = new Map<string, RedisEntry>()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_KEY_BYTES = 4 * 1024
const MAX_VALUE_BYTES = 1 * 1024 * 1024
const MAX_PATTERN_BYTES = 512
const MAX_COMMAND_BYTES = 16 * 1024
const MAX_KEYS_PER_CALL = 256
const MAX_TTL_SECONDS = 60 * 60 * 24 * 365

function validateClientId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new ValidationError('Invalid Redis client id')
  return id
}

function validateRedisString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string') throw new ValidationError(`Invalid Redis ${label}`)
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ValidationError(`Redis ${label} exceeds ${maxBytes} bytes`)
  }
  return value
}

function validateConnectConfig(raw: unknown): RedisConnectConfig {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Invalid Redis config')
  const c = raw as Record<string, unknown>
  const host = validateHost(c.host, 'Redis host')
  const port = validatePort(c.port ?? 6379, 'Redis port')
  if (c.password !== undefined && typeof c.password !== 'string') {
    throw new ValidationError('Invalid Redis password')
  }
  const db = c.db === undefined ? 0 : Number(c.db)
  if (!Number.isInteger(db) || db < 0 || db > 15) {
    throw new ValidationError('Invalid Redis database number (0-15)')
  }
  return { host, port, password: c.password as string | undefined, db }
}

function requireOwnedClient(event: IpcMainInvokeEvent, rawId: unknown): RedisEntry {
  const id = validateClientId(rawId)
  const entry = clients.get(id)
  if (!entry) throw new NotFoundError('Redis client')
  if (entry.senderId !== event.sender.id) throw new OwnershipError('Redis client')
  return entry
}

function disposeClient(id: string): void {
  const entry = clients.get(id)
  if (!entry) return
  clients.delete(id)
  entry.client.removeAllListeners()
  entry.client.disconnect()
}

export function registerRedisHandlers(): void {
  ipcMain.handle('redis:connect', async (event, rawConfig: unknown) => {
    const config = validateConnectConfig(rawConfig)
    const id = randomUUID()
    const client = new Redis({
      host: config.host,
      port: config.port,
      password: config.password || undefined,
      db: config.db,
      lazyConnect: true,
      connectTimeout: 15000,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      // Don't auto-reconnect forever — surface failures so the renderer can
      // show real status instead of pretending the connection is healthy.
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 2000)),
    })

    const senderId = event.sender.id
    const entry: RedisEntry = { client, senderId }

    // ioredis emits 'error' for both connect failures and runtime errors. Without
    // a listener Node throws "Unhandled error event" and crashes the main process.
    client.on('error', (err) => { entry.lastError = toMessage(err) })

    try {
      await client.connect()
    } catch (err) {
      client.removeAllListeners()
      client.disconnect()
      throw new ConnectionError(toMessage(err))
    }

    clients.set(id, entry)
    return id
  })

  ipcMain.handle('redis:disconnect', async (event, rawId: unknown) => {
    const entry = requireOwnedClient(event, rawId)
    const id = validateClientId(rawId)
    try {
      await entry.client.quit()
    } catch {
      entry.client.disconnect()
    } finally {
      disposeClient(id)
    }
  })

  ipcMain.handle('redis:info', async (event, rawId: unknown) => {
    return requireOwnedClient(event, rawId).client.info()
  })

  ipcMain.handle('redis:keys', async (event, rawId: unknown, rawPattern: unknown) => {
    const { client } = requireOwnedClient(event, rawId)
    const pattern = validateRedisString(rawPattern ?? '*', 'pattern', MAX_PATTERN_BYTES)
    const keys: string[] = []
    const MAX_KEYS = 10_000
    return new Promise<string[]>((resolve, reject) => {
      const stream = client.scanStream({ match: pattern || '*', count: 200 })
      stream.on('data', (batch: string[]) => {
        keys.push(...batch)
        if (keys.length >= MAX_KEYS) stream.destroy()
      })
      stream.on('end', () => resolve([...new Set(keys)].slice(0, MAX_KEYS)))
      stream.on('error', (err) => reject(new ConnectionError(toMessage(err))))
    })
  })

  ipcMain.handle('redis:get', async (event, rawId: unknown, rawKey: unknown) => {
    const { client } = requireOwnedClient(event, rawId)
    const key = validateRedisString(rawKey, 'key', MAX_KEY_BYTES)
    const type = await client.type(key)
    switch (type) {
      case 'string': return { type, value: await client.get(key), ttl: await client.ttl(key) }
      case 'hash': return { type, value: await client.hgetall(key), ttl: await client.ttl(key) }
      case 'list': return { type, value: await client.lrange(key, 0, 99), ttl: await client.ttl(key) }
      case 'set': return { type, value: await client.smembers(key), ttl: await client.ttl(key) }
      case 'zset': return { type, value: await client.zrange(key, 0, 99, 'WITHSCORES'), ttl: await client.ttl(key) }
      default: return { type, value: null, ttl: -1 }
    }
  })

  ipcMain.handle('redis:set', async (event, rawId: unknown, rawKey: unknown, rawValue: unknown, rawTtl?: unknown) => {
    const { client } = requireOwnedClient(event, rawId)
    const key = validateRedisString(rawKey, 'key', MAX_KEY_BYTES)
    const value = validateRedisString(rawValue, 'value', MAX_VALUE_BYTES)
    if (rawTtl !== undefined && rawTtl !== null) {
      const ttl = Number(rawTtl)
      if (!Number.isFinite(ttl) || ttl < 0 || ttl > MAX_TTL_SECONDS) {
        throw new ValidationError('Invalid TTL')
      }
      if (ttl > 0) return client.set(key, value, 'EX', Math.floor(ttl))
    }
    return client.set(key, value)
  })

  ipcMain.handle('redis:del', async (event, rawId: unknown, ...rawKeys: unknown[]) => {
    const { client } = requireOwnedClient(event, rawId)
    if (rawKeys.length === 0) return 0
    if (rawKeys.length > MAX_KEYS_PER_CALL) {
      throw new ValidationError(`Cannot delete more than ${MAX_KEYS_PER_CALL} keys at once`)
    }
    const keys = rawKeys.map((k) => validateRedisString(k, 'key', MAX_KEY_BYTES))
    return client.del(...keys)
  })

  ipcMain.handle('redis:command', async (event, rawId: unknown, rawCommand: unknown) => {
    const { client } = requireOwnedClient(event, rawId)
    const command = validateRedisString(rawCommand, 'command', MAX_COMMAND_BYTES).trim()
    if (command.length === 0) throw new ValidationError('Empty command')
    if (isBlockedRedisCommand(command)) {
      const verb = command.split(/\s+/)[0].toUpperCase()
      throw new ValidationError(`Command blocked for safety: "${verb}" is not allowed`)
    }
    const parts = command.split(/\s+/)
    const cmd = parts[0]
    const args = parts.slice(1)
    try {
      // client.call() routes through ioredis's command parser, so only real
      // Redis verbs are dispatched — never internal client methods.
      return await client.call(cmd, ...args)
    } catch (err) {
      throw new ConnectionError(toMessage(err))
    }
  })
}

export function disposeRedisClientsForSender(senderId: number): void {
  for (const [id, entry] of clients) {
    if (entry.senderId === senderId) disposeClient(id)
  }
}
