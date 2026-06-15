import { describe, it, expect } from 'vitest'
import { formatBytes, formatBytesLong, formatDate, formatFileSize, formatK8sMemory, joinPath, relativeTime } from '../../lib/format'
import { metricColor, metricColorMuted, podStatusColor, connectionColor, groupColor, dbTypeLabel } from '../../lib/colors'

describe('format.ts', () => {
  describe('joinPath', () => {
    it('joins from root', () => {
      expect(joinPath('/', 'foo')).toBe('/foo')
    })

    it('joins from a subdirectory', () => {
      expect(joinPath('/var/log', 'syslog')).toBe('/var/log/syslog')
    })

    it('handles deep paths', () => {
      expect(joinPath('/a/b/c', 'd')).toBe('/a/b/c/d')
    })
  })

  describe('formatFileSize', () => {
    it('formats bytes', () => {
      expect(formatFileSize(0)).toBe('0B')
      expect(formatFileSize(512)).toBe('512B')
      expect(formatFileSize(1023)).toBe('1023B')
    })

    it('formats kilobytes', () => {
      expect(formatFileSize(1024)).toBe('1K')
      expect(formatFileSize(10240)).toBe('10K')
    })

    it('formats megabytes', () => {
      expect(formatFileSize(1048576)).toBe('1.0M')
      expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0M')
    })

    it('formats gigabytes', () => {
      expect(formatFileSize(1073741824)).toBe('1.0G')
      expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5G')
    })
  })

  describe('formatBytes', () => {
    it('formats gigabytes', () => {
      expect(formatBytes(2e9)).toBe('2.0G')
    })

    it('formats megabytes', () => {
      expect(formatBytes(512e6)).toBe('512M')
    })

    it('formats kilobytes', () => {
      expect(formatBytes(512 * 1024)).toBe('512K')
    })
  })

  describe('formatBytesLong', () => {
    it('formats bytes', () => {
      expect(formatBytesLong(500)).toBe('500 B')
    })

    it('formats KB', () => {
      expect(formatBytesLong(5000)).toBe('5 KB')
    })

    it('formats MB', () => {
      expect(formatBytesLong(5e6)).toBe('5 MB')
    })

    it('formats GB', () => {
      expect(formatBytesLong(5e9)).toBe('5.0 GB')
    })
  })

  describe('formatK8sMemory', () => {
    it('converts Ki to Mi when large enough', () => {
      expect(formatK8sMemory('1048576')).toBe('1Gi')
    })

    it('converts Ki to Mi range', () => {
      expect(formatK8sMemory('2048')).toBe('2Mi')
    })

    it('keeps small values as Ki', () => {
      expect(formatK8sMemory('512')).toBe('512Ki')
    })

    it('returns dash for empty string', () => {
      expect(formatK8sMemory('')).toBe('—')
    })

    it('returns original for unparseable', () => {
      expect(formatK8sMemory('unknown')).toBe('unknown')
    })
  })

  describe('formatDate', () => {
    // 2026-06-10 20:02 local time, fixed reference for all format assertions
    const ts = new Date(2026, 5, 10, 20, 2).getTime()

    it('formats ISO style by default', () => {
      expect(formatDate(ts, 'YYYY-MM-DD HH:mm')).toBe('2026-06-10 20:02')
    })

    it('falls back to ISO style for unknown formats', () => {
      expect(formatDate(ts, 'bogus')).toBe('2026-06-10 20:02')
    })

    it('formats DD/MM/YYYY', () => {
      expect(formatDate(ts, 'DD/MM/YYYY HH:mm')).toBe('10/06/2026 20:02')
    })

    it('formats 12-hour US style', () => {
      expect(formatDate(ts, 'MM/DD/YYYY h:mm A')).toBe('06/10/2026 8:02 PM')
    })

    it('formats midnight as 12 AM', () => {
      const midnight = new Date(2026, 5, 10, 0, 5).getTime()
      expect(formatDate(midnight, 'MM/DD/YYYY h:mm A')).toBe('06/10/2026 12:05 AM')
    })

    it('returns dash for missing timestamp', () => {
      expect(formatDate(0, 'YYYY-MM-DD HH:mm')).toBe('—')
    })
  })

  describe('relativeTime', () => {
    it('formats seconds', () => {
      expect(relativeTime(Date.now() - 30_000)).toBe('30s ago')
    })

    it('formats minutes', () => {
      expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5m ago')
    })

    it('formats hours', () => {
      expect(relativeTime(Date.now() - 3 * 3600_000)).toBe('3h ago')
    })

    it('formats days', () => {
      expect(relativeTime(Date.now() - 2 * 86400_000)).toBe('2d ago')
    })

    it('accepts Date objects', () => {
      expect(relativeTime(new Date(Date.now() - 60_000))).toBe('1m ago')
    })

    it('clamps future timestamps to zero', () => {
      expect(relativeTime(Date.now() + 5000)).toBe('0s ago')
    })
  })
})

