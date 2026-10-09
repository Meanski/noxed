import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) } }))

const fake = vi.hoisted(() => ({
  clients: [] as Array<{ url: string; options: Record<string, unknown>; close: ReturnType<typeof vi.fn> }>,
  connectError: null as Error | null,
  calls: [] as Array<[string, ...unknown[]]>,
  docs: [] as unknown[],
  matched: 1,
}))
vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>()
  class MongoClient {
    close = vi.fn(async () => undefined)
    constructor(public url: string, public options: Record<string, unknown>) {
      fake.clients.push(this as never)
    }
    async connect() { if (fake.connectError) throw fake.connectError }
    db(name: string) {
      return {
        command: async () => ({ ok: 1 }),
        admin: () => ({ listDatabases: async () => ({ databases: [{ name: 'shop', sizeOnDisk: 4096 }, { name: 'admin' }] }) }),
        listCollections: () => ({ toArray: async () => [{ name: 'orders' }, { name: 'carts' }] }),
        collection: (coll: string) => ({
          find: (filter: unknown) => {
            fake.calls.push(['find', name, coll, filter])
            const cursor = {
              sort: (s: unknown) => { fake.calls.push(['sort', s]); return cursor },
              skip: (n: number) => { fake.calls.push(['skip', n]); return cursor },
              limit: (n: number) => { fake.calls.push(['limit', n]); return cursor },
              toArray: async () => fake.docs,
            }
            return cursor
          },
          countDocuments: async () => 42,
          estimatedDocumentCount: async () => 1000,
          insertOne: async (doc: unknown) => { fake.calls.push(['insert', doc]); return { insertedId: new actual.ObjectId('65a000000000000000000001') } },
          replaceOne: async (filter: unknown, doc: unknown) => { fake.calls.push(['replace', filter, doc]); return { matchedCount: fake.matched } },
          deleteOne: async (filter: unknown) => { fake.calls.push(['delete', filter]); return { deletedCount: fake.matched } },
        }),
      }
    }
  }
  return { ...actual, MongoClient }
})

import { Double, Int32, ObjectId } from 'mongodb'
import { disposeMongoClientsForSender, mongoUrl, registerMongoHandlers, validateMongoConfig } from '../mongo'
import { ConnectionError, NotFoundError, OwnershipError, ValidationError } from '../errors'

registerMongoHandlers()
const owner = { sender: { id: 8, isDestroyed: () => false } }
const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!(owner, ...args) as Promise<unknown>
const connect = () => call('mongo:connect', { host: 'db.lan', port: 27017, username: 'app', password: 'pw', authSource: 'admin' }) as Promise<string>

beforeEach(() => {
  fake.clients.length = 0
  fake.calls.length = 0
  fake.connectError = null
  fake.docs = []
  fake.matched = 1
})

