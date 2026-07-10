// Remote metrics collection: one cheap command over the existing SSH
// connection, reading /proc and df. Non-Linux hosts simply yield
// available: false — nothing here may throw on weird output.

export interface RemoteMetrics {
  cpu: number
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  load1: number
  uptimeSec: number
  available: boolean
}

export interface CpuStatSample {
  idle: number
  total: number
}

export const METRICS_COMMAND = [
  'cat /proc/stat 2>/dev/null | head -1',
  'printf "::MEM::"',
  'grep -E "MemTotal:|MemAvailable:" /proc/meminfo 2>/dev/null',
  'printf "::DISK::"',
  'df -kP / 2>/dev/null | tail -1',
  'printf "::LOAD::"',
  'cat /proc/loadavg 2>/dev/null',
  'printf "::UP::"',
  'cat /proc/uptime 2>/dev/null',
].join('; ')

function section(out: string, marker: string): string {
  const start = out.indexOf(`::${marker}::`)
  if (start === -1) return ''
  const from = start + marker.length + 4
  const end = out.indexOf('::', from)
  return end === -1 ? out.slice(from) : out.slice(from, end)
}

export function parseMetricsOutput(
  out: string,
  prevCpu?: CpuStatSample,
): { metrics: RemoteMetrics; cpuStat?: CpuStatSample } {
  const cpuStr = out.split('::MEM::')[0] ?? ''
  const memStr = section(out, 'MEM')
  const diskStr = section(out, 'DISK')
  const loadStr = section(out, 'LOAD')
  const upStr = section(out, 'UP')

  // CPU usage needs two /proc/stat samples; the first read yields 0%
  const nums = cpuStr.replace(/^cpu\s+/, '').trim().split(/\s+/).map(Number)
  const idle = (nums[3] || 0) + (nums[4] || 0)
  const total = nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  let cpu = 0
  if (prevCpu && total > prevCpu.total) {
    const dt = total - prevCpu.total
    const di = idle - prevCpu.idle
    cpu = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)))
  }
  const cpuStat = total > 0 ? { idle, total } : undefined

  const memTotal = Number.parseInt(/MemTotal:\s+(\d+)/.exec(memStr)?.[1] ?? '0') * 1024
  const memAvail = Number.parseInt(/MemAvailable:\s+(\d+)/.exec(memStr)?.[1] ?? '0') * 1024

  // df -kP: filesystem, 1k-blocks, used, available, capacity, mount
  const diskParts = diskStr.trim().split(/\s+/)
  const diskTotal = (Number.parseInt(diskParts[1] ?? '0') || 0) * 1024
  const diskUsed = (Number.parseInt(diskParts[2] ?? '0') || 0) * 1024

  const load1 = Number.parseFloat(loadStr.trim().split(/\s+/)[0] ?? '0') || 0
  const uptimeSec = Math.floor(Number.parseFloat(upStr.trim().split(/\s+/)[0] ?? '0')) || 0

  return {
    metrics: {
      cpu,
      memUsed: memTotal - memAvail,
      memTotal,
      diskUsed,
      diskTotal,
      load1,
      uptimeSec,
      available: memTotal > 0,
    },
    cpuStat,
  }
}
