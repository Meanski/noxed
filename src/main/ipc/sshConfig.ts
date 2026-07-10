import { ipcMain } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

export interface SshConfigHost {
  alias: string
  host: string
  port: number
  username?: string
  keyPath?: string
  proxyJump?: string
}

interface HostBlock {
  aliases: string[]
  hostname?: string
  port?: number
  username?: string
  keyPath?: string
  proxyJump?: string
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

// Splits a config line into its keyword and argument. ssh_config accepts both
// "Key Value" and "Key=Value" forms.
function splitDirective(line: string): { key: string; value: string } | null {
  const match = /^([^\s=]+)(?:\s*=\s*|\s+)(.+)$/.exec(line)
  if (!match) return null
  return { key: match[1].toLowerCase(), value: match[2].trim() }
}

function finalizeBlock(block: HostBlock, out: SshConfigHost[]): void {
  for (const alias of block.aliases) {
    out.push({
      alias,
      host: block.hostname ?? alias,
      port: block.port ?? 22,
      username: block.username,
      keyPath: block.keyPath,
      proxyJump: block.proxyJump,
    })
  }
}

// Wildcard and negated Host patterns describe defaults, not servers.
function parseHostAliases(value: string): string[] {
  return value
    .split(/\s+/)
    .map(unquote)
    .filter(pattern => pattern && !/[*?!]/.test(pattern))
}

function applyDirective(block: HostBlock, key: string, value: string): void {
  switch (key) {
    case 'hostname':
      block.hostname = unquote(value)
      break
    case 'port': {
      const port = Number(unquote(value))
      if (Number.isInteger(port) && port >= 1 && port <= 65535) block.port = port
      break
    }
    case 'user':
      block.username = unquote(value)
      break
    case 'identityfile':
      // ssh tries identity files in order; the first listed is the primary
      block.keyPath ??= unquote(value)
      break
    case 'proxyjump': {
      // Multi-hop chains (a,b,c) reduce to the first hop here; deeper
      // chains resolve recursively if that hop is itself imported.
      const firstHop = unquote(value).split(',')[0]?.trim()
      if (firstHop && firstHop.toLowerCase() !== 'none') block.proxyJump = firstHop
      break
    }
  }
}

/**
 * Extracts concrete host entries from ssh_config content. Wildcard and
 * negated Host patterns are skipped (they describe defaults, not servers),
 * as are Match blocks and Include directives.
 */
export function parseSshConfig(content: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  let block: HostBlock | null = null
  let inMatchBlock = false

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const directive = splitDirective(line)
    if (!directive) continue
    const { key, value } = directive

    if (key === 'host') {
      if (block) finalizeBlock(block, hosts)
      inMatchBlock = false
      block = { aliases: parseHostAliases(value) }
      continue
    }

    if (key === 'match') {
      if (block) finalizeBlock(block, hosts)
      block = null
      inMatchBlock = true
      continue
    }

    if (!inMatchBlock && block) applyDirective(block, key, value)
  }

  if (block) finalizeBlock(block, hosts)
  return hosts
}

export function registerSshConfigHandlers(): void {
  ipcMain.handle('sshconfig:hosts', async () => {
    let content: string
    try {
      content = await readFile(join(homedir(), '.ssh', 'config'), 'utf-8')
    } catch (err: any) {
      if (err?.code === 'ENOENT') return []
      throw new Error(`Cannot read ~/.ssh/config: ${err?.message ?? err}`)
    }
    return parseSshConfig(content)
  })
}
