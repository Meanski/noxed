import { ipcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { spawn, IPty } from 'node-pty'
import { homedir, platform } from 'os'
import { randomUUID } from 'crypto'
import { NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'

// Local shell sessions via node-pty: the user's default shell on
// macOS/Linux, PowerShell through ConPTY on Windows.

interface LocalPty {
  pty: IPty
  sender: WebContents
}

const ptys = new Map<string, LocalPty>()

const MAX_WRITE_BYTES = 64 * 1024

export function defaultShell(): { shell: string; args: string[] } {
  if (platform() === 'win32') {
    // ConPTY drives PowerShell natively; WSL users can simply run `wsl` inside
    return { shell: 'powershell.exe', args: [] }
  }
  const shell = process.env.SHELL || (platform() === 'darwin' ? '/bin/zsh' : '/bin/bash')
  // Login shell so the user's profile (PATH, aliases, prompt) loads
  return { shell, args: ['-l'] }
}

function validateDimension(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1000) {
    throw new ValidationError(`Invalid terminal ${name}`)
  }
  return value as number
}

function requirePty(event: IpcMainEvent | IpcMainInvokeEvent, rawId: unknown): LocalPty {
  if (typeof rawId !== 'string') throw new ValidationError('Invalid terminal id')
  const entry = ptys.get(rawId)
  if (!entry) throw new NotFoundError('Local terminal')
  if (entry.sender.id !== event.sender.id) throw new OwnershipError('Local terminal')
  return entry
}

function disposePty(id: string): void {
  const entry = ptys.get(id)
  if (!entry) return
  ptys.delete(id)
  try { entry.pty.kill() } catch (err) { console.error(`[localpty] kill ${id}: ${toMessage(err)}`) }
}

export function disposeLocalPtysForSender(senderId: number): void {
  for (const [id, entry] of ptys) {
    if (entry.sender.id === senderId) disposePty(id)
  }
}

export function registerLocalTerminalHandlers(): void {
  ipcMain.handle('localpty:start', (event, rawCols: unknown, rawRows: unknown) => {
    const cols = validateDimension(rawCols, 'columns')
    const rows = validateDimension(rawRows, 'rows')
    const { shell, args } = defaultShell()

    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: homedir(),
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    })

    const id = randomUUID()
    ptys.set(id, { pty, sender: event.sender })

    pty.onData((data) => {
      if (!event.sender.isDestroyed()) event.sender.send('localpty:data', id, data)
    })
    pty.onExit(({ exitCode }) => {
      ptys.delete(id)
      if (!event.sender.isDestroyed()) event.sender.send('localpty:exit', id, exitCode)
    })

    return id
  })

  ipcMain.on('localpty:write', (event, rawId: unknown, rawData: unknown) => {
    let entry: LocalPty
    try {
      entry = requirePty(event, rawId)
    } catch (err) {
      if (err instanceof ValidationError || err instanceof NotFoundError || err instanceof OwnershipError) return
      throw err
    }
    if (typeof rawData !== 'string' || Buffer.byteLength(rawData, 'utf8') > MAX_WRITE_BYTES) return
    entry.pty.write(rawData)
  })

  ipcMain.on('localpty:resize', (event, rawId: unknown, rawCols: unknown, rawRows: unknown) => {
    try {
      const entry = requirePty(event, rawId)
      entry.pty.resize(validateDimension(rawCols, 'columns'), validateDimension(rawRows, 'rows'))
    } catch (err) {
      if (err instanceof ValidationError || err instanceof NotFoundError || err instanceof OwnershipError) return
      throw err
    }
  })

  ipcMain.handle('localpty:kill', (event, rawId: unknown) => {
    requirePty(event, rawId)
    disposePty(rawId as string)
  })
}
