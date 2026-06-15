export interface LiveMetrics {
  cpu: number
  memUsed: number
  memTotal: number
  diskUsed?: number
  diskTotal?: number
  load1?: number
  uptimeSec?: number
  available: boolean
}

type DataCallback = (data: string) => void
type CloseCallback = () => void
type MetricsCallback = (data: LiveMetrics) => void

const dataHandlers = new Map<string, DataCallback>()
const closeHandlers = new Map<string, CloseCallback>()
const metricsHandlers = new Map<string, MetricsCallback>()

let initialized = false

function init() {
  if (initialized) return
  initialized = true

  window.api.ssh.onData((streamId, data) => {
    dataHandlers.get(streamId)?.(data)
  })

  window.api.ssh.onClose((streamId) => {
    closeHandlers.get(streamId)?.()
  })

  window.api.ssh.onMetrics((streamId, data) => {
    metricsHandlers.get(streamId)?.(data)
  })
}

export function registerStream(
  streamId: string,
  onData: DataCallback,
  onClose: CloseCallback,
  onMetrics: MetricsCallback,
) {
  init()
  dataHandlers.set(streamId, onData)
  closeHandlers.set(streamId, onClose)
  metricsHandlers.set(streamId, onMetrics)
}

export function unregisterStream(streamId: string) {
  dataHandlers.delete(streamId)
  closeHandlers.delete(streamId)
  metricsHandlers.delete(streamId)
}
