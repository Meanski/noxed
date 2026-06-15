import { ValidationError } from './errors'
import type { Session } from './sessions'

// Connection backup format: JSON with a version marker so future format
// changes stay readable. Credentials never leave the OS keychain, so an
// export contains connection settings only.

export const SESSION_EXPORT_FORMAT = 'noxed-connections'
export const SESSION_EXPORT_VERSION = 1

export type ImportedSession = Omit<Session, 'id' | 'createdAt' | 'hasPassword'>

const CONNECTION_TYPES = new Set(['ssh', 'sftp', 'database', 'kubernetes', 'redis'])
const MAX_IMPORT_BYTES = 5 * 1024 * 1024

export function serializeSessions(sessions: Session[]): string {
  const connections = sessions.map(({ id: _id, createdAt: _created, hasPassword: _hp, ...rest }) => rest)
  return JSON.stringify(
    {
      format: SESSION_EXPORT_FORMAT,
      version: SESSION_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      connections,
    },
    null,
    2
  )
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function sanitizeConnection(raw: unknown): ImportedSession | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  const type = CONNECTION_TYPES.has(r.type as string) ? (r.type as ImportedSession['type']) : 'ssh'
  const host = readString(r.host)?.trim() ?? ''
  const contextName = readString(r.contextName)
  // Every connection needs an address, except Kubernetes which targets a context
  if (!host && !(type === 'kubernetes' && contextName)) return null

  const portRaw = Number(r.port)
  const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535 ? portRaw : 22

  const session: ImportedSession = {
    label: typeof r.label === 'string' ? r.label : '',
    host,
    port,
    username: typeof r.username === 'string' ? r.username : '',
    authType: r.authType === 'key' ? 'key' : 'password',
    type,
  }

  session.keyPath = readString(r.keyPath)
  session.group = readString(r.group)
  session.color = readString(r.color)
  session.dbType = readString(r.dbType)
  session.databaseName = readString(r.databaseName)
  session.sslMode = readString(r.sslMode)
  session.contextName = contextName
  session.kubeconfigPath = readString(r.kubeconfigPath)
  if (Array.isArray(r.tags)) session.tags = r.tags.filter((t): t is string => typeof t === 'string')
  if (typeof r.isFavorite === 'boolean') session.isFavorite = r.isFavorite
  if (typeof r.pollingEnabled === 'boolean') session.pollingEnabled = r.pollingEnabled
  if (typeof r.connectOnStart === 'boolean') session.connectOnStart = r.connectOnStart
  if (typeof r.pollingIntervalSeconds === 'number' && Number.isFinite(r.pollingIntervalSeconds)) {
    session.pollingIntervalSeconds = r.pollingIntervalSeconds
  }
  if (typeof r.redisDb === 'number' && Number.isInteger(r.redisDb)) session.redisDb = r.redisDb

  return session
}

export function parseSessionsExport(json: string): ImportedSession[] {
  if (json.length > MAX_IMPORT_BYTES) {
    throw new ValidationError('Import file is too large')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new ValidationError('Import file is not valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ValidationError('Import file is not a noxed connections export')
  }
  const doc = parsed as Record<string, unknown>
  if (doc.format !== SESSION_EXPORT_FORMAT || !Array.isArray(doc.connections)) {
    throw new ValidationError('Import file is not a noxed connections export')
  }

  return doc.connections
    .map(sanitizeConnection)
    .filter((s): s is ImportedSession => s !== null)
}

export function connectionDedupKey(s: Pick<Session, 'type' | 'host' | 'port' | 'username' | 'contextName'>): string {
  return [s.type ?? 'ssh', s.host, s.port, s.username ?? '', s.contextName ?? ''].join('|')
}
