/**
 * Shared formatting utilities.
 * Single source of truth for byte/size/time formatting across all components.
 */

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}G`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}M`
  return `${(bytes / 1024).toFixed(0)}K`
}

export function formatBytesLong(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`
  return `${bytes} B`
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`
}

export function formatK8sMemory(mem: string): string {
  if (!mem) return '—'
  const ki = Number.parseInt(mem, 10)
  if (Number.isNaN(ki)) return mem
  if (ki >= 1024 * 1024) return `${(ki / 1024 / 1024).toFixed(0)}Gi`
  if (ki >= 1024) return `${(ki / 1024).toFixed(0)}Mi`
  return `${ki}Ki`
}

export function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`
}

export function relativeTime(when: number | Date): string {
  const ts = typeof when === 'number' ? when : when.getTime()
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${Math.max(s, 0)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

const SPARK_BLOCKS = '▁▂▃▄▅▆▇█'

/** Renders values (0..max) as a unicode block sparkline. */
export function sparkline(values: number[], max = 100): string {
  return values
    .map(v => SPARK_BLOCKS[Math.min(7, Math.max(0, Math.round((v / max) * 7)))])
    .join('')
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Formats a timestamp according to the `dateFormat` app setting. */
export function formatDate(ts: number, format: string): string {
  if (!ts) return '—'
  const d = new Date(ts)
  switch (format) {
    case 'DD/MM/YYYY HH:mm':
      return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    case 'MM/DD/YYYY h:mm A': {
      const hour12 = d.getHours() % 12 || 12
      const meridiem = d.getHours() < 12 ? 'AM' : 'PM'
      return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()} ${hour12}:${pad2(d.getMinutes())} ${meridiem}`
    }
    case 'Relative (e.g. "2 hours ago")':
      return relativeTime(ts)
    default:
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }
}

/**
 * Extracts a user-readable message from an IPC error, stripping Electron's
 * "Error invoking remote method 'x': SomeError: " wrapper.
 */
export function ipcErrorMessage(err: unknown, fallback = 'Unknown error'): string {
  const raw = (err as { message?: unknown })?.message
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  return raw.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '')
}
