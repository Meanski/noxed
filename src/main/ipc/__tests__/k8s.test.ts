import { describe, it, expect, vi, beforeEach, afterAll, type Mock } from 'vitest'
import * as net from 'node:net'
import type { PassThrough } from 'node:stream'

const h = vi.hoisted(() => ({
  api: {
    listNamespacedEvent: vi.fn(),
  },
  portForward: vi.fn(async () => undefined),
  execFn: vi.fn(),
  logFn: vi.fn(),
}))

vi.mock('@kubernetes/client-node', () => {
  class KubeConfig {
    loadFromDefault = vi.fn()
    loadFromFile = vi.fn()
    getContexts() { return [{ name: 'ctx', cluster: 'c' }] }
    getClusters() { return [{ name: 'c', server: 'https://cluster.example.test' }] }
    setCurrentContext = vi.fn()
    getCurrentContext() { return 'ctx' }
    makeApiClient() { return h.api }
  }
  class PortForward { portForward = h.portForward }
  class Exec { exec = h.execFn }
  class Log { log = h.logFn }
  class CoreV1Api {}
  class AppsV1Api {}
  class NetworkingV1Api {}
  class BatchV1Api {}
  return { KubeConfig, PortForward, Exec, Log, CoreV1Api, AppsV1Api, NetworkingV1Api, BatchV1Api }
})
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/noxed-test-userdata') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))
vi.mock('../keychain', () => ({
  isUnlocked: vi.fn(() => true),
}))

import { ipcMain } from 'electron'
import { registerK8sHandlers, disposeK8sSessionsForSender } from '../k8s'
import { OwnershipError, ConnectionError } from '../errors'

registerK8sHandlers()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => any

function handler(channel: string): Handler {
  const call = (ipcMain.handle as Mock).mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No invoke handler registered for ${channel}`)
  return call[1] as Handler
}

function onHandler(channel: string): Handler {
  const call = (ipcMain.on as Mock).mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No on handler registered for ${channel}`)
  return call[1] as Handler
}

interface FakeEvent {
  sender: { id: number; isDestroyed: () => boolean; send: Mock }
}

const usedSenderIds: number[] = []
let senderSeq = 900
function makeEvent(): FakeEvent {
  const id = senderSeq++
  usedSenderIds.push(id)
  return { sender: { id, isDestroyed: () => false, send: vi.fn() } }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterAll(() => {
  for (const id of usedSenderIds) disposeK8sSessionsForSender(id)
})

describe('k8s contexts', () => {
  it('lists context names and servers from the default kubeconfig', () => {
    expect(handler('k8s:contexts')({})).toEqual(['ctx'])
    expect(handler('k8s:contextsDetailed')({})).toEqual([
      { name: 'ctx', server: 'https://cluster.example.test' },
    ])
  })
})

describe('k8s:events', () => {
  it('sorts newest-first by lastTimestamp and maps fields with defaults', async () => {
    h.api.listNamespacedEvent.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: 'older', namespace: 'default' },
            lastTimestamp: '2026-01-01T00:00:00Z',
            type: 'Warning',
            reason: 'BackOff',
            message: 'restarting',
            involvedObject: { kind: 'Pod', name: 'api-1' },
            count: 4,
          },
          {
            metadata: { name: 'newest', namespace: 'default' },
            lastTimestamp: '2026-06-01T00:00:00Z',
            involvedObject: { kind: 'Pod', name: 'api-2' },
          },
          {
            metadata: { name: 'undated', namespace: 'default', creationTimestamp: '2025-12-01T00:00:00Z' },
            involvedObject: { kind: 'Node', name: 'n1' },
          },
        ],
      },
    })
    const rows = (await handler('k8s:events')({}, 'ctx', 'default')) as Array<Record<string, unknown>>
    expect(rows.map((r) => r.name)).toEqual(['newest', 'older', 'undated'])
    expect(rows[0]).toMatchObject({ type: 'Normal', reason: '', message: '', count: 1, object: 'Pod/api-2' })
    expect(rows[1]).toMatchObject({ type: 'Warning', reason: 'BackOff', count: 4 })
    expect(rows[2].age).toBe('2025-12-01T00:00:00Z')
  })

  it('rejects an unknown context', async () => {
    await expect(handler('k8s:events')({}, 'nope', 'default')).rejects.toThrow('Unknown kube context')
  })
})

