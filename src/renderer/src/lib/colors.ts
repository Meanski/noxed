/**
 * Shared color utilities.
 * Single source of truth for threshold-based colors and type mappings.
 */

import type { ConnectionType } from '../store'

export function metricColor(pct: number): string {
  if (pct >= 80) return '#EF4444'
  if (pct >= 60) return '#F59E0B'
  return '#10B981'
}

export function metricColorMuted(pct: number): string {
  if (pct >= 80) return '#ef4444'
  if (pct >= 60) return '#f59e0b'
  return 'rgba(255,255,255,0.55)'
}

export function connectionColor(type: ConnectionType): string {
  const map: Record<ConnectionType, string> = {
    ssh: '#3B5CCC',
    sftp: '#EC4899',
    database: '#10B981',
    kubernetes: '#8B5CF6',
    redis: '#DC382D',
  }
  return map[type] ?? '#6B7280'
}

// User-assigned colors win; otherwise the name hashes to a stable default.
export function groupColor(name: string, overrides?: Record<string, string>): string {
  const custom = overrides?.[name]
  if (custom) return custom
  const palette = ['#6366f1', '#22c55e', '#f59e0b', '#f87171', '#a78bfa', '#06b6d4', '#fb923c', '#e879f9', '#34d399']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]
}

export function podStatusColor(status: string): string {
  const s = status.toLowerCase()
  if (s === 'running') return '#10B981'
  if (s === 'succeeded' || s === 'completed') return '#3B82F6'
  if (s === 'pending' || s === 'containercreating') return '#F59E0B'
  if (s.includes('error') || s.includes('crash') || s === 'failed') return '#EF4444'
  return '#6B7280'
}

export function dbTypeLabel(dbType?: string): string {
  const map: Record<string, string> = {
    postgresql: 'PostgreSQL',
    mysql: 'MySQL',
    mariadb: 'MariaDB',
    sqlite: 'SQLite',
    mongodb: 'MongoDB',
  }
  return dbType ? (map[dbType] ?? dbType) : 'Database'
}
