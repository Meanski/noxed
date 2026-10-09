import type { SFTPWrapper } from 'ssh2'
import { ConnectionError, NotFoundError, ValidationError, toMessage } from '../errors'
import { getSessionById, listSessions, type Session } from '../sessions'
import { connectSessionClient, execCapture, type ManagedSshConnection } from '../sshClients'
import { listDir, readTextFile } from '../sftp'
import { blockedShellCommandReason } from '../security'
import { requestApproval } from './mcpApprovals'
import type { McpTool } from './mcpServer'

// What an AI agent can do with noxed: see which servers are saved, run a
// command, and read files, all over the user's own SSH connections and only
// after the user approves each request. Credentials never leave main.

const MAX_COMMAND_LENGTH = 4096
const MAX_PATH_LENGTH = 4096
const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_S = 60
const MAX_TIMEOUT_S = 300

const label = (s: Session) => s.label || `${s.username}@${s.host}`

function requireString(args: Record<string, unknown>, key: string, max: number): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || value.includes('\0')) {
    throw new ValidationError(`"${key}" must be a non-empty string`)
  }
  return value
}

function requireSshSession(args: Record<string, unknown>): Session {
  const id = requireString(args, 'connection_id', 128)
  const session = getSessionById(id)
  if (!session) throw new NotFoundError(`Connection ${id} (use list_connections for valid ids)`)
  if ((session.type ?? 'ssh') !== 'ssh') throw new ValidationError(`${label(session)} is a ${session.type} connection; these tools need an SSH server`)
  return session
}

function timeoutSeconds(args: Record<string, unknown>): number {
  const raw = args.timeout_seconds
  if (raw === undefined) return DEFAULT_TIMEOUT_S
  if (!Number.isInteger(raw) || (raw as number) < 1 || (raw as number) > MAX_TIMEOUT_S) {
    throw new ValidationError(`"timeout_seconds" must be a whole number from 1 to ${MAX_TIMEOUT_S}`)
  }
  return raw as number
}

/** Runs `action` with an SFTP view of the session, closing the connection after. */
async function withFiles<T>(session: Session, action: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const conn: ManagedSshConnection = await connectSessionClient(session.id)
  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      conn.client.sftp((err, channel) => (err ? reject(new ConnectionError(toMessage(err))) : resolve(channel)))
    })
    return await action(sftp)
  } finally {
    conn.dispose()
  }
}

const connectionIdProperty = { type: 'string', description: 'The connection id from list_connections.' }

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'list_connections',
    title: 'List saved connections',
    description: 'Lists the servers saved in noxed (names, hosts, users and types; never passwords or keys). Use an SSH connection\'s id with the other tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async () => JSON.stringify(
      listSessions().map((s) => ({ id: s.id, name: label(s), type: s.type ?? 'ssh', host: s.host, port: s.port, username: s.username, group: s.group })),
      null,
      2,
    ),
  },
  {
    name: 'run_command',
    title: 'Run a shell command',
    description: 'Runs a shell command on an SSH server saved in noxed and returns its exit code and output. The user sees the exact command and must approve it in noxed first. Prefer read-only commands; a few destructive commands are always refused.',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: connectionIdProperty,
        command: { type: 'string', description: 'The command to run, as you would type it in a shell.' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_S, description: `Give up after this long (default ${DEFAULT_TIMEOUT_S}).` },
      },
      required: ['connection_id', 'command'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    run: async (args) => {
      const session = requireSshSession(args)
      const command = requireString(args, 'command', MAX_COMMAND_LENGTH)
      const timeout = timeoutSeconds(args)
      const blocked = blockedShellCommandReason(command)
      if (blocked) throw new ValidationError(`Refused: ${blocked}`)
      await requestApproval('command', session.id, label(session), command)
      const conn = await connectSessionClient(session.id)
      try {
        const { stdout, stderr, code, truncated } = await execCapture(conn.client, command, { timeoutMs: timeout * 1000, maxBytes: MAX_OUTPUT_BYTES })
        const parts = [`exit code: ${code ?? 'none (terminated by a signal)'}`]
        if (stdout) parts.push(`stdout:\n${stdout}`)
        if (stderr) parts.push(`stderr:\n${stderr}`)
        if (truncated) parts.push(`(output cut at ${MAX_OUTPUT_BYTES / 1024} KB per stream)`)
        return parts.join('\n\n')
      } finally {
        conn.dispose()
      }
    },
  },
  {
    name: 'list_directory',
    title: 'List a remote directory',
    description: 'Lists a directory on an SSH server saved in noxed, over SFTP. The user approves reads in noxed first.',
    inputSchema: {
      type: 'object',
      properties: { connection_id: connectionIdProperty, path: { type: 'string', description: 'Absolute path, e.g. /var/log.' } },
      required: ['connection_id', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args) => {
      const session = requireSshSession(args)
      const path = requireString(args, 'path', MAX_PATH_LENGTH)
      await requestApproval('read', session.id, label(session), `list ${path}`)
      const entries = await withFiles(session, (sftp) => listDir(sftp, path))
      return entries
        .map((e) => `${e.isDirectory ? 'd' : '-'} ${String(e.size).padStart(10)}  ${new Date(e.mtime).toISOString()}  ${e.name}`)
        .join('\n') || '(empty)'
    },
  },
  {
    name: 'read_file',
    title: 'Read a remote text file',
    description: 'Reads a text file (up to a few MB) from an SSH server saved in noxed, over SFTP. Binary files are refused. The user approves reads in noxed first.',
    inputSchema: {
      type: 'object',
      properties: { connection_id: connectionIdProperty, path: { type: 'string', description: 'Absolute path to the file.' } },
      required: ['connection_id', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args) => {
      const session = requireSshSession(args)
      const path = requireString(args, 'path', MAX_PATH_LENGTH)
      await requestApproval('read', session.id, label(session), `read ${path}`)
      return withFiles(session, (sftp) => readTextFile(sftp, path))
    },
  },
]
