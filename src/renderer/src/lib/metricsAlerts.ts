import { LiveMetrics } from './sshDispatch'

// Resource alerting on live metrics. CPU must stay pinned across several
// samples (~15s at the 5s polling cadence) before alerting, and each alert
// fires once until the metric recovers — no notification storms.

const CPU_ALERT_THRESHOLD = 90
const CPU_ALERT_SAMPLES = 3
const CPU_RECOVERY_THRESHOLD = 75
const DISK_ALERT_RATIO = 0.9
const DISK_RECOVERY_RATIO = 0.85

interface AlertState {
  highCpuSamples: number
  cpuAlerted: boolean
  diskAlerted: boolean
}

const states = new Map<string, AlertState>()

export type AlertNotify = (message: string) => void

export function checkResourceAlerts(sessionId: string, label: string, m: LiveMetrics, notify: AlertNotify): void {
  if (!m.available) return
  const st = states.get(sessionId) ?? { highCpuSamples: 0, cpuAlerted: false, diskAlerted: false }
  states.set(sessionId, st)

  if (m.cpu >= CPU_ALERT_THRESHOLD) {
    st.highCpuSamples++
    if (st.highCpuSamples >= CPU_ALERT_SAMPLES && !st.cpuAlerted) {
      st.cpuAlerted = true
      notify(`${label}: CPU pinned at ${m.cpu}%`)
    }
  } else if (m.cpu < CPU_RECOVERY_THRESHOLD) {
    st.highCpuSamples = 0
    st.cpuAlerted = false
  }

  if (m.diskTotal && m.diskUsed !== undefined) {
    const ratio = m.diskUsed / m.diskTotal
    if (ratio >= DISK_ALERT_RATIO && !st.diskAlerted) {
      st.diskAlerted = true
      notify(`${label}: root disk ${Math.round(ratio * 100)}% full`)
    } else if (ratio < DISK_RECOVERY_RATIO) {
      st.diskAlerted = false
    }
  }
}

export function resetResourceAlerts(sessionId: string): void {
  states.delete(sessionId)
}
