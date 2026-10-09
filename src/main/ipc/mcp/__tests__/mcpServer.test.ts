import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { request } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { handleMcpMessage, startMcpServer, type McpTool } from '../mcpServer'

const echo: McpTool = {
  name: 'echo',
  title: 'Echo',
  description: 'Echoes',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
  run: async (args) => `you said ${String(args.text)}`,
}
const broken: McpTool = { ...echo, name: 'broken', run: async () => { throw new Error('The user declined this request in noxed.') } }
const tools = [echo, broken]
const rpc = (method: string, params?: Record<string, unknown>, id = 1) => ({ jsonrpc: '2.0', id, method, params })
const notification = (method: string) => ({ jsonrpc: '2.0', method })

describe('handleMcpMessage', () => {
  it('negotiates the protocol version and announces tools', async () => {
    const res = await handleMcpMessage(rpc('initialize', { protocolVersion: '2025-06-18' }), tools)
    expect(res).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'noxed' } } })
    const unknown = await handleMcpMessage(rpc('initialize', { protocolVersion: '1999-01-01' }), tools)
    expect((unknown as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-11-25')
  })

  it('answers ping and lists tools without their implementations', async () => {
    expect(await handleMcpMessage(rpc('ping'), tools)).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    const list = (await handleMcpMessage(rpc('tools/list'), tools)) as { result: { tools: Array<Record<string, unknown>> } }
    expect(list.result.tools.map((t) => t.name)).toEqual(['echo', 'broken'])
    expect(list.result.tools[0]).not.toHaveProperty('run')
  })

  it('calls tools, reporting failures as tool errors the model can read', async () => {
    expect(await handleMcpMessage(rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }), tools))
      .toMatchObject({ result: { content: [{ type: 'text', text: 'you said hi' }], isError: false } })
    expect(await handleMcpMessage(rpc('tools/call', { name: 'broken' }), tools))
      .toMatchObject({ result: { content: [{ text: 'The user declined this request in noxed.' }], isError: true } })
    expect(await handleMcpMessage(rpc('tools/call', { name: 'nope' }), tools)).toMatchObject({ error: { code: -32602 } })
  })

  it('ignores notifications and rejects nonsense', async () => {
    expect(await handleMcpMessage(notification('notifications/initialized'), tools)).toBeNull()
    expect(await handleMcpMessage(rpc('resources/list'), tools)).toMatchObject({ error: { code: -32601 } })
    expect(await handleMcpMessage({ hello: 'world' }, tools)).toMatchObject({ error: { code: -32600 } })
  })
})

describe('startMcpServer over HTTP', () => {
  let server: HttpServer | undefined
  afterEach(() => server?.close())

  async function freePort(): Promise<number> {
    const probe: Server = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const { port } = probe.address() as { port: number }
    await new Promise((r) => probe.close(r))
    return port
  }

  async function setup() {
    const port = await freePort()
    server = await startMcpServer(port, 'secret-token', tools)
    const post = (body: unknown, headers: Record<string, string> = {}, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        ...init,
      })
    return { port, post }
  }

  it('serves JSON-RPC to an authorised local client', async () => {
    const { post } = await setup()
    const res = await post(rpc('tools/call', { name: 'echo', arguments: { text: 'x' } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: { content: [{ text: 'you said x' }] } })
    const batch = await post([rpc('ping', undefined, 1), notification('notifications/initialized'), rpc('ping', undefined, 2)])
    expect((await batch.json()).map((r: { id: number }) => r.id)).toEqual([1, 2])
    expect((await post(notification('notifications/initialized'))).status).toBe(202)
  })

  it('refuses missing or wrong tokens, foreign origins and other hosts', async () => {
    const { post, port } = await setup()
    expect((await post(rpc('ping'), { Authorization: 'Bearer wrong-token!' })).status).toBe(401)
    expect((await post(rpc('ping'), { Authorization: '' })).status).toBe(401)
    expect((await post(rpc('ping'), { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(rpc('ping'), { Origin: `http://localhost:${port}` })).status).toBe(200)
    // fetch won't send a forged Host header, so speak HTTP directly.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { Host: `attacker.example:${port}`, Authorization: 'Bearer secret-token' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end(JSON.stringify(rpc('ping')))
    })
    expect(status).toBe(403)
  })

  it('offers only POST /mcp and bounds the request', async () => {
    const { post, port } = await setup()
    const auth = { Authorization: 'Bearer secret-token' }
    expect((await fetch(`http://127.0.0.1:${port}/mcp`, { headers: auth })).status).toBe(405)
    expect((await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(404)
    expect((await post('{not json')).status).toBe(400)
    expect((await post('x'.repeat(1024 * 1024 + 1))).status).toBe(413)
  })

  it('fails to start on a port that is taken', async () => {
    const { port } = await setup()
    await expect(startMcpServer(port, 't', tools)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})
