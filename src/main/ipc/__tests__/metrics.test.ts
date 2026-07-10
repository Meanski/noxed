import { describe, it, expect } from 'vitest'
import { parseMetricsOutput } from '../metrics'

const LINUX_OUTPUT = [
  'cpu  100 0 100 700 100 0 0 0 0 0',
  '::MEM::MemTotal:        4096000 kB',
  'MemAvailable:    1024000 kB',
  '::DISK::/dev/vda1  102400000 51200000 51200000  50% /',
  '::LOAD::0.42 0.36 0.30 1/123 4567',
  '::UP::123456.78 654321.00',
].join('\n')

describe('parseMetricsOutput', () => {
  it('parses memory, disk, load, and uptime', () => {
    const { metrics } = parseMetricsOutput(LINUX_OUTPUT)
    expect(metrics.memTotal).toBe(4096000 * 1024)
    expect(metrics.memUsed).toBe((4096000 - 1024000) * 1024)
    expect(metrics.diskTotal).toBe(102400000 * 1024)
    expect(metrics.diskUsed).toBe(51200000 * 1024)
    expect(metrics.load1).toBe(0.42)
    expect(metrics.uptimeSec).toBe(123456)
    expect(metrics.available).toBe(true)
  })

  it('reports 0% CPU on the first sample and a delta afterwards', () => {
    const first = parseMetricsOutput(LINUX_OUTPUT)
    expect(first.metrics.cpu).toBe(0)
    expect(first.cpuStat).toEqual({ idle: 800, total: 1000 })

    // 1000 more jiffies, 200 of them idle → 80% busy
    const second = LINUX_OUTPUT.replace(
      'cpu  100 0 100 700 100 0 0 0 0 0',
      'cpu  500 0 500 850 150 0 0 0 0 0',
    )
    const { metrics } = parseMetricsOutput(second, first.cpuStat)
    expect(metrics.cpu).toBe(80)
  })

  it('marks non-Linux hosts unavailable without throwing', () => {
    const { metrics } = parseMetricsOutput('::MEM::::DISK::::LOAD::::UP::')
    expect(metrics.available).toBe(false)
    expect(metrics.cpu).toBe(0)
    expect(metrics.diskTotal).toBe(0)
  })

  it('handles completely empty output', () => {
    const { metrics, cpuStat } = parseMetricsOutput('')
    expect(metrics.available).toBe(false)
    expect(cpuStat).toBeUndefined()
  })

  it('clamps CPU to 0 when idle jiffies outgrow the total delta', () => {
    const prev = { idle: 0, total: 100 }
    const out = LINUX_OUTPUT.replace(
      'cpu  100 0 100 700 100 0 0 0 0 0',
      'cpu  50 0 0 900 50 0 0 0 0 0',
    )
    const { metrics } = parseMetricsOutput(out, prev)
    expect(metrics.cpu).toBe(0)
  })

  it('clamps CPU to 100 when idle time appears to go backwards', () => {
    const prev = { idle: 800, total: 1000 }
    const out = LINUX_OUTPUT.replace(
      'cpu  100 0 100 700 100 0 0 0 0 0',
      'cpu  1500 0 400 100 0 0 0 0 0 0',
    )
    const { metrics } = parseMetricsOutput(out, prev)
    expect(metrics.cpu).toBe(100)
  })

  it('reports 0% CPU when the counter total has not advanced', () => {
    const first = parseMetricsOutput(LINUX_OUTPUT)
    const { metrics } = parseMetricsOutput(LINUX_OUTPUT, first.cpuStat)
    expect(metrics.cpu).toBe(0)
  })

  it('tolerates missing sections and partial meminfo', () => {
    const out = 'cpu  100 0 100 700 100 0 0 0 0 0\n::MEM::MemTotal: 2048 kB'
    const { metrics } = parseMetricsOutput(out)
    expect(metrics.memTotal).toBe(2048 * 1024)
    // No MemAvailable line: everything counts as used
    expect(metrics.memUsed).toBe(2048 * 1024)
    expect(metrics.diskTotal).toBe(0)
    expect(metrics.diskUsed).toBe(0)
    expect(metrics.load1).toBe(0)
    expect(metrics.uptimeSec).toBe(0)
    expect(metrics.available).toBe(true)
  })

  it('ignores garbage in the disk, load, and uptime sections', () => {
    const out = [
      'cpu  100 0 100 700 100 0 0 0 0 0',
      '::MEM::MemTotal: 1000 kB',
      'MemAvailable: 500 kB',
      '::DISK::df: /: No such file or directory',
      '::LOAD::not-a-number',
      '::UP::soon',
    ].join('\n')
    const { metrics } = parseMetricsOutput(out)
    expect(metrics.diskTotal).toBe(0)
    expect(metrics.diskUsed).toBe(0)
    expect(metrics.load1).toBe(0)
    expect(metrics.uptimeSec).toBe(0)
  })

  it('handles non-numeric cpu lines without producing a sample', () => {
    const out = `intr weird output\n${LINUX_OUTPUT.slice(LINUX_OUTPUT.indexOf('::MEM::'))}`
    const { metrics, cpuStat } = parseMetricsOutput(out)
    expect(metrics.cpu).toBe(0)
    expect(cpuStat).toBeUndefined()
  })
})
