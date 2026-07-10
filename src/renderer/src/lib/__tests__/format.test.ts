import { describe, it, expect } from 'vitest'
import {
  formatBytes, formatBytesLong, formatFileSize, formatK8sMemory,
  joinPath, formatUptime, sparkline, ipcErrorMessage,
} from '../format'

describe('formatK8sMemory', () => {
  it('returns an em dash for empty input', () => {
    expect(formatK8sMemory('')).toBe('—')
  })

  it('returns the raw string when it is not a number', () => {
    expect(formatK8sMemory('abc')).toBe('abc')
  })

  it('formats gibibytes', () => {
    expect(formatK8sMemory(String(2 * 1024 * 1024))).toBe('2Gi')
  })

  it('formats mebibytes', () => {
    expect(formatK8sMemory('2048')).toBe('2Mi')
  })

  it('keeps small values in KiB', () => {
    expect(formatK8sMemory('512')).toBe('512Ki')
  })
})

describe('formatBytes / formatBytesLong / formatFileSize', () => {
  it('formatBytes picks G/M/K units', () => {
    expect(formatBytes(2.5e9)).toBe('2.5G')
    expect(formatBytes(3e6)).toBe('3M')
    expect(formatBytes(2048)).toBe('2K')
  })

  it('formatBytesLong picks GB/MB/KB/B units', () => {
    expect(formatBytesLong(2.5e9)).toBe('2.5 GB')
    expect(formatBytesLong(3e6)).toBe('3 MB')
    expect(formatBytesLong(3e3)).toBe('3 KB')
    expect(formatBytesLong(42)).toBe('42 B')
  })

  it('formatFileSize picks B/K/M/G units', () => {
    expect(formatFileSize(512)).toBe('512B')
    expect(formatFileSize(2048)).toBe('2K')
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0M')
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe('2.0G')
  })
})

describe('joinPath', () => {
  it('joins against root without doubling the slash', () => {
    expect(joinPath('/', 'etc')).toBe('/etc')
  })

  it('joins nested paths', () => {
    expect(joinPath('/var/log', 'syslog')).toBe('/var/log/syslog')
  })
})

describe('formatUptime', () => {
  it('formats minutes, hours and days', () => {
    expect(formatUptime(120)).toBe('2m')
    expect(formatUptime(7200)).toBe('2h')
    expect(formatUptime(86400 * 2 + 3600 * 3)).toBe('2d 3h')
    expect(formatUptime(86400 * 2)).toBe('2d')
  })
})

describe('sparkline', () => {
  it('maps values to block characters', () => {
    expect(sparkline([0, 100])).toBe('▁█')
  })
})

describe('ipcErrorMessage', () => {
  it('strips the Electron IPC wrapper', () => {
    const err = new Error("Error invoking remote method 'ssh:connect': Error: boom")
    expect(ipcErrorMessage(err)).toBe('boom')
  })

  it('falls back for non-errors', () => {
    expect(ipcErrorMessage(undefined, 'nope')).toBe('nope')
  })
})
