import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { BSON, MongoClient, type Document } from 'mongodb'
import { ConnectionError, NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'
import { isUuid, validateHost, validatePort } from './security'

const { EJSON } = BSON

// MongoDB browsing and editing. Documents cross IPC as canonical Extended JSON
// strings, so every BSON type (ObjectIds, dates, Int32 vs Int64 vs Double)
// survives an edit and save; a relaxed copy is sent alongside for display.

interface MongoEntry {
  client: MongoClient
  senderId: number
}

export interface MongoConnectConfig {
  host: string
  port: number
  username?: string
  password?: string
  authSource?: string
  /** mongodb+srv:// (e.g. Atlas): the host is looked up in DNS, no port. */
  srv: boolean
  tls: boolean
}

const clients = new Map<string, MongoEntry>()
const MAX_NAME_LENGTH = 120
const MAX_JSON_BYTES = 1024 * 1024
const MAX_LIMIT = 500
const CONNECT_TIMEOUT_MS = 10_000

function requireName(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_NAME_LENGTH || raw.includes('\0')) {
    throw new ValidationError(`Invalid ${label} name`)
  }
  return raw
}

function optionalString(raw: unknown, label: string, max: number): string | undefined {
  if (raw === undefined || raw === '') return undefined
  if (typeof raw !== 'string' || raw.length > max) throw new ValidationError(`Invalid MongoDB ${label}`)
  return raw
}

export function validateMongoConfig(raw: unknown): MongoConnectConfig {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Invalid MongoDB config')
  const c = raw as Record<string, unknown>
  return {
    host: validateHost(c.host, 'MongoDB host'),
    port: validatePort(c.port ?? 27017, 'MongoDB port'),
    username: optionalString(c.username, 'username', 256),
    password: optionalString(c.password, 'password', 1024),
    authSource: optionalString(c.authSource, 'auth database', MAX_NAME_LENGTH),
    srv: c.srv === true,
    tls: c.tls === true,
  }
}

/** Builds the connection URL from validated parts; user input never becomes the URL itself. */
export function mongoUrl({ host, port, srv }: MongoConnectConfig): string {
  const bracketed = host.includes(':') ? `[${host}]` : host
  return srv ? `mongodb+srv://${bracketed}` : `mongodb://${bracketed}:${port}`
}

/**
 * Parses Extended JSON from the renderer into a plain object (no arrays or
 * scalars). Documents parse canonically so numbers keep their BSON types;
 * queries parse relaxed, since sort directions must be plain numbers.
 */
function parseDocument(raw: unknown, label: string, relaxed = false): Document {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) throw new ValidationError(`Invalid ${label}`)
  let value: unknown
  try {
    value = EJSON.parse(raw === '' ? '{}' : raw, { relaxed })
  } catch (err) {
    throw new ValidationError(`${label} is not valid JSON: ${toMessage(err)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${label} must be a JSON object`)
  return value as Document
}

function parseDocumentId(raw: unknown): Document {
  const { _id } = parseDocument(raw, 'Document id')
  if (_id === undefined) throw new ValidationError('Document id must include _id')
  return { _id }
}

const toEjson = (doc: unknown) => EJSON.stringify(doc, { relaxed: false })
const toDisplay = (doc: unknown) => EJSON.stringify(doc, { relaxed: true })

function requireClient(event: IpcMainInvokeEvent, rawId: unknown): MongoClient {
  if (!isUuid(rawId)) throw new ValidationError('Invalid MongoDB client id')
  const entry = clients.get(rawId)
  if (!entry) throw new NotFoundError('MongoDB client')
  if (entry.senderId !== event.sender.id) throw new OwnershipError('MongoDB client')
  return entry.client
}

function collection(event: IpcMainInvokeEvent, rawId: unknown, rawDb: unknown, rawCollection: unknown) {
  return requireClient(event, rawId).db(requireName(rawDb, 'database')).collection(requireName(rawCollection, 'collection'))
}

function disposeClient(id: string): void {
  const entry = clients.get(id)
  if (!entry) return
  clients.delete(id)
  entry.client.close().catch((err: unknown) => console.error(`[mongo] close ${id}: ${toMessage(err)}`))
}

export function disposeMongoClientsForSender(senderId: number): void {
  for (const [id, entry] of clients) {
    if (entry.senderId === senderId) disposeClient(id)
  }
}

