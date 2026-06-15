import { ipcMain } from 'electron'
import { readdirSync, statSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { isInsideHome, isLikelyTextFile } from './security'
import { ValidationError } from './errors'

const MAX_LOCAL_TEXT_BYTES = 10 * 1024 * 1024

function validateHomePath(rawPath: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) throw new ValidationError('Path is required')
  const check = isInsideHome(rawPath)
  if (!check.ok) throw new ValidationError(check.reason)
  return check.resolved
}

export function registerLocalFsHandlers(): void {
  ipcMain.handle('localfs:home', () => homedir())

  ipcMain.handle('localfs:list', (_e, dirPath: unknown) => {
    const resolved = validateHomePath(dirPath)

    const items = readdirSync(resolved, { withFileTypes: true })
    return items.map(entry => {
      const fullPath = join(resolved, entry.name)
      try {
        const stats = statSync(fullPath)
        return {
          name: entry.name,
          size: stats.size,
          mtime: stats.mtimeMs,
          permissions: stats.mode,
          isDirectory: entry.isDirectory(),
          path: fullPath,
        }
      } catch {
        return {
          name: entry.name,
          size: 0,
          mtime: 0,
          permissions: 0,
          isDirectory: entry.isDirectory(),
          path: fullPath,
        }
      }
    })
  })

  ipcMain.handle('localfs:readTextFile', async (_e, filePath: unknown) => {
    const resolved = validateHomePath(filePath)
    const stats = statSync(resolved)
    if (!stats.isFile()) throw new ValidationError('Not a regular file')
    if (!isLikelyTextFile(resolved, stats.size)) {
      throw new ValidationError('Cannot open binary file in editor')
    }
    const buf = await readFile(resolved)
    if (buf.subarray(0, 8192).includes(0)) {
      throw new ValidationError('File appears to be binary')
    }
    return buf.toString('utf8')
  })

  ipcMain.handle('localfs:writeTextFile', async (_e, filePath: unknown, content: unknown) => {
    const resolved = validateHomePath(filePath)
    if (typeof content !== 'string') throw new ValidationError('Invalid file content')
    if (Buffer.byteLength(content, 'utf8') > MAX_LOCAL_TEXT_BYTES) {
      throw new ValidationError('File content is too large')
    }
    await writeFile(resolved, content, 'utf8')
    return true
  })
}