describe('k8s:portForwardStart', () => {
  const start = (event: FakeEvent, localPort?: unknown) =>
    handler('k8s:portForwardStart')(event, 'ctx', 'default', 'pod-1', 8080, localPort) as Promise<{ id: string; localPort: number }>

  it('rejects an invalid explicit local port', async () => {
    await expect(start(makeEvent(), 99_999)).rejects.toThrow('Invalid local port')
    await expect(start(makeEvent(), 'eighty')).rejects.toThrow('Invalid local port')
  })

  it('listens on an ephemeral port and records the session', async () => {
    const event = makeEvent()
    const { id, localPort } = await start(event)
    expect(id).toMatch(/^k8s_/)
    expect(localPort).toBeGreaterThan(0)

    const listed = handler('k8s:portForwardList')(event) as Array<Record<string, unknown>>
    expect(listed).toEqual([
      { id, context: 'ctx', namespace: 'default', podName: 'pod-1', targetPort: 8080, localPort },
    ])
    // Another sender sees nothing.
    expect(handler('k8s:portForwardList')(makeEvent())).toEqual([])

    handler('k8s:portForwardStop')(event, id)
    expect(handler('k8s:portForwardList')(event)).toEqual([])
  })

  it('forwards incoming sockets through the k8s PortForward API and destroys them on failure', async () => {
    const event = makeEvent()
    h.portForward.mockRejectedValueOnce(new Error('pod gone'))
    const { id, localPort } = await start(event)

    const socket = net.connect(localPort, '127.0.0.1')
    socket.on('error', () => {}) // server side destroys the socket; ignore ECONNRESET
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
    await vi.waitFor(() => expect(h.portForward).toHaveBeenCalled())
    expect(h.portForward).toHaveBeenCalledWith('default', 'pod-1', [8080], expect.anything(), null, expect.anything())
    await closed

    handler('k8s:portForwardStop')(event, id)
  })

  it('rejects with ConnectionError when the local port is already taken', async () => {
    const event = makeEvent()
    const first = await start(event)
    await expect(start(event, first.localPort)).rejects.toBeInstanceOf(ConnectionError)
    handler('k8s:portForwardStop')(event, first.id)
  })

  it('enforces ownership on stop and tolerates bogus ids', async () => {
    const event = makeEvent()
    const { id } = await start(event)
    expect(() => handler('k8s:portForwardStop')(makeEvent(), id)).toThrow(OwnershipError)
    expect(handler('k8s:portForwardStop')(event, 42)).toBeUndefined()
    expect(handler('k8s:portForwardStop')(event, 'k8s_missing')).toBeUndefined()
    handler('k8s:portForwardStop')(event, id)
  })
})

