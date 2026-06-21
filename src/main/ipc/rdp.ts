import { ipcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { is } from '@electron-toolkit/utils'
import { NotFoundError, OwnershipError, ValidationError, ConnectionError, toMessage } from './errors'

// RDP via the FreeRDP sidecar (native/rdp-spike/rdp-sidecar). The sidecar
// connects to a host and writes composed frames to stdout as length-prefixed
// BGRA blobs; we parse that stream and forward each frame to the renderer's
// canvas. Same shape as localTerminal.ts spawning node-pty, but the payload is
// binary pixels instead of terminal text.
//
// SPIKE STATUS: output-only (read-only desktop). Input injection and a bundled,
// signed sidecar binary for packaged builds are the next milestones.

interface RdpSession {
  proc: ChildProcessWithoutNullStreams
  sender: WebContents
  // Accumulates partial stdout until a full frame is available.
  buffer: Buffer
  // How many times we've had to resync past stray bytes — capped logging.
  resyncs: number
}

const sessions = new Map<string, RdpSession>()

// Frame header: "NXF1" + u32 width + u32 height + u32 dataLen (all LE).
const MAGIC = 'NXF1'
const MAGIC_BYTES = Buffer.from(MAGIC, 'ascii')
const HEADER_BYTES = 16
// Guardrail: reject absurd frame sizes so a desync can't make us buffer forever.
const MAX_FRAME_BYTES = 64 * 1024 * 1024
// Cap how many resync events we log per session so a chatty stream can't spam.
const MAX_RESYNC_LOGS = 5

function sidecarPath(): string {
  // In dev, run the binary straight out of the spike folder. In a packaged app
  // it would ship under resources/ — not wired up yet (spike).
  const devPath = join(process.cwd(), 'native', 'rdp-spike', 'rdp-sidecar')
  const prodPath = join(process.resourcesPath ?? '', 'rdp-sidecar')
  if (is.dev && existsSync(devPath)) return devPath
  return existsSync(prodPath) ? prodPath : devPath
}

function requireSession(event: IpcMainEvent | IpcMainInvokeEvent, rawId: unknown): RdpSession {
  if (typeof rawId !== 'string') throw new ValidationError('Invalid RDP session id')
  const entry = sessions.get(rawId)
  if (!entry) throw new NotFoundError('RDP session')
  if (entry.sender.id !== event.sender.id) throw new OwnershipError('RDP session')
  return entry
}

function disposeSession(id: string): void {
  const entry = sessions.get(id)
  if (!entry) return
  sessions.delete(id)
  try {
    entry.proc.kill()
  } catch (err) {
    console.error(`[rdp] kill ${id}: ${toMessage(err)}`)
  }
}

export function disposeRdpSessionsForSender(senderId: number): void {
  for (const [id, entry] of sessions) {
    if (entry.sender.id === senderId) disposeSession(id)
  }
}

// When the buffer doesn't start with the magic, some non-frame bytes leaked onto
// stdout (e.g. a library logging there). Skip forward to the next "NXF1" so the
// stream self-heals instead of dying. Logs the stray bytes (capped) so we can
// see what's polluting the channel. Returns false if no magic is visible yet
// (so the caller waits for more data instead of dropping a partial header).
function resyncToMagic(id: string, entry: RdpSession): boolean {
  const idx = entry.buffer.indexOf(MAGIC_BYTES, 1)
  if (idx === -1) {
    // No magic anywhere; keep the trailing bytes that might be a split magic.
    if (entry.buffer.length > 3) {
      logStray(id, entry, entry.buffer.subarray(0, entry.buffer.length - 3))
      entry.buffer = entry.buffer.subarray(entry.buffer.length - 3)
    }
    return false
  }
  logStray(id, entry, entry.buffer.subarray(0, idx))
  entry.buffer = entry.buffer.subarray(idx)
  return true
}

function logStray(id: string, entry: RdpSession, stray: Buffer): void {
  if (stray.length === 0 || entry.resyncs >= MAX_RESYNC_LOGS) return
  entry.resyncs++
  const sample = stray.subarray(0, 96)
  const ascii = sample.toString('latin1').replace(/[^\x20-\x7e]/g, '.')
  console.error(
    `[rdp] resync ${id}: skipped ${stray.length} stray bytes on stdout` +
      ` — ascii="${ascii}"${stray.length > 96 ? ' …' : ''}`,
  )
}

// Pull every complete frame out of the accumulated buffer and forward it.
function drainFrames(id: string, entry: RdpSession): void {
  for (;;) {
    if (entry.buffer.length < HEADER_BYTES) return

    if (entry.buffer.toString('ascii', 0, 4) !== MAGIC) {
      // Non-frame bytes on stdout — recover by skipping to the next frame.
      if (!resyncToMagic(id, entry)) return
      continue
    }

    const width = entry.buffer.readUInt32LE(4)
    const height = entry.buffer.readUInt32LE(8)
    const dataLen = entry.buffer.readUInt32LE(12)

    if (dataLen > MAX_FRAME_BYTES) {
      // Almost certainly a false "NXF1" matched inside pixel data — skip past it.
      if (!resyncToMagic(id, entry)) return
      continue
    }

    const total = HEADER_BYTES + dataLen
    if (entry.buffer.length < total) return // wait for more chunks

    const pixels = entry.buffer.subarray(HEADER_BYTES, total)
    if (!entry.sender.isDestroyed()) {
      // Copy out: the backing buffer is about to be sliced/reused.
      entry.sender.send('rdp:frame', id, width, height, Buffer.from(pixels))
    }
    entry.buffer = entry.buffer.subarray(total)
  }
}

export function registerRdpHandlers(): void {
  ipcMain.handle('rdp:connect', (event, rawConfig: unknown) => {
    const config = rawConfig as Record<string, unknown>
    const host = config?.host
    const username = config?.username
    const password = config?.password
    if (typeof host !== 'string' || !host) throw new ValidationError('Host is required')
    if (typeof username !== 'string' || !username) throw new ValidationError('Username is required')
    if (typeof password !== 'string') throw new ValidationError('Password is required')

    const port = typeof config.port === 'number' ? config.port : 3389
    const width = typeof config.width === 'number' ? config.width : 1280
    const height = typeof config.height === 'number' ? config.height : 800

    const bin = sidecarPath()
    if (!existsSync(bin)) {
      throw new ConnectionError(
        'RDP sidecar binary not found. Build it: cd native/rdp-spike && make rdp-sidecar',
      )
    }

    const proc = spawn(
      bin,
      [host, String(port), username, password, String(width), String(height)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )

    const id = randomUUID()
    const entry: RdpSession = { proc, sender: event.sender, buffer: Buffer.alloc(0), resyncs: 0 }
    sessions.set(id, entry)

    // The sidecar prints an authoritative outcome line ("[sidecar] ...") to
    // stderr alongside FreeRDP's verbose logs. Keep the last one so a failed
    // connect surfaces *why* in the tab instead of a bare exit code.
    let lastSidecarMsg: string | null = null

    proc.stdout.on('data', (chunk: Buffer) => {
      entry.buffer = entry.buffer.length ? Buffer.concat([entry.buffer, chunk]) : chunk
      drainFrames(id, entry)
    })

    // Sidecar diagnostics (connect status, errors) come on stderr.
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      console.error(`[rdp-sidecar ${id}] ${text.trimEnd()}`)
      for (const line of text.split('\n')) {
        const m = line.match(/\[sidecar\]\s*(.+?)\s*$/)
        if (m) lastSidecarMsg = m[1]
      }
    })

    proc.on('error', (err) => {
      sessions.delete(id)
      if (!event.sender.isDestroyed()) event.sender.send('rdp:closed', id, toMessage(err))
    })

    proc.on('exit', (code) => {
      sessions.delete(id)
      if (!event.sender.isDestroyed()) {
        const reason =
          code === 0 ? null : lastSidecarMsg ?? `sidecar exited (${code})`
        event.sender.send('rdp:closed', id, reason)
      }
    })

    return id
  })

  ipcMain.handle('rdp:disconnect', (event, rawId: unknown) => {
    requireSession(event, rawId)
    disposeSession(rawId as string)
  })
}