describe('colors.ts', () => {
  describe('metricColor', () => {
    it('returns red for >= 80%', () => {
      expect(metricColor(80)).toBe('#EF4444')
      expect(metricColor(100)).toBe('#EF4444')
    })

    it('returns amber for >= 60%', () => {
      expect(metricColor(60)).toBe('#F59E0B')
      expect(metricColor(79)).toBe('#F59E0B')
    })

    it('returns green for < 60%', () => {
      expect(metricColor(0)).toBe('#10B981')
      expect(metricColor(59)).toBe('#10B981')
    })
  })

  describe('metricColorMuted', () => {
    it('returns red for >= 80%', () => {
      expect(metricColorMuted(80)).toBe('#ef4444')
    })

    it('returns muted white for < 60%', () => {
      expect(metricColorMuted(59)).toBe('rgba(255,255,255,0.55)')
    })
  })

  describe('podStatusColor', () => {
    it('returns green for Running', () => {
      expect(podStatusColor('Running')).toBe('#10B981')
    })

    it('returns blue for Succeeded/Completed', () => {
      expect(podStatusColor('Succeeded')).toBe('#3B82F6')
      expect(podStatusColor('Completed')).toBe('#3B82F6')
    })

    it('returns amber for Pending', () => {
      expect(podStatusColor('Pending')).toBe('#F59E0B')
    })

    it('returns red for error states', () => {
      expect(podStatusColor('Error')).toBe('#EF4444')
      expect(podStatusColor('CrashLoopBackOff')).toBe('#EF4444')
      expect(podStatusColor('Failed')).toBe('#EF4444')
    })

    it('returns gray for unknown statuses', () => {
      expect(podStatusColor('Unknown')).toBe('#6B7280')
    })
  })

  describe('connectionColor', () => {
    it('returns blue for ssh', () => {
      expect(connectionColor('ssh')).toBe('#3B5CCC')
    })

    it('returns pink for sftp', () => {
      expect(connectionColor('sftp')).toBe('#EC4899')
    })

    it('returns green for database', () => {
      expect(connectionColor('database')).toBe('#10B981')
    })

    it('returns purple for kubernetes', () => {
      expect(connectionColor('kubernetes')).toBe('#8B5CF6')
    })

    it('returns red for redis', () => {
      expect(connectionColor('redis')).toBe('#DC382D')
    })
  })

  describe('groupColor', () => {
    it('returns a hex color string', () => {
      expect(groupColor('production')).toMatch(/^#[0-9a-fA-F]{6}$/)
    })

    it('returns consistent color for same input', () => {
      expect(groupColor('staging')).toBe(groupColor('staging'))
    })

    it('prefers a user-assigned override', () => {
      expect(groupColor('staging', { staging: '#EC4899' })).toBe('#EC4899')
    })

    it('falls back to the hash when no override matches', () => {
      expect(groupColor('staging', { production: '#EC4899' })).toBe(groupColor('staging'))
    })
  })

  describe('dbTypeLabel', () => {
    it('maps known types to labels', () => {
      expect(dbTypeLabel('postgresql')).toBe('PostgreSQL')
      expect(dbTypeLabel('mysql')).toBe('MySQL')
      expect(dbTypeLabel('mongodb')).toBe('MongoDB')
    })

    it('returns raw type for unknown', () => {
      expect(dbTypeLabel('oracle')).toBe('oracle')
    })

    it('returns "Database" for undefined', () => {
      expect(dbTypeLabel(undefined)).toBe('Database')
    })
  })
})
