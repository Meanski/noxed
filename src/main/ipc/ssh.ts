import { ipcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { Client, ClientChannel } from 'ssh2'
import { randomUUID } from 'crypto'
import { ConnectionError, OwnershipError, ValidationError, toMessage } from './errors'
import { validateHost, validatePort } from './security'
import {
  SSH_CONNECT_DEFAULTS,
  sshConnectOptions,
  connectSessionClient,
  openJumpSocket,
  ManagedSshConnection,
} from './sshClients'
import { METRICS_COMMAND, parseMetricsOutput, RemoteMetrics, CpuStatSample } from './metrics'

export { SSH_CONNECT_DEFAULTS, sshConnectOptions, parseKeepaliveIntervalMs } from './sshClients'

interface ActiveStream {
  client: Client
  stream: NodeJS.ReadWriteStream
  sender: WebContents
  // Bastion chain when the session connects through a jump host
  upstream?: ManagedSshConnection
}

interface SshConnectConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  jumpHostId?: string
}

interface MetricsTimers {
  initial: NodeJS.Timeout | null
  interval: NodeJS.Timeout | null
  inFlight: boolean
}

const streams = new Map<string, ActiveStream>()
const metricsTimers = new Map<string, MetricsTimers>()
const prevCpuStats = new Map<string, CpuStatSample>()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_SSH_DATA_BYTES = 64 * 1024
const MAX_USERNAME_LENGTH = 128
const MAX_KEY_BYTES = 64 * 1024
const MAX_PASSWORD_BYTES = 1024

function validateStreamId(streamId: unknown): string {
  if (typeof streamId !== 'string' || !UUID_RE.test(streamId)) {
    throw new ValidationError('Invalid SSH stream id')
  }
  return streamId
}

function validateSshData(data: unknown): string {
  if (typeof data !== 'string') throw new ValidationError('Invalid SSH data')
  if (Buffer.byteLength(data, 'utf8') > MAX_SSH_DATA_BYTES) {
    throw new ValidationError('SSH data payload is too large')
  }
  return data
}

function validateDimension(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1000) {
    throw new ValidationError(`Invalid terminal ${name}`)
  }
  return value as number
}