describe('MongoDB connections', () => {
  it('builds the URL from validated parts only', () => {
    expect(mongoUrl(validateMongoConfig({ host: 'db.lan', port: 27018 }))).toBe('mongodb://db.lan:27018')
    expect(mongoUrl(validateMongoConfig({ host: 'cluster0.abc.mongodb.net', srv: true }))).toBe('mongodb+srv://cluster0.abc.mongodb.net')
    expect(mongoUrl(validateMongoConfig({ host: '::1', port: 27017 }))).toBe('mongodb://[::1]:27017')
    expect(() => validateMongoConfig({ host: 'db/evil?x=1', port: 1 })).toThrow()
    expect(() => validateMongoConfig({ host: 'h', username: 42 })).toThrow(ValidationError)
    expect(() => validateMongoConfig(null)).toThrow(ValidationError)
  })

  it('connects with credentials as options, and TLS for SRV hosts', async () => {
    await connect()
    expect(fake.clients[0].url).toBe('mongodb://db.lan:27017')
    expect(fake.clients[0].options).toMatchObject({ auth: { username: 'app', password: 'pw' }, authSource: 'admin', tls: false })
    await call('mongo:connect', { host: 'cluster0.example.net', srv: true })
    expect(fake.clients[1].options).toMatchObject({ auth: undefined, tls: true })
  })

  it('reports a failed connection and closes the client', async () => {
    fake.connectError = new Error('Authentication failed.')
    await expect(connect()).rejects.toThrow(ConnectionError)
    await expect(connect()).rejects.toThrow('Could not connect to MongoDB: Authentication failed.')
    expect(fake.clients[0].close).toHaveBeenCalled()
  })

  it('closes the client when its window closed while connecting', async () => {
    const closing = { sender: { id: 8, isDestroyed: () => true } }
    await expect(handlers.get('mongo:connect')!(closing, { host: 'db.lan', port: 27017 }) as Promise<string>).rejects.toThrow('window closed')
    expect(fake.clients[0].close).toHaveBeenCalled()
  })

  it('lists databases and collections, sorted', async () => {
    const id = await connect()
    expect(await call('mongo:databases', id)).toEqual([{ name: 'admin', sizeOnDisk: 0 }, { name: 'shop', sizeOnDisk: 4096 }])
    expect(await call('mongo:collections', id, 'shop')).toEqual(['carts', 'orders'])
  })

  it('finds documents as Extended JSON, keeping ObjectIds and dates', async () => {
    const id = await connect()
    fake.docs = [{ _id: new ObjectId('65a000000000000000000002'), at: new Date('2026-01-01T00:00:00Z'), qty: 3 }]
    const result = (await call('mongo:find', id, 'shop', 'orders', { filter: '{"_id": {"$oid": "65a000000000000000000002"}}', sort: '{"at": -1}', limit: 20, skip: 40 })) as { documents: Array<{ json: string; display: string }>; total: number }
    expect(result.total).toBe(42)
    expect(JSON.parse(result.documents[0].display)).toEqual({ _id: { $oid: '65a000000000000000000002' }, at: { $date: '2026-01-01T00:00:00Z' }, qty: 3 })
    expect(JSON.parse(result.documents[0].json)).toEqual({ _id: { $oid: '65a000000000000000000002' }, at: { $date: { $numberLong: '1767225600000' } }, qty: { $numberInt: '3' } })
    const filter = fake.calls[0][3] as { _id: ObjectId }
    expect(filter._id).toBeInstanceOf(ObjectId)
    expect(fake.calls.slice(1)).toEqual([['sort', { at: -1 }], ['skip', 40], ['limit', 20]])
  })

  it('counts an unfiltered collection from its metadata', async () => {
    const id = await connect()
    fake.docs = []
    const result = (await call('mongo:find', id, 'shop', 'orders', {})) as { total: number }
    expect(result.total).toBe(1000)
  })

  it('validates queries', async () => {
    const id = await connect()
    for (const bad of [{ limit: 0 }, { limit: 501 }, { skip: -1 }, { filter: 'not json' }, { filter: '[1,2]' }, { sort: '"x"' }]) {
      await expect(call('mongo:find', id, 'shop', 'orders', bad)).rejects.toThrow(ValidationError)
    }
    await expect(async () => call('mongo:find', id, '', 'orders', {})).rejects.toThrow('Invalid database name')
  })

  it('inserts, replaces by _id (never changing it) and deletes', async () => {
    const id = await connect()
    expect(await call('mongo:insert', id, 'shop', 'orders', '{"qty": 1}')).toBe('{"$oid":"65a000000000000000000001"}')
    await call('mongo:replace', id, 'shop', 'orders', '{"_id": {"$oid": "65a000000000000000000002"}}', '{"_id": "sneaky", "qty": 5}')
    const [, filter, doc] = fake.calls.find((c) => c[0] === 'replace')!
    expect((filter as { _id: ObjectId })._id).toBeInstanceOf(ObjectId)
    expect(doc).toEqual({ qty: new Int32(5) })
    await call('mongo:delete', id, 'shop', 'orders', '{"_id": 7}')
    expect(fake.calls.at(-1)).toEqual(['delete', { _id: new Int32(7) }])
  })

  it('keeps numeric BSON types through an edit', async () => {
    const id = await connect()
    await call('mongo:replace', id, 'shop', 'orders', '{"_id": 1}', '{"price": {"$numberDouble": "5.0"}, "qty": {"$numberInt": "2"}}')
    const doc = fake.calls.find((c) => c[0] === 'replace')![2] as { price: unknown; qty: unknown }
    expect(doc.price).toBeInstanceOf(Double)
    expect(doc.qty).toBeInstanceOf(Int32)
  })

  it('says when the document is already gone', async () => {
    const id = await connect()
    fake.matched = 0
    await expect(call('mongo:replace', id, 'shop', 'orders', '{"_id": 1}', '{}')).rejects.toThrow(NotFoundError)
    await expect(call('mongo:delete', id, 'shop', 'orders', '{"_id": 1}')).rejects.toThrow(NotFoundError)
  })

  it('refuses to replace or delete without an _id', async () => {
    const id = await connect()
    await expect(call('mongo:replace', id, 'shop', 'orders', '{}', '{"qty": 1}')).rejects.toThrow('must include _id')
    await expect(call('mongo:delete', id, 'shop', 'orders', '{"name": "x"}')).rejects.toThrow('must include _id')
  })

  it('only serves the window that connected, and cleans up after it', async () => {
    const id = await connect()
    await expect(async () => handlers.get('mongo:databases')!({ sender: { id: 99 } }, id)).rejects.toThrow(OwnershipError)
    await expect(async () => call('mongo:databases', 'nope')).rejects.toThrow(ValidationError)
    await call('mongo:disconnect', id)
    expect(fake.clients[0].close).toHaveBeenCalled()
    await expect(async () => call('mongo:databases', id)).rejects.toThrow(NotFoundError)
    const other = await connect()
    disposeMongoClientsForSender(owner.sender.id)
    await expect(async () => call('mongo:databases', other)).rejects.toThrow(NotFoundError)
  })
})
