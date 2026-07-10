import { homedir } from 'node:os'
import { resolve, normalize } from 'node:path'
import { statSync } from 'node:fs'

const MAX_KEY_FILE_SIZE = 64 * 1024
const MAX_KUBECONFIG_FILE_SIZE = 1024 * 1024

const ALLOWED_KEY_DIRS = [
  resolve(homedir(), '.ssh'),
  resolve(homedir(), '.config', 'ssh'),
  resolve(homedir(), '.pem'),
]

const ALLOWED_KUBECONFIG_DIRS = [
  resolve(homedir(), '.kube'),
  resolve(homedir(), '.config', 'kube'),
  resolve(homedir(), '.config', 'k8s'),
  resolve(homedir(), '.config', 'kubernetes'),
]

// The app's managed kubeconfig folder (imported copies) lives under Electron's
// userData path, which is only known at runtime.
export function registerAllowedKubeconfigDir(dir: string): void {
  const resolved = resolve(dir)
  if (!ALLOWED_KUBECONFIG_DIRS.includes(resolved)) ALLOWED_KUBECONFIG_DIRS.push(resolved)
}

export type PathCheck = { ok: true; resolved: string } | { ok: false; reason: string }

function checkPathBase(rawPath: string): { resolved: string } | { error: string } {
  if (!rawPath || typeof rawPath !== 'string') return { error: 'Path is required' }
  const expanded = rawPath.replace(/^~/, homedir())
  const resolved = normalize(resolve(expanded))
  if (resolved.includes('\0')) return { error: 'Invalid path: contains null bytes' }
  return { resolved }
}

function isInsideAny(resolvedPath: string, dirs: string[]): boolean {
  return dirs.some((dir) => resolvedPath === dir || resolvedPath.startsWith(`${dir}/`))
}

function checkAllowedFile(rawPath: string, allowedDirs: string[], maxBytes: number, label: string): PathCheck {
  const base = checkPathBase(rawPath)
  if ('error' in base) return { ok: false, reason: base.error }
  if (!isInsideAny(base.resolved, allowedDirs)) {
    return { ok: false, reason: `Access denied: ${label} path must be inside an allowed directory` }
  }
  try {
    const stat = statSync(base.resolved)
    if (!stat.isFile()) return { ok: false, reason: 'Path is not a regular file' }
    if (stat.size > maxBytes) {
      return { ok: false, reason: `File too large (${stat.size} bytes). Max allowed: ${maxBytes} bytes` }
    }
  } catch {
    return { ok: false, reason: 'File does not exist or is not accessible' }
  }
  return { ok: true, resolved: base.resolved }
}

export function isAllowedKeyPath(rawPath: string): PathCheck {
  return checkAllowedFile(rawPath, ALLOWED_KEY_DIRS, MAX_KEY_FILE_SIZE, 'key')
}

export function isAllowedKubeconfigPath(rawPath: string): PathCheck {
  return checkAllowedFile(rawPath, ALLOWED_KUBECONFIG_DIRS, MAX_KUBECONFIG_FILE_SIZE, 'kubeconfig')
}

export function isInsideHome(rawPath: string): PathCheck {
  const base = checkPathBase(rawPath)
  if ('error' in base) return { ok: false, reason: base.error }
  const home = homedir()
  if (base.resolved !== home && !base.resolved.startsWith(`${home}/`)) {
    return { ok: false, reason: 'Path must be inside your home directory' }
  }
  return { ok: true, resolved: base.resolved }
}

const BLOCKED_REDIS_COMMANDS = new Set([
  'flushall', 'flushdb', 'shutdown', 'debug', 'slaveof', 'replicaof',
  'config', 'bgsave', 'bgrewriteaof', 'cluster', 'migrate',
  'restore', 'swapdb', 'failover', 'reset', 'acl',
  'module', 'pfselftest', 'pfdebug', 'replconf', 'psync',
  'monitor', 'subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe',
  'client',
])

export function isBlockedRedisCommand(command: string): boolean {
  const cmd = command.trim().split(/\s+/)[0]?.toLowerCase()
  return BLOCKED_REDIS_COMMANDS.has(cmd ?? '')
}

export function getBlockedRedisCommands(): string[] {
  return [...BLOCKED_REDIS_COMMANDS].sort((a, b) => a.localeCompare(b))
}

// Extension check is only a cheap pre-filter to avoid streaming large binaries;
// the read handlers sniff the first 8KB for null bytes as the real gate, so
// unknown extensions (dotfiles, extensionless configs) are allowed through.
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'webp', 'heic', 'tiff', 'psd',
  'mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v',
  'zip', 'gz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'tgz', 'jar', 'war',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'lib', 'a', 'o', 'bin', 'core', 'wasm', 'node',
  'class', 'pyc', 'pyo', 'rlib',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'sqlite', 'sqlite3', 'db', 'mdb',
  'dmg', 'iso', 'img', 'pkg', 'deb', 'rpm',
])

export function isLikelyTextFile(filename: string, sizeBytes: number): boolean {
  if (sizeBytes > 10 * 1024 * 1024) return false

  const basename = filename.split('/').pop() ?? ''
  // A leading dot marks a hidden file (.bashrc, .vimrc), not an extension separator
  const stem = basename.startsWith('.') ? basename.slice(1) : basename
  const lastDot = stem.lastIndexOf('.')
  const ext = lastDot > 0 ? stem.slice(lastDot + 1).toLowerCase() : ''
  return !BINARY_EXTENSIONS.has(ext)
}

const HOSTNAME_RE = /^[a-zA-Z0-9._:-]+$/

export function validateHost(host: unknown, label = 'host'): string {
  if (typeof host !== 'string') throw new Error(`Invalid ${label}`)
  const trimmed = host.trim()
  if (trimmed.length === 0 || trimmed.length > 255) throw new Error(`Invalid ${label}`)
  if (!HOSTNAME_RE.test(trimmed)) throw new Error(`Invalid ${label}: contains illegal characters`)
  return trimmed
}

export function validatePort(port: unknown, label = 'port'): number {
  const n = typeof port === 'string' ? Number(port) : port
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid ${label}`)
  }
  return n
}

const K8S_NAME_RE = /^[a-zA-Z0-9]([-a-zA-Z0-9_./:]*[a-zA-Z0-9])?$/

export function validateK8sName(value: unknown, label: string, max = 253): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`)
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) throw new Error(`Invalid ${label}`)
  if (!K8S_NAME_RE.test(trimmed)) throw new Error(`Invalid ${label}: contains illegal characters`)
  return trimmed
}