interface FindOptions {
  filter: Document
  sort: Document
  limit: number
  skip: number
}

function validateFind(raw: unknown): FindOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const limit = o.limit ?? 50
  const skip = o.skip ?? 0
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT) throw new ValidationError(`Limit must be 1 to ${MAX_LIMIT}`)
  if (!Number.isInteger(skip) || (skip as number) < 0) throw new ValidationError('Skip must be 0 or more')
  return { filter: parseDocument(o.filter ?? '', 'Filter', true), sort: parseDocument(o.sort ?? '', 'Sort', true), limit: limit as number, skip: skip as number }
}

export function registerMongoHandlers(): void {
  ipcMain.handle('mongo:connect', async (event, rawConfig: unknown) => {
    const config = validateMongoConfig(rawConfig)
    const client = new MongoClient(mongoUrl(config), {
      auth: config.username ? { username: config.username, password: config.password } : undefined,
      authSource: config.authSource,
      tls: config.tls || config.srv,
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      appName: 'noxed',
    })
    try {
      await client.connect()
      await client.db(config.authSource ?? 'admin').command({ ping: 1 })
    } catch (err) {
      await client.close().catch(() => undefined) // the connection never opened; nothing to clean up
      throw new ConnectionError(`Could not connect to MongoDB: ${toMessage(err)}`)
    }
    // The window closed while connecting, after its cleanup ran.
    if (event.sender.isDestroyed()) {
      await client.close().catch((err: unknown) => console.error(`[mongo] close: ${toMessage(err)}`))
      throw new ConnectionError('The window closed while connecting')
    }
    const id = randomUUID()
    clients.set(id, { client, senderId: event.sender.id })
    return id
  })

  ipcMain.handle('mongo:databases', async (event, rawId: unknown) => {
    const { databases } = await requireClient(event, rawId).db('admin').admin().listDatabases({ nameOnly: false })
    return databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk ?? 0 })).sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle('mongo:collections', async (event, rawId: unknown, rawDb: unknown) => {
    const db = requireClient(event, rawId).db(requireName(rawDb, 'database'))
    const list = await db.listCollections({}, { nameOnly: true }).toArray()
    return list.map((c) => c.name).sort((a, b) => a.localeCompare(b))
  })

  ipcMain.handle('mongo:find', async (event, rawId: unknown, rawDb: unknown, rawCollection: unknown, rawOptions: unknown) => {
    const coll = collection(event, rawId, rawDb, rawCollection)
    const { filter, sort, limit, skip } = validateFind(rawOptions)
    const [docs, total] = await Promise.all([
      coll.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
      // An unfiltered count can come from collection metadata instead of a scan.
      Object.keys(filter).length === 0 ? coll.estimatedDocumentCount() : coll.countDocuments(filter),
    ])
    return { documents: docs.map((d) => ({ json: toEjson(d), display: toDisplay(d) })), total }
  })

  ipcMain.handle('mongo:insert', async (event, rawId: unknown, rawDb: unknown, rawCollection: unknown, rawDoc: unknown) => {
    const coll = collection(event, rawId, rawDb, rawCollection)
    const { insertedId } = await coll.insertOne(parseDocument(rawDoc, 'Document'))
    return toEjson(insertedId)
  })

  ipcMain.handle('mongo:replace', async (event, rawId: unknown, rawDb: unknown, rawCollection: unknown, rawDocId: unknown, rawDoc: unknown) => {
    const coll = collection(event, rawId, rawDb, rawCollection)
    const id = parseDocumentId(rawDocId)
    const { _id: _ignored, ...replacement } = parseDocument(rawDoc, 'Document')
    const { matchedCount } = await coll.replaceOne(id, replacement)
    if (matchedCount === 0) throw new NotFoundError('That document (it may have been deleted)')
  })

  ipcMain.handle('mongo:delete', async (event, rawId: unknown, rawDb: unknown, rawCollection: unknown, rawDocId: unknown) => {
    const coll = collection(event, rawId, rawDb, rawCollection)
    const { deletedCount } = await coll.deleteOne(parseDocumentId(rawDocId))
    if (deletedCount === 0) throw new NotFoundError('That document (it may have been deleted)')
  })

  ipcMain.handle('mongo:disconnect', (event, rawId: unknown) => {
    requireClient(event, rawId)
    disposeClient(rawId as string)
  })
}