function validateConnectConfig(config: unknown): SshConnectConfig {
  if (!config || typeof config !== 'object') throw new ValidationError('Invalid SSH config')
  const candidate = config as Record<string, unknown>

  const host = validateHost(candidate.host, 'SSH host')
  const port = validatePort(candidate.port, 'SSH port')

  if (typeof candidate.username !== 'string' || candidate.username.trim().length === 0 || candidate.username.length > MAX_USERNAME_LENGTH) {
    throw new ValidationError('Invalid SSH username')
  }
  if (candidate.password !== undefined && typeof candidate.password !== 'string') {
    throw new ValidationError('Invalid SSH password')
  }
  if (typeof candidate.password === 'string' && Buffer.byteLength(candidate.password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new ValidationError('SSH password too large')
  }
  if (candidate.privateKey !== undefined && typeof candidate.privateKey !== 'string') {
    throw new ValidationError('Invalid SSH private key')
  }
  if (typeof candidate.privateKey === 'string' && Buffer.byteLength(candidate.privateKey, 'utf8') > MAX_KEY_BYTES) {
    throw new ValidationError('SSH private key too large')
  }
  if (candidate.jumpHostId !== undefined && (typeof candidate.jumpHostId !== 'string' || candidate.jumpHostId.length > 128)) {
    throw new ValidationError('Invalid jump host id')
  }

  return {
    host,
    port,
    username: candidate.username,
    password: candidate.password as string | undefined,
    privateKey: candidate.privateKey as string | undefined,
    jumpHostId: candidate.jumpHostId as string | undefined,
  }
}

function sendData(streamId: string, data: string): void {
  const entry = streams.get(streamId)
  if (!entry || entry.sender.isDestroyed()) return
  entry.sender.send('ssh:data', streamId, data)
}

function sendClosed(streamId: string): void {
  const entry = streams.get(streamId)
  if (!entry || entry.sender.isDestroyed()) return
  entry.sender.send('ssh:closed', streamId)
}

function sendMetrics(streamId: string, payload: RemoteMetrics): void {
  const entry = streams.get(streamId)
  if (!entry || entry.sender.isDestroyed()) return
  entry.sender.send('ssh:metrics', streamId, payload)
}

function getOwnedStream(event: IpcMainEvent | IpcMainInvokeEvent, streamId: string): ActiveStream | undefined {
  const entry = streams.get(streamId)
  if (!entry) return undefined
  if (entry.sender.id !== event.sender.id) {
    throw new OwnershipError('SSH stream')
  }
  return entry
}

export function getOwnedSshClient(event: IpcMainEvent | IpcMainInvokeEvent, rawStreamId: unknown): Client | undefined {
  const streamId = validateStreamId(rawStreamId)
  return getOwnedStream(event, streamId)?.client
}

function stopMetrics(streamId: string): void {
  const t = metricsTimers.get(streamId)
  if (t) {
    if (t.initial) clearTimeout(t.initial)
    if (t.interval) clearInterval(t.interval)
  }
  metricsTimers.delete(streamId)
  prevCpuStats.delete(streamId)
}

function disposeStream(streamId: string): void {
  stopMetrics(streamId)
  const entry = streams.get(streamId)
  if (!entry) return
  streams.delete(streamId)
  try { entry.stream.end() } catch (err) { console.error(`[ssh] end stream ${streamId}: ${toMessage(err)}`) }
  try { entry.client.end() } catch (err) { console.error(`[ssh] end client ${streamId}: ${toMessage(err)}`) }
  entry.upstream?.dispose()
}

export function disposeSshStreamsForSender(senderId: number): void {
  for (const [id, entry] of streams) {
    if (entry.sender.id === senderId) disposeStream(id)
  }
}

export function registerSshHandlers(): void {
  ipcMain.handle(
    'ssh:connect',
    async (event: IpcMainInvokeEvent, rawConfig: unknown) => {
      const config = validateConnectConfig(rawConfig)

      // Jump-host credentials are resolved in main from the saved session —
      // the renderer only ever names the bastion, never holds its secrets.
      let upstream: ManagedSshConnection | undefined
      let sock: ClientChannel | undefined
      if (config.jumpHostId) {
        upstream = await connectSessionClient(config.jumpHostId)
        try {
          sock = await openJumpSocket(upstream.client, config.host, config.port)
        } catch (err) {
          upstream.dispose()
          throw err
        }
      }

      return new Promise<string>((resolve, reject) => {
        const client = new Client()
        const streamId = randomUUID()
        let settled = false
        const settle = (fn: () => void) => { if (settled) return; settled = true; fn() }

        client.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
          if (!config.password) { finish([]); return }
          finish(prompts.map(() => config.password ?? ''))
        })

        client.on('ready', () => {
          client.setNoDelay(true)
          client.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              client.end()
              upstream?.dispose()
              settle(() => reject(new ConnectionError(toMessage(err))))
              return
            }
            streams.set(streamId, { client, stream, sender: event.sender, upstream })

            stream.on('data', (data: Buffer) => sendData(streamId, data.toString('utf8')))
            stream.stderr.on('data', (data: Buffer) => sendData(streamId, data.toString('utf8')))

            stream.on('close', () => {
              stopMetrics(streamId)
              sendClosed(streamId)
              streams.delete(streamId)
              upstream?.dispose()
            })

            settle(() => resolve(streamId))
          })
        })

        client.on('error', (err) => {
          if (!settled) {
            upstream?.dispose()
            settle(() => reject(new ConnectionError(toMessage(err))))
            return
          }
          // Already-connected clients can also emit 'error' — surface as close.
          stopMetrics(streamId)
          sendClosed(streamId)
          streams.delete(streamId)
          try { client.end() } catch (e) { console.error(`[ssh] end after error ${streamId}: ${toMessage(e)}`) }
          upstream?.dispose()
        })

        client.connect({
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          privateKey: config.privateKey,
          sock,
          agent: process.env.SSH_AUTH_SOCK,
          tryKeyboard: true,
          ...sshConnectOptions(),
          algorithms: { ...SSH_CONNECT_DEFAULTS.algorithms },
        })
      })
    }
  )

  ipcMain.on('ssh:data', (event: IpcMainEvent, rawStreamId: unknown, rawData: unknown) => {
    let entry: ActiveStream | undefined
    let data: string
    try {
      const streamId = validateStreamId(rawStreamId)
      data = validateSshData(rawData)
      entry = getOwnedStream(event, streamId)
    } catch (err) {
      if (err instanceof ValidationError || err instanceof OwnershipError) return
      throw err
    }
    entry?.stream.write(data)
  })

  ipcMain.on('ssh:resize', (event: IpcMainEvent, rawStreamId: unknown, rawCols: unknown, rawRows: unknown) => {
    let entry: ActiveStream | undefined
    let cols: number
    let rows: number
    try {
      const streamId = validateStreamId(rawStreamId)
      cols = validateDimension(rawCols, 'columns')
      rows = validateDimension(rawRows, 'rows')
      entry = getOwnedStream(event, streamId)
    } catch (err) {
      if (err instanceof ValidationError || err instanceof OwnershipError) return
      throw err
    }
    if (entry && 'setWindow' in entry.stream && typeof (entry.stream as { setWindow?: unknown }).setWindow === 'function') {
      ;(entry.stream as { setWindow: (rows: number, cols: number, height: number, width: number) => void })
        .setWindow(rows, cols, 0, 0)
    }
  })

  ipcMain.handle('ssh:disconnect', (event: IpcMainInvokeEvent, rawStreamId: unknown) => {
    const streamId = validateStreamId(rawStreamId)
    const entry = getOwnedStream(event, streamId)
    if (!entry) return
    disposeStream(streamId)
  })

  // ── Metrics ────────────────────────────────────────────────────────────────

  function fetchAndEmit(streamId: string): void {
    const live = streams.get(streamId)
    if (!live) { stopMetrics(streamId); return }
    const timers = metricsTimers.get(streamId)
    if (!timers || timers.inFlight) return
    timers.inFlight = true

    live.client.exec(METRICS_COMMAND, (err, s) => {
      if (err) { timers.inFlight = false; return }
      let out = ''
      s.on('data', (d: Buffer) => { out += d.toString() })
      // stderr is intentionally drained to keep the channel from buffering;
      // remote `cat`/`grep` may report 'no such file' on non-Linux hosts.
      s.stderr.on('data', () => {})
      s.on('close', () => {
        const t = metricsTimers.get(streamId)
        if (t) t.inFlight = false
        try {
          const { metrics, cpuStat } = parseMetricsOutput(out, prevCpuStats.get(streamId))
          if (cpuStat) prevCpuStats.set(streamId, cpuStat)
          sendMetrics(streamId, metrics)
        } catch (parseErr) {
          // Best-effort metrics: malformed remote output (non-Linux, BSD, etc.)
          // must not crash or stop the shell stream.
          console.error(`[ssh] metrics parse ${streamId}: ${toMessage(parseErr)}`)
        }
      })
      s.on('error', (e: unknown) => {
        const t = metricsTimers.get(streamId)
        if (t) t.inFlight = false
        console.error(`[ssh] metrics exec ${streamId}: ${toMessage(e)}`)
      })
    })
  }

  ipcMain.handle('ssh:metrics-start', (event: IpcMainInvokeEvent, rawStreamId: unknown) => {
    const streamId = validateStreamId(rawStreamId)
    const entry = getOwnedStream(event, streamId)
    if (!entry) return

    stopMetrics(streamId)
    const timers: MetricsTimers = { initial: null, interval: null, inFlight: false }
    metricsTimers.set(streamId, timers)

    fetchAndEmit(streamId)
    timers.initial = setTimeout(() => fetchAndEmit(streamId), 2000)
    timers.interval = setInterval(() => fetchAndEmit(streamId), 5000)
  })

  ipcMain.on('ssh:metrics-stop', (event: IpcMainEvent, rawStreamId: unknown) => {
    try {
      const streamId = validateStreamId(rawStreamId)
      if (getOwnedStream(event, streamId)) stopMetrics(streamId)
    } catch (err) {
      if (err instanceof ValidationError || err instanceof OwnershipError) return
      throw err
    }
  })
}
