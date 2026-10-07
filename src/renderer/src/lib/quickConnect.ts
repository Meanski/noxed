export interface QuickConnectTarget {
  /** Empty when the input named no user; the caller asks for one. */
  username: string
  host: string
  port: number
}

const DEFAULT_SSH_PORT = 22
// OpenSSH options that consume the next argument, so it isn't read as the host.
const FLAGS_WITH_VALUE = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w'])
const HOST_CHARS = /^[A-Za-z0-9._:-]+$/

function toPort(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_SSH_PORT
  if (!/^\d{1,5}$/.test(raw)) return null
  const port = Number(raw)
  return port >= 1 && port <= 65535 ? port : null
}

// `host`, `host:port`, `[v6]` or `[v6]:port`. A bare IPv6 address (several
// colons, no brackets) is taken whole, as OpenSSH does.
function splitHostPort(hostPart: string): { host: string; port: string | undefined } | null {
  if (hostPart.startsWith('[')) {
    const close = hostPart.indexOf(']')
    if (close === -1) return null
    const rest = hostPart.slice(close + 1)
    if (rest !== '' && !rest.startsWith(':')) return null
    // `[v6]:` names no port, which is an error rather than the default.
    return { host: hostPart.slice(1, close), port: rest === '' ? undefined : rest.slice(1) }
  }
  const firstColon = hostPart.indexOf(':')
  if (firstColon !== -1 && firstColon === hostPart.lastIndexOf(':')) {
    return { host: hostPart.slice(0, firstColon), port: hostPart.slice(firstColon + 1) }
  }
  return { host: hostPart, port: undefined }
}

function parseUrl(input: string): QuickConnectTarget | null {
  try {
    const url = new URL(input)
    // Quick connect opens a shell, nothing more: refuse what it would have to
    // drop (a remote command path, an embedded password, query or fragment).
    if (url.password || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) return null
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
    const port = toPort(url.port || undefined)
    if (!host || port === null) return null
    return { username: decodeURIComponent(url.username), host, port }
  } catch {
    return null // not a URL — fall through to the ssh-style parser
  }
}

/**
 * Parses what people type or paste to reach a server: `user@host`,
 * `host:2222`, `ssh deploy@host -p 2222`, `ssh://user@host:port`.
 * Returns null when it can't be a host.
 */
export function parseQuickConnectTarget(input: string): QuickConnectTarget | null {
  const trimmed = input.trim()
  if (trimmed.toLowerCase().startsWith('ssh://')) return parseUrl(trimmed)

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens[0] === 'ssh') tokens.shift()

  let flagPort: string | undefined
  let flagUser: string | undefined
  const positional: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    const flag = token.slice(0, 2)
    // OpenSSH takes values both apart (`-p 2222`) and attached (`-p2222`).
    const attached = token.length > 2 ? token.slice(2) : undefined
    if (!FLAGS_WITH_VALUE.has(flag)) continue
    const value = attached ?? tokens[++i]
    if (value === undefined) return null
    if (flag === '-p') flagPort = value
    else if (flag === '-l') flagUser = value
  }
  // A second positional would be a remote command (or a typo) that quick
  // connect can't honour, so refuse rather than silently drop it.
  if (positional.length !== 1) return null
  const target = positional[0]

  const at = target.lastIndexOf('@')
  const username = at === -1 ? (flagUser ?? '') : target.slice(0, at)
  const parts = splitHostPort(at === -1 ? target : target.slice(at + 1))
  if (!parts?.host || !HOST_CHARS.test(parts.host)) return null

  const port = toPort(flagPort ?? parts.port)
  if (port === null) return null
  return { username, host: parts.host, port }
}

/** True when a palette query looks like a host rather than a search term. */
export function looksLikeHost(query: string): boolean {
  const q = query.trim()
  return (q.includes('@') || q.includes('.') || q.includes(':') || q.startsWith('ssh ')) && parseQuickConnectTarget(q) !== null
}