describe('k8s exec sessions', () => {
  interface CapturedExec {
    stdout: PassThrough
    stdin: PassThrough
    statusCb: (status: unknown) => void
    ws: { close: Mock; send: Mock }
  }

  async function startExec(event: FakeEvent = makeEvent(), ws?: Partial<CapturedExec['ws']>) {
    const captured = {} as CapturedExec
    captured.ws = { close: vi.fn(), send: vi.fn(), ...ws } as CapturedExec['ws']
    h.execFn.mockImplementationOnce(async (
      _ns: string, _pod: string, _container: string, _cmd: string[],
      stdout: PassThrough, _stderr: PassThrough, stdin: PassThrough,
      _tty: boolean, statusCb: (status: unknown) => void,
    ) => {
      captured.stdout = stdout
      captured.stdin = stdin
      captured.statusCb = statusCb
      return captured.ws
    })
    const sessionId = (await handler('k8s:execStart')(event, 'ctx', 'default', 'pod-1', 'main')) as string
    return { sessionId, captured, event }
  }

  it('starts a shell and streams stdout to the renderer', async () => {
    const { sessionId, captured, event } = await startExec()
    expect(sessionId).toMatch(/^k8s_/)
    captured.stdout.write('shell output')
    await flush()
    expect(event.sender.send).toHaveBeenCalledWith('k8s:execData', sessionId, 'shell output')
    handler('k8s:execStop')(event, sessionId)
  })

  it('k8s:execSend writes to stdin only for the owning sender and sane payloads', async () => {
    const { sessionId, captured, event } = await startExec()
    const received: string[] = []
    captured.stdin.on('data', (c: Buffer) => received.push(c.toString()))
    const send = onHandler('k8s:execSend')

    send(event, sessionId, 'ls -la\n')
    await flush()
    expect(received.join('')).toBe('ls -la\n')

    send(makeEvent(), sessionId, 'whoami\n') // wrong sender
    send(event, sessionId, 42) // non-string payload
    send(event, 42, 'x') // non-string session id
    send(event, 'k8s_missing', 'x') // unknown session
    send(event, sessionId, 'y'.repeat(65 * 1024)) // oversized
    await flush()
    expect(received.join('')).toBe('ls -la\n')

    handler('k8s:execStop')(event, sessionId)
  })

  it('k8s:execResize sends a resize control frame over the websocket', async () => {
    const { sessionId, captured, event } = await startExec()
    const resize = onHandler('k8s:execResize')

    resize(event, sessionId, 80, 24)
    expect(captured.ws.send).toHaveBeenCalledTimes(1)
    const buf = captured.ws.send.mock.calls[0][0] as Buffer
    expect([...buf]).toEqual([4, 0, 24, 0, 80])

    resize(makeEvent(), sessionId, 80, 24) // wrong sender
    resize(event, sessionId, 0, 24) // out of range
    resize(event, sessionId, 80.5, 24) // non-integer
    resize(event, 42, 80, 24) // bad id
    expect(captured.ws.send).toHaveBeenCalledTimes(1)

    captured.ws.send.mockImplementation(() => { throw new Error('socket closed') })
    expect(() => resize(event, sessionId, 100, 40)).not.toThrow()

    handler('k8s:execStop')(event, sessionId)
  })

  it('ignores resize when the websocket has no send method', async () => {
    const { sessionId, event } = await startExec(makeEvent(), { send: undefined })
    expect(() => onHandler('k8s:execResize')(event, sessionId, 80, 24)).not.toThrow()
    handler('k8s:execStop')(event, sessionId)
  })

  it('notifies the renderer and clears the session when the shell exits', async () => {
    const { sessionId, captured, event } = await startExec()
    captured.statusCb({ status: 'Success' })
    expect(event.sender.send).toHaveBeenCalledWith('k8s:execClose', sessionId, { status: 'Success' })
    // Session is gone: send becomes a no-op and stop finds nothing.
    const received: string[] = []
    captured.stdin.on('data', (c: Buffer) => received.push(c.toString()))
    onHandler('k8s:execSend')(event, sessionId, 'late\n')
    await flush()
    expect(received).toEqual([])
    expect(handler('k8s:execStop')(event, sessionId)).toBeUndefined()
  })

  it('enforces ownership on execStop and closes the websocket on dispose', async () => {
    const { sessionId, captured, event } = await startExec()
    expect(() => handler('k8s:execStop')(makeEvent(), sessionId)).toThrow(OwnershipError)
    handler('k8s:execStop')(event, sessionId)
    expect(captured.ws.close).toHaveBeenCalled()
  })

  it('disposeK8sSessionsForSender tears down exec sessions', async () => {
    const { sessionId, captured, event } = await startExec()
    disposeK8sSessionsForSender(event.sender.id)
    expect(captured.ws.close).toHaveBeenCalled()
    expect(handler('k8s:execStop')(event, sessionId)).toBeUndefined()
  })
})
