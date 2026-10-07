import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<[string, unknown]> = []
const { EventEmitter } = await import('node:events')
const webContents = Object.assign(new EventEmitter(), {
  id: 7,
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => sent.push([channel, payload]),
})
let windows: Array<{ isDestroyed: () => boolean; webContents: typeof webContents }> = []

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn)) },
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => windows,
  },
}))
vi.mock('electron-store', () => ({
  default: class MockStore {
    private data = new Map<string, unknown>()
    constructor(opts: { defaults: Record<string, unknown> }) {
      for (const [k, v] of Object.entries(opts.defaults)) this.data.set(k, v)
    }
    get(key: string) { return this.data.get(key) }
    set(key: string, value: unknown) { this.data.set(key, value) }
  },
}))

let knownHostsFile: string | null = null
// Bumped on every content change so the parsed-file cache sees a new mtime.
let knownHostsMtime = 0
const fsReads = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs', () => ({
  statSync: () => {
    if (knownHostsFile === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    if (knownHostsFile === 'EACCES') throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return { size: knownHostsFile.length, mtimeMs: knownHostsMtime }
  },
  readFileSync: () => {
    fsReads.count++
    return knownHostsFile
  },
}))
const unlocked = vi.hoisted(() => ({ value: true }))
vi.mock('../keychain', () => ({ isUnlocked: () => unlocked.value }))

function setKnownHosts(text: string | null) {
  knownHostsFile = text
  knownHostsMtime++
}

import {
  describeSshError,
  listTrustedHostKeys,
  registerHostKeyHandlers,
  SSH_HANDSHAKE_TIMEOUT_MS,
  verifiedHandshake,
  verifyHostKey,
} from '../hostKeys'

const KEY1 = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIGFtBD3Qpg30EbIqvedapYSsPYyF8uIgYKIwZKmBIhFx', 'base64')
const KEY2 = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIAAxGjdH2btAlq+4X7kpGWgjZzF+HUL/VxyavS01jbO6', 'base64')
const sender = { sender: { id: 7 } }

function lastPrompt(): { requestId: string; status: string; knownFingerprints: string[]; otherKeyTypes: string[] } {
  const prompts = sent.filter(([ch]) => ch === 'hostkeys:prompt')
  return prompts[prompts.length - 1][1] as never
}

async function respond(decision: string, event: unknown = sender) {
  await Promise.resolve()
  return handlers.get('hostkeys:respond')!(event, lastPrompt().requestId, decision)
}

function clearTrusted() {
  for (const h of listTrustedHostKeys()) {
    handlers.get('hostkeys:remove')!(sender, h.host, h.port, h.keyType)
  }
}

registerHostKeyHandlers()

