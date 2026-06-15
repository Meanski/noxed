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
})
