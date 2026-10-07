import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { Client, Server, utils } from 'ssh2'

// End-to-end: a real ssh2 server and client, with noxed's hostVerifier deciding.
// Proves ssh2 waits on the async verifier and that a rejection surfaces as the
// message describeSshError rewrites.

const { answers, handlers, webContents, fakeHome } = vi.hoisted(() => {
  const answers: string[] = []
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const { EventEmitter } = require('node:events') as typeof import('node:events')
  const webContents = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    send: (channel: string, payload: { requestId: string }) => {
      if (channel !== 'hostkeys:prompt') return
      const decision = answers.shift() ?? 'reject'
      queueMicrotask(() => handlers.get('hostkeys:respond')!({ sender: { id: 1 } }, payload.requestId, decision))
    },
  })
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { answers, handlers, webContents, fakeHome: mkdtempSync(join(tmpdir(), 'noxed-hostkeys-')) }
})

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { getFocusedWindow: () => ({ isDestroyed: () => false, webContents }), getAllWindows: () => [] },
}))
vi.mock('electron-store', () => ({
  default: class MockStore {
    private data = new Map<string, unknown>([['hosts', []]])
    get(key: string) { return this.data.get(key) }
    set(key: string, value: unknown) { this.data.set(key, value) }
  },
}))
vi.mock('../keychain', () => ({ isUnlocked: () => true }))
// Keep the real ~/.ssh/known_hosts out of the test.
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => fakeHome }))

import { describeSshError, listTrustedHostKeys, registerHostKeyHandlers, verifiedHandshake } from '../hostKeys'

function startServer(hostKey: string): Promise<{ server: Server; port: number }> {
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => client.end())
    client.on('error', () => { /* client may hang up mid-handshake on rejection */ })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
}

function connect(port: number): Promise<'ready' | string> {
  return new Promise((resolve) => {
    const client = new Client()
    client.on('ready', () => { client.end(); resolve('ready') })
    client.on('error', (err) => resolve(describeSshError(err)))
    client.connect({ host: '127.0.0.1', port, username: 'u', password: 'p', ...verifiedHandshake(client, '127.0.0.1', port) })
  })
}

let first: { server: Server; port: number }

// Real handshakes and key generation can be slow while the rest of the suite
// runs in parallel; the defaults (5s per test, 10s per hook) aren't enough.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

beforeAll(async () => {
  registerHostKeyHandlers()
  first = await startServer(utils.generateKeyPairSync('ed25519').private)
})

afterAll(() => {
  first.server.close()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('host key verification over a real SSH handshake', () => {
  it('refuses the connection when the user rejects an unknown key', async () => {
    answers.push('reject')
    expect(await connect(first.port)).toBe('Host key not trusted — connection cancelled')
  })

  it('connects after the user trusts the key, then reconnects without asking', async () => {
    answers.push('trust')
    expect(await connect(first.port)).toBe('ready')
    expect(listTrustedHostKeys()).toHaveLength(1)
    expect(await connect(first.port)).toBe('ready')
    expect(answers).toHaveLength(0)
  })

  it('catches a different server answering on a trusted host:port', async () => {
    first.server.close()
    const impostor = await new Promise<Server>((resolve) => {
      const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
        c.on('authentication', (ctx) => ctx.accept())
        c.on('ready', () => c.end())
        c.on('error', () => { /* rejected mid-handshake */ })
      })
      s.listen(first.port, '127.0.0.1', () => resolve(s))
    })
    answers.push('reject')
    expect(await connect(first.port)).toBe('Host key not trusted — connection cancelled')
    impostor.close()
  })
})