beforeEach(() => {
  sent.length = 0
  windows = [{ isDestroyed: () => false, webContents }]
  unlocked.value = true
  setKnownHosts(null)
  clearTrusted()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('verifyHostKey', () => {
  it('prompts for an unknown host and saves the key when trusted', async () => {
    const result = verifyHostKey('example.com', 22, KEY1)
    await respond('trust')
    expect(await result).toBe(true)
    expect(lastPrompt().status).toBe('new')
    expect(listTrustedHostKeys()).toEqual([
      expect.objectContaining({ host: 'example.com', port: 22, keyType: 'ssh-ed25519', fingerprint: expect.stringMatching(/^SHA256:/) }),
    ])
    // A second connection is silent.
    sent.length = 0
    expect(await verifyHostKey('example.com', 22, KEY1)).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it('connects once without remembering the key', async () => {
    const result = verifyHostKey('example.com', 22, KEY1)
    await respond('once')
    expect(await result).toBe(true)
    expect(listTrustedHostKeys()).toEqual([])
  })

  it('rejects when the user cancels', async () => {
    const result = verifyHostKey('example.com', 22, KEY1)
    await respond('reject')
    expect(await result).toBe(false)
  })

  it('warns about a changed key and replaces it only when told to', async () => {
    const first = verifyHostKey('example.com', 22, KEY1)
    await respond('trust')
    await first

    const changed = verifyHostKey('example.com', 22, KEY2)
    await respond('trust')
    expect(await changed).toBe(true)
    const prompt = lastPrompt()
    expect(prompt.status).toBe('changed')
    expect(prompt.knownFingerprints).toEqual(['SHA256:xKnb9PezoHKXZuSpMMT7c+br+DazQE/4vX0zxhNqoJ4'])
    expect(listTrustedHostKeys()).toHaveLength(1)
    expect(listTrustedHostKeys()[0].key).toBe(KEY2.toString('base64'))
  })

  it('trusts keys already in ~/.ssh/known_hosts without prompting', async () => {
    setKnownHosts(`example.com ssh-ed25519 ${KEY1.toString('base64')}\n`)
    expect(await verifyHostKey('example.com', 22, KEY1)).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it('reports a known_hosts mismatch as a changed key, with the old fingerprint', async () => {
    setKnownHosts(`example.com ssh-ed25519 ${KEY1.toString('base64')}\n`)
    const result = verifyHostKey('example.com', 22, KEY2)
    await respond('reject')
    expect(await result).toBe(false)
    expect(lastPrompt().status).toBe('changed')
    expect(lastPrompt().knownFingerprints).toEqual(['SHA256:xKnb9PezoHKXZuSpMMT7c+br+DazQE/4vX0zxhNqoJ4'])
  })

  it('refuses a key revoked in known_hosts even if noxed trusted it', async () => {
    const first = verifyHostKey('example.com', 22, KEY1)
    await respond('trust')
    await first
    setKnownHosts(`@revoked * ssh-ed25519 ${KEY1.toString('base64')}\n`)
    const result = verifyHostKey('example.com', 22, KEY1)
    // Even a "trust" answer can't override revocation.
    await respond('trust')
    expect(await result).toBe(false)
    expect(lastPrompt().status).toBe('revoked')
  })

  it('mentions other trusted key types for a new key type', async () => {
    const first = verifyHostKey('example.com', 22, KEY1)
    await respond('trust')
    await first
    const rsaBlob = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from('ssh-rsa'), Buffer.from([1, 2, 3])])
    const result = verifyHostKey('example.com', 22, rsaBlob)
    await respond('reject')
    await result
    expect(lastPrompt()).toEqual(expect.objectContaining({ status: 'new', otherKeyTypes: ['ssh-ed25519'] }))
  })

  it('shares one prompt between concurrent connections to the same host', async () => {
    const a = verifyHostKey('example.com', 22, KEY1)
    const b = verifyHostKey('example.com', 22, KEY1)
    await respond('once')
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(sent.filter(([ch]) => ch === 'hostkeys:prompt')).toHaveLength(1)
  })

  it('does not let a replaced key stay valid through known_hosts', async () => {
    // OpenSSH knows KEY1; the user replaces it with KEY2 in noxed.
    setKnownHosts(`example.com ssh-ed25519 ${KEY1.toString('base64')}\n`)
    const replace = verifyHostKey('example.com', 22, KEY2)
    await respond('trust')
    expect(await replace).toBe(true)
    // The old key must now be treated as changed, not silently accepted.
    const old = verifyHostKey('example.com', 22, KEY1)
    await respond('reject')
    expect(await old).toBe(false)
    expect(lastPrompt().status).toBe('changed')
  })

  it('rejects when the asked window is closed', async () => {
    const result = verifyHostKey('example.com', 22, KEY1)
    await Promise.resolve()
    webContents.emit('destroyed')
    expect(await result).toBe(false)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })

  it('shows prompts one at a time, each with its own full timeout', async () => {
    vi.useFakeTimers()
    const first = verifyHostKey('a.example.com', 22, KEY1)
    const second = verifyHostKey('b.example.com', 22, KEY2)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.filter(([ch]) => ch === 'hostkeys:prompt')).toHaveLength(1)
    // The first prompt times out; only then does the second appear, fresh.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await first).toBe(false)
    expect(sent.filter(([ch]) => ch === 'hostkeys:prompt')).toHaveLength(2)
    expect((lastPrompt() as unknown as { host: string }).host).toBe('b.example.com')
    await vi.advanceTimersByTimeAsync(119_000)
    await respond('once')
    expect(await second).toBe(true)
  })

  it('skips a queued prompt whose connections all went away', async () => {
    const first = verifyHostKey('a.example.com', 22, KEY1)
    await Promise.resolve()
    const client = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    client.on('error', () => {})
    const verify = vi.fn()
    ;(verifiedHandshake(client as never, 'b.example.com', 22).hostVerifier as (k: Buffer, v: (ok: boolean) => void) => void)(KEY2, verify)
    await Promise.resolve()
    client.emit('close')
    await respond('reject')
    await first
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(false))
    expect(sent.filter(([ch]) => ch === 'hostkeys:prompt')).toHaveLength(1)
  })

  it('judges a second key for the same host after the first is decided', async () => {
    const first = verifyHostKey('example.com', 22, KEY1)
    const second = verifyHostKey('example.com', 22, KEY2)
    await vi.waitFor(() => expect(sent.filter(([ch]) => ch === 'hostkeys:prompt')).toHaveLength(1))
    expect(lastPrompt().status).toBe('new')
    await respond('trust')
    expect(await first).toBe(true)
    // KEY1 is now trusted, so KEY2 must be presented as a changed key.
    await vi.waitFor(() => expect(sent.filter(([ch]) => ch === 'hostkeys:prompt')).toHaveLength(2))
    expect(lastPrompt().status).toBe('changed')
    await respond('reject')
    expect(await second).toBe(false)
  })

  it('keeps a connection waiting its turn from timing out', async () => {
    vi.useFakeTimers()
    const first = verifyHostKey('example.com', 22, KEY1)
    await vi.advanceTimersByTimeAsync(0)
    const client = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const errors: Error[] = []
    client.on('error', (e: Error) => errors.push(e))
    const verify = vi.fn()
    ;(verifiedHandshake(client as never, 'example.com', 22).hostVerifier as (k: Buffer, v: (ok: boolean) => void) => void)(KEY2, verify)
    await vi.advanceTimersByTimeAsync(SSH_HANDSHAKE_TIMEOUT_MS * 2)
    expect(errors).toHaveLength(0)
    await respond('reject')
    await first
    await vi.advanceTimersByTimeAsync(0)
    await respond('reject')
    await vi.advanceTimersByTimeAsync(0)
    expect(verify).toHaveBeenCalledWith(false)
  })

  it('rejects without stalling the queue when the renderer cannot be reached', async () => {
    const realSend = webContents.send
    webContents.send = () => { throw new Error('Render frame was disposed') }
    expect(await verifyHostKey('a.example.com', 22, KEY1)).toBe(false)
    webContents.send = realSend
    // The next prompt still appears.
    const next = verifyHostKey('b.example.com', 22, KEY2)
    await vi.waitFor(() => expect(sent.filter(([ch]) => ch === 'hostkeys:prompt')).toHaveLength(1))
    await respond('reject')
    expect(await next).toBe(false)
  })

  it('revives a queued check when a new connection joins after the others left', async () => {
    const first = verifyHostKey('a.example.com', 22, KEY1)
    await Promise.resolve()
    const gone = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    gone.on('error', () => {})
    const verifyGone = vi.fn()
    ;(verifiedHandshake(gone as never, 'b.example.com', 22).hostVerifier as (k: Buffer, v: (ok: boolean) => void) => void)(KEY2, verifyGone)
    await Promise.resolve()
    gone.emit('close')
    const fresh = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    fresh.on('error', () => {})
    const verifyFresh = vi.fn()
    ;(verifiedHandshake(fresh as never, 'b.example.com', 22).hostVerifier as (k: Buffer, v: (ok: boolean) => void) => void)(KEY2, verifyFresh)
    await respond('reject')
    await first
    // b's prompt is shown for the fresh connection rather than skipped.
    await vi.waitFor(() => expect(sent.filter(([ch]) => ch === 'hostkeys:prompt')).toHaveLength(2))
    await respond('once')
    await vi.waitFor(() => expect(verifyFresh).toHaveBeenCalledWith(true))
  })

  it('rejects immediately when there is no window to ask', async () => {
    windows = []
    expect(await verifyHostKey('example.com', 22, KEY1)).toBe(false)
  })

  it('rejects and dismisses the prompt when nobody answers', async () => {
    vi.useFakeTimers()
    const result = verifyHostKey('example.com', 22, KEY1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await result).toBe(false)
    expect(sent.some(([ch]) => ch === 'hostkeys:dismiss')).toBe(true)
  })

  it('treats a missing known_hosts file as no opinion, silently', async () => {
    const result = verifyHostKey('example.com', 22, KEY1)
    await respond('reject')
    await result
    expect(console.error).not.toHaveBeenCalled()
  })

  it('logs an unreadable known_hosts file and still prompts', async () => {
    setKnownHosts('EACCES')
    const result = verifyHostKey('example.com', 22, KEY1)
    await respond('reject')
    await result
    expect(lastPrompt().status).toBe('new')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not read'))
  })

  it('parses known_hosts once per file version', async () => {
    setKnownHosts(`example.com ssh-ed25519 ${KEY1.toString('base64')}\n`)
    fsReads.count = 0
    expect(await verifyHostKey('example.com', 22, KEY1)).toBe(true)
    expect(await verifyHostKey('example.com', 22, KEY1)).toBe(true)
    expect(fsReads.count).toBe(1)
    setKnownHosts(`example.com ssh-ed25519 ${KEY2.toString('base64')}\n`)
    expect(await verifyHostKey('example.com', 22, KEY2)).toBe(true)
    expect(fsReads.count).toBe(2)
  })

  it('narrows the parsed file separately for each host', async () => {
    setKnownHosts(`example.com ssh-ed25519 ${KEY1.toString('base64')}\n[example.com]:2222 ssh-ed25519 ${KEY2.toString('base64')}\n`)
    expect(await verifyHostKey('example.com', 22, KEY1)).toBe(true)
    expect(await verifyHostKey('example.com', 2222, KEY2)).toBe(true)
    expect(await verifyHostKey('Example.COM', 22, KEY1)).toBe(true)
  })

  it('ignores an oversized known_hosts file', async () => {
    setKnownHosts(`example.com ssh-ed25519 ${KEY1.toString('base64')}\n`.padEnd(5 * 1024 * 1024))
    const result = verifyHostKey('example.com', 22, KEY1)
    await respond('reject')
    expect(await result).toBe(false)
  })
})

describe('hostkeys:respond', () => {
  it('refuses to trust while the app is locked, keeping the prompt open', async () => {
    const result = verifyHostKey('example.com', 22, KEY1)
    await Promise.resolve()
    unlocked.value = false
    const respondHandler = handlers.get('hostkeys:respond')!
    expect(() => respondHandler(sender, lastPrompt().requestId, 'trust')).toThrow('Unlock noxed to trust a host key')
    // Rejecting needs no unlock.
    respondHandler(sender, lastPrompt().requestId, 'reject')
    expect(await result).toBe(false)
    expect(listTrustedHostKeys()).toEqual([])
  })

  it('ignores answers from a window that was not asked', async () => {
    const result = verifyHostKey('example.com', 22, KEY1)
    await respond('trust', { sender: { id: 99 } })
    await respond('reject')
    expect(await result).toBe(false)
  })

  it('validates the request id and decision', () => {
    const respondHandler = handlers.get('hostkeys:respond')!
    expect(() => respondHandler(sender, 42, 'trust')).toThrow('Invalid host key response')
    expect(() => respondHandler(sender, 'x'.repeat(10_000), 'trust')).toThrow('Invalid host key response')
    expect(() => respondHandler(sender, '00000000-0000-4000-8000-000000000000', 'maybe')).toThrow('Invalid host key response')
    expect(respondHandler(sender, '00000000-0000-4000-8000-000000000000', 'trust')).toBeUndefined()
  })
})

describe('hostkeys:remove', () => {
  it('validates host, port and key type', () => {
    const remove = handlers.get('hostkeys:remove')!
    expect(() => remove(sender, '', 22, 'ssh-ed25519')).toThrow()
    expect(() => remove(sender, 'h', 0, 'ssh-ed25519')).toThrow()
    expect(() => remove(sender, 'h', 22, 'bad type!')).toThrow('Invalid key type')
  })

  it('lists and removes trusted keys', async () => {
    const result = verifyHostKey('example.com', 22, KEY1)
    await respond('trust')
    await result
    expect(handlers.get('hostkeys:list')!(sender)).toHaveLength(1)
    handlers.get('hostkeys:remove')!(sender, 'EXAMPLE.com', 22, 'ssh-ed25519')
    expect(listTrustedHostKeys()).toEqual([])
  })
})

describe('verifiedHandshake', () => {
  function fakeClient() {
    return Object.assign(new EventEmitter(), { destroy: vi.fn() })
  }

  it('disables ssh2 readyTimeout and feeds the verdict to verify', async () => {
    setKnownHosts(`example.com ssh-ed25519 ${KEY1.toString('base64')}\n`)
    const client = fakeClient()
    const opts = verifiedHandshake(client as never, 'example.com', 22)
    expect(opts.readyTimeout).toBe(0)
    const verify = vi.fn()
    ;(opts.hostVerifier as (k: Buffer, v: (ok: boolean) => void) => void)(KEY1, verify)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(true))
    client.emit('ready')
  })

  it('times out a stalled handshake', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    const errors: Error[] = []
    client.on('error', (e: Error) => errors.push(e))
    verifiedHandshake(client as never, 'example.com', 22)
    await vi.advanceTimersByTimeAsync(SSH_HANDSHAKE_TIMEOUT_MS)
    expect(errors[0].message).toBe('Timed out while waiting for handshake')
    expect(client.destroy).toHaveBeenCalled()
  })

  it('pauses the handshake timeout while the user reads a prompt', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    const errors: Error[] = []
    client.on('error', (e: Error) => errors.push(e))
    const opts = verifiedHandshake(client as never, 'example.com', 22)
    const verify = vi.fn()
    ;(opts.hostVerifier as (k: Buffer, v: (ok: boolean) => void) => void)(KEY1, verify)
    await vi.advanceTimersByTimeAsync(SSH_HANDSHAKE_TIMEOUT_MS * 3)
    expect(errors).toHaveLength(0)

    await respond('once')
    await vi.advanceTimersByTimeAsync(0)
    expect(verify).toHaveBeenCalledWith(true)
    // Answered: the handshake clock runs again.
    await vi.advanceTimersByTimeAsync(SSH_HANDSHAKE_TIMEOUT_MS)
    expect(errors).toHaveLength(1)
  })

  it('pauses a second connection that joins an open prompt', async () => {
    vi.useFakeTimers()
    const first = verifyHostKey('example.com', 22, KEY1)
    await Promise.resolve()
    const client = fakeClient()
    const errors: Error[] = []
    client.on('error', (e: Error) => errors.push(e))
    const opts = verifiedHandshake(client as never, 'example.com', 22)
    ;(opts.hostVerifier as (k: Buffer, v: (ok: boolean) => void) => void)(KEY1, vi.fn())
    await vi.advanceTimersByTimeAsync(SSH_HANDSHAKE_TIMEOUT_MS * 2)
    expect(errors).toHaveLength(0)
    await respond('reject')
    expect(await first).toBe(false)
  })

  it('withdraws the prompt once every waiting connection has gone away', async () => {
    const a = fakeClient()
    const b = fakeClient()
    a.on('error', () => {})
    b.on('error', () => {})
    const verifyA = vi.fn()
    const verifyB = vi.fn()
    ;(verifiedHandshake(a as never, 'example.com', 22).hostVerifier as (k: Buffer, v: (ok: boolean) => void) => void)(KEY1, verifyA)
    await Promise.resolve()
    ;(verifiedHandshake(b as never, 'example.com', 22).hostVerifier as (k: Buffer, v: (ok: boolean) => void) => void)(KEY1, verifyB)
    const requestId = lastPrompt().requestId

    // One of two connections dropping keeps the prompt for the other.
    a.emit('close')
    await Promise.resolve()
    expect(sent.some(([ch]) => ch === 'hostkeys:dismiss')).toBe(false)

    b.emit('error', new Error('reset'))
    await vi.waitFor(() => expect(verifyB).toHaveBeenCalledWith(false))
    expect(sent).toContainEqual(['hostkeys:dismiss', requestId])
    // A late answer can no longer trust the key.
    expect(handlers.get('hostkeys:respond')!(sender, requestId, 'trust')).toBeUndefined()
    expect(listTrustedHostKeys()).toEqual([])
  })

  it('stops timing once the connection is ready', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    const errors: Error[] = []
    client.on('error', (e: Error) => errors.push(e))
    verifiedHandshake(client as never, 'example.com', 22)
    client.emit('ready')
    await vi.advanceTimersByTimeAsync(SSH_HANDSHAKE_TIMEOUT_MS * 2)
    expect(errors).toHaveLength(0)
  })
})

describe('describeSshError', () => {
  it('turns ssh2 host-key rejection into a clear message', () => {
    expect(describeSshError(new Error('Host denied (verification failed)'))).toBe('Host key not trusted — connection cancelled')
    expect(describeSshError(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED')
  })
})
