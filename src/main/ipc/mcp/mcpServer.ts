import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { toMessage } from '../errors'

// A Model Context Protocol server over Streamable HTTP, reduced to what
// noxed needs: JSON-RPC requests on POST /mcp answered with JSON (no SSE
// streams, no server-initiated messages), tools only.

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  /** Hints for the client; noxed still asks the user before acting. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
  run(args: Record<string, unknown>): Promise<string>
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } }

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
const MAX_BODY_BYTES = 1024 * 1024
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

const SERVER_INFO = { name: 'noxed', title: 'noxed', version: '1' }
const INSTRUCTIONS = 'Tools for the SSH servers saved in noxed. Every command and file read is shown to the user in noxed for approval first; a denied request returns an error.'

function failure(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function isRequest(value: unknown): value is JsonRpcRequest {
  const v = value as JsonRpcRequest
  return !!v && typeof v === 'object' && v.jsonrpc === '2.0' && typeof v.method === 'string'
}

function initializeResult(params: Record<string, unknown>) {
  const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
  return {
    protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  }
}

async function callTool(id: string | number | null, params: Record<string, unknown>, tools: readonly McpTool[]): Promise<JsonRpcResponse> {
  const tool = tools.find((t) => t.name === params.name)
  if (!tool) return failure(id, INVALID_PARAMS, `Unknown tool: ${typeof params.name === 'string' ? params.name : JSON.stringify(params.name)}`)
  const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {}
  try {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await tool.run(args) }], isError: false } }
  } catch (err) {
    // Tool failures (including a user's denial) are results the model
    // should read, not protocol errors.
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: toMessage(err) }], isError: true } }
  }
}

/** Answers one JSON-RPC message; null for notifications, which get no reply. */
export async function handleMcpMessage(message: unknown, tools: readonly McpTool[]): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) return failure(null, INVALID_REQUEST, 'Invalid JSON-RPC request')
  const { id, method, params = {} } = message
  if (id === undefined) return null

  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: initializeResult(params) }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) },
      }
    case 'tools/call':
      return callTool(id, params, tools)
    default:
      return failure(id, METHOD_NOT_FOUND, `Method not found: ${method}`)
  }
}

function tokensMatch(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(token)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

// Browsers can be steered at localhost (DNS rebinding); only a request
// addressed to the loopback name, from no web origin or a local one, counts.
function isLocalRequest(req: IncomingMessage, port: number): boolean {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  if (!hosts.has(req.headers.host ?? '')) return false
  const origin = req.headers.origin
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

function reply(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function respond(req: IncomingMessage, res: ServerResponse, port: number, token: string, tools: readonly McpTool[]): Promise<void> {
  if (!isLocalRequest(req, port)) return reply(res, 403, failure(null, INVALID_REQUEST, 'Forbidden'))
  if (!tokensMatch(req.headers.authorization, token)) return reply(res, 401, failure(null, INVALID_REQUEST, 'Unauthorized'))
  if (req.url !== '/mcp') return reply(res, 404)
  // No server-to-client stream: GET (SSE) and DELETE (session end) aren't offered.
  if (req.method !== 'POST') return reply(res, 405)

  const body = await readBody(req)
  if (body === null) return reply(res, 413, failure(null, INVALID_REQUEST, 'Request too large'))
  let message: unknown
  try {
    message = JSON.parse(body)
  } catch {
    return reply(res, 400, failure(null, PARSE_ERROR, 'Parse error'))
  }
  const answers = (await Promise.all((Array.isArray(message) ? message : [message]).map((m) => handleMcpMessage(m, tools))))
    .filter((a): a is JsonRpcResponse => a !== null)
  if (answers.length === 0) return reply(res, 202)
  reply(res, 200, Array.isArray(message) ? answers : answers[0])
}

/** Listens on 127.0.0.1 only. */
export function startMcpServer(port: number, token: string, tools: readonly McpTool[]): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      respond(req, res, port, token, tools).catch((err: unknown) => {
        console.error(`[mcp] request failed: ${toMessage(err)}`)
        if (!res.headersSent) reply(res, 500)
      })
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
