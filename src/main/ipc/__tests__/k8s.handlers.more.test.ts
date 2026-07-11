import { describe, it, expect, vi, beforeEach, afterEach, afterAll, type Mock } from 'vitest'
import type { PassThrough } from 'node:stream'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? process.env.TMP ?? '/tmp').replace(/\/+$/, '')
  const FAKE_HOME = `${tmp}/noxed-k8s-more-test-home`
  return {
    FAKE_HOME,
    loads: [] as string[],
    loadFromFileError: null as Error | null,
    contexts: [
      { name: 'ctx', cluster: 'c' },
      { name: 'orphan', cluster: 'missing-cluster' },
    ],
    clusters: [{ name: 'c', server: 'https://cluster.example.test' }],
    api: {
      listNamespace: vi.fn(),
      listNamespacedPod: vi.fn(),
      deleteNamespacedPod: vi.fn(),
      listNamespacedDeployment: vi.fn(),
      patchNamespacedDeployment: vi.fn(),
      listNamespacedStatefulSet: vi.fn(),
      listNamespacedDaemonSet: vi.fn(),
      listNamespacedReplicaSet: vi.fn(),
      listNamespacedJob: vi.fn(),
      listNamespacedCronJob: vi.fn(),
      listNamespacedService: vi.fn(),
      listNamespacedIngress: vi.fn(),
      listNamespacedConfigMap: vi.fn(),
      listNamespacedSecret: vi.fn(),
      readNamespacedSecret: vi.fn(),
      listNode: vi.fn(),
      listNamespacedEvent: vi.fn(),
      readNamespacedPod: vi.fn(),
      readNamespacedDeployment: vi.fn(),
      readNamespacedStatefulSet: vi.fn(),
      readNamespacedDaemonSet: vi.fn(),
      readNamespacedReplicaSet: vi.fn(),
      readNamespacedService: vi.fn(),
      readNamespacedIngress: vi.fn(),
      readNamespacedConfigMap: vi.fn(),
      readNamespacedJob: vi.fn(),
      readNamespacedCronJob: vi.fn(),
      readNode: vi.fn(),
      readNamespacedEndpoints: vi.fn(),
    },
    portForward: vi.fn(async () => undefined),
    execFn: vi.fn(),
    logFn: vi.fn(),
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => h.FAKE_HOME }
})

vi.mock('@kubernetes/client-node', () => {
  class KubeConfig {
    loadFromDefault() { h.loads.push('<default>') }
    loadFromFile(p: string) {
      h.loads.push(p)
      if (h.loadFromFileError) throw h.loadFromFileError
    }
    getContexts() { return h.contexts }
    getClusters() { return h.clusters }
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
  app: { getPath: vi.fn(() => join(h.FAKE_HOME, 'userdata')) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))

vi.mock('../keychain', () => ({
  isUnlocked: vi.fn(() => true),
}))

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { isUnlocked } from '../keychain'
import { registerK8sHandlers, disposeK8sSessionsForSender } from '../k8s'
import { OwnershipError, ConnectionError, NotFoundError } from '../errors'

// Fixture layout inside the fake home directory (homedir() is mocked above, so
// the security module's allowed-dir list points here too).
const KUBE_DIR = join(h.FAKE_HOME, '.kube')
const DOWNLOADS = join(h.FAKE_HOME, 'Downloads')
const MANAGED_DIR = join(h.FAKE_HOME, 'userdata', 'kubeconfigs')
const ALLOWED_CFG = join(KUBE_DIR, 'config')
const DOWNLOADED_CFG = join(DOWNLOADS, 'cluster-export.yaml')
const BIG_CFG = join(DOWNLOADS, 'huge.yaml')

mkdirSync(KUBE_DIR, { recursive: true })
mkdirSync(DOWNLOADS, { recursive: true })
writeFileSync(ALLOWED_CFG, 'apiVersion: v1\nkind: Config\n')
writeFileSync(DOWNLOADED_CFG, 'apiVersion: v1\nkind: Config\n')
writeFileSync(BIG_CFG, Buffer.alloc(1024 * 1024 + 1))

registerK8sHandlers()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => any

function handler(channel: string): Handler {
  const call = (ipcMain.handle as Mock).mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No invoke handler registered for ${channel}`)
  return call[1] as Handler
}

interface FakeEvent {
  sender: { id: number; isDestroyed: () => boolean; send: Mock }
}

const usedSenderIds: number[] = []
let senderSeq = 5000
function makeEvent(destroyed = false): FakeEvent {
  const id = senderSeq++
  usedSenderIds.push(id)
  return { sender: { id, isDestroyed: () => destroyed, send: vi.fn() } }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleErrorSpy.mockRestore()
  h.loadFromFileError = null
})

afterAll(() => {
  for (const id of usedSenderIds) disposeK8sSessionsForSender(id)
})

describe('k8s:contextsDetailed', () => {
  it('maps a context with an unknown cluster to an empty server', () => {
    expect(handler('k8s:contextsDetailed')({})).toEqual([
      { name: 'ctx', server: 'https://cluster.example.test' },
      { name: 'orphan', server: '' },
    ])
  })
})

describe('k8s:importKubeconfig', () => {
  const importCfg = (path: unknown) => handler('k8s:importKubeconfig')({}, path)

  it('rejects malformed raw paths', () => {
    expect(() => importCfg(42)).toThrow('Invalid kubeconfig path')
    expect(() => importCfg('   ')).toThrow('Invalid kubeconfig path')
    expect(() => importCfg('/home/x/\0config')).toThrow('Invalid kubeconfig path')
    expect(() => importCfg(`/${'a'.repeat(5000)}`)).toThrow('Invalid kubeconfig path')
  })

  it('rejects paths outside the home directory', () => {
    expect(() => importCfg('/etc/hosts')).toThrow('Kubeconfig must be inside your home directory')
  })

  it('rejects missing files, directories, and oversized files', () => {
    expect(() => importCfg(join(h.FAKE_HOME, 'does-not-exist.yaml'))).toThrow('File does not exist or is not accessible')
    expect(() => importCfg(h.FAKE_HOME)).toThrow('Path is not a regular file')
    expect(() => importCfg(BIG_CFG)).toThrow('Kubeconfig is too large (max 1MB)')
  })

  it('rejects files that do not parse as a kubeconfig', () => {
    h.loadFromFileError = new Error('bad yaml')
    expect(() => importCfg(DOWNLOADED_CFG)).toThrow('Not a valid kubeconfig: bad yaml')
  })

  it('rejects kubeconfigs without contexts', () => {
    const saved = h.contexts
    h.contexts = []
    try {
      expect(() => importCfg(DOWNLOADED_CFG)).toThrow('Kubeconfig contains no contexts')
    } finally {
      h.contexts = saved
    }
  })

  it('references files already inside an allowed directory in place', () => {
    expect(importCfg(ALLOWED_CFG)).toEqual({
      path: ALLOWED_CFG,
      contexts: [
        { name: 'ctx', server: 'https://cluster.example.test' },
        { name: 'orphan', server: '' },
      ],
    })
  })

  it('copies other home files into the managed folder, expanding ~', () => {
    const result = importCfg('~/Downloads/cluster-export.yaml') as { path: string }
    expect(result.path.startsWith(join(MANAGED_DIR, 'cluster-export.yaml-'))).toBe(true)
    expect(existsSync(result.path)).toBe(true)
  })
})

describe('k8s:showFilePicker', () => {
  it('throws when the event has no window', async () => {
    ;(BrowserWindow.fromWebContents as Mock).mockReturnValueOnce(null)
    await expect(handler('k8s:showFilePicker')(makeEvent())).rejects.toThrow('No active window')
  })

  it('returns null when the dialog is canceled and the path when confirmed', async () => {
    ;(BrowserWindow.fromWebContents as Mock).mockReturnValue({})
    ;(dialog.showOpenDialog as Mock).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(handler('k8s:showFilePicker')(makeEvent())).resolves.toBeNull()
    ;(dialog.showOpenDialog as Mock).mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    await expect(handler('k8s:showFilePicker')(makeEvent())).resolves.toBe('/picked')
  })
})

describe('kubeconfigPath validation and caching', () => {
  it('accepts an allowed explicit kubeconfig and caches the parsed config', async () => {
    // h.loads accumulates across tests (importKubeconfig also loads this path),
    // so assert against a baseline rather than an absolute count.
    const loadsBefore = h.loads.filter((p) => p === ALLOWED_CFG).length
    h.api.listNamespace.mockResolvedValue({ body: { items: [{ metadata: { name: 'default' } }, {}] } })
    await expect(handler('k8s:namespaces')({}, 'ctx', ALLOWED_CFG)).resolves.toEqual(['default', ''])
    await expect(handler('k8s:namespaces')({}, 'ctx', ALLOWED_CFG)).resolves.toEqual(['default', ''])
    expect(h.loads.filter((p) => p === ALLOWED_CFG)).toHaveLength(loadsBefore + 1)
  })

  it('treats empty and null kubeconfig paths as the default config', async () => {
    h.api.listNamespace.mockResolvedValue({ body: { items: [] } })
    await expect(handler('k8s:namespaces')({}, 'ctx', '')).resolves.toEqual([])
    await expect(handler('k8s:namespaces')({}, 'ctx', null)).resolves.toEqual([])
  })

  it('rejects non-string and disallowed kubeconfig paths', async () => {
    await expect(handler('k8s:namespaces')({}, 'ctx', 42)).rejects.toThrow('Invalid kubeconfig path')
    await expect(handler('k8s:namespaces')({}, 'ctx', '/etc/passwd')).rejects.toThrow('Access denied')
  })
})

describe('list handlers map API items with defaults', () => {
  it('k8s:pods', async () => {
    h.api.listNamespacedPod.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: 'api-1', namespace: 'default', creationTimestamp: 't1' },
            status: {
              phase: 'Running',
              containerStatuses: [
                { ready: true, restartCount: 2 },
                { ready: false, restartCount: 1 },
              ],
            },
            spec: { containers: [{ name: 'app' }, { name: 'sidecar' }], nodeName: 'node-1' },
          },
          {},
        ],
      },
    })
    await expect(handler('k8s:pods')({}, 'ctx', 'default')).resolves.toEqual([
      {
        name: 'api-1', namespace: 'default', status: 'Running', ready: '1/2',
        restarts: 3, age: 't1', node: 'node-1', containers: ['app', 'sidecar'],
      },
      {
        name: '', namespace: '', status: 'Unknown', ready: '0/0',
        restarts: 0, age: undefined, node: '', containers: [],
      },
    ])
  })

  it('k8s:pods rejects an invalid namespace', async () => {
    await expect(handler('k8s:pods')({}, 'ctx', 'bad ns')).rejects.toThrow('Invalid namespace')
  })

  it('k8s:deployments', async () => {
    h.api.listNamespacedDeployment.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: 'web', namespace: 'default', creationTimestamp: 't1' },
            spec: { replicas: 3 },
            status: { readyReplicas: 2, availableReplicas: 2 },
          },
          {},
        ],
      },
    })
    await expect(handler('k8s:deployments')({}, 'ctx', 'default')).resolves.toEqual([
      { name: 'web', namespace: 'default', ready: '2/3', available: 2, replicas: 3, age: 't1' },
      { name: '', namespace: '', ready: '0/0', available: 0, replicas: 0, age: undefined },
    ])
  })

  it('k8s:statefulsets', async () => {
    h.api.listNamespacedStatefulSet.mockResolvedValueOnce({
      body: {
        items: [
          { metadata: { name: 'db' }, spec: { replicas: 2 }, status: { readyReplicas: 1 } },
          {},
        ],
      },
    })
    await expect(handler('k8s:statefulsets')({}, 'ctx', 'default')).resolves.toEqual([
      { name: 'db', namespace: '', ready: '1/2', replicas: 2, age: undefined },
      { name: '', namespace: '', ready: '0/0', replicas: 0, age: undefined },
    ])
  })

  it('k8s:daemonsets', async () => {
    h.api.listNamespacedDaemonSet.mockResolvedValueOnce({
      body: {
        items: [
          { metadata: { name: 'logs' }, status: { desiredNumberScheduled: 3, numberReady: 2, numberAvailable: 1 } },
          {},
        ],
      },
    })
    await expect(handler('k8s:daemonsets')({}, 'ctx', 'default')).resolves.toEqual([
      { name: 'logs', namespace: '', desired: 3, ready: 2, available: 1, age: undefined },
      { name: '', namespace: '', desired: 0, ready: 0, available: 0, age: undefined },
    ])
  })

  it('k8s:replicasets filters out fully scaled-down replica sets', async () => {
    h.api.listNamespacedReplicaSet.mockResolvedValueOnce({
      body: {
        items: [
          { metadata: { name: 'live' }, spec: { replicas: 2 }, status: { readyReplicas: 2 } },
          { metadata: { name: 'draining' }, spec: { replicas: 0 }, status: { replicas: 1 } },
          { metadata: { name: 'dead' }, spec: { replicas: 0 }, status: { replicas: 0 } },
          {},
        ],
      },
    })
    const rows = (await handler('k8s:replicasets')({}, 'ctx', 'default')) as Array<{ name: string }>
    expect(rows.map((r) => r.name)).toEqual(['live', 'draining'])
    expect(rows[1]).toEqual({ name: 'draining', namespace: '', desired: 0, ready: 0, age: undefined })
  })

  it('k8s:jobs', async () => {
    h.api.listNamespacedJob.mockResolvedValueOnce({
      body: {
        items: [
          { metadata: { name: 'sync' }, spec: { completions: 5 }, status: { succeeded: 4, failed: 1, active: 2 } },
          {},
        ],
      },
    })
    await expect(handler('k8s:jobs')({}, 'ctx', 'default')).resolves.toEqual([
      { name: 'sync', namespace: '', completions: '4/5', failed: 1, active: 2, age: undefined },
      { name: '', namespace: '', completions: '0/1', failed: 0, active: 0, age: undefined },
    ])
  })

  it('k8s:cronjobs', async () => {
    h.api.listNamespacedCronJob.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: 'nightly' },
            spec: { schedule: '0 0 * * *', suspend: true },
            status: { lastScheduleTime: 't1', active: [{}, {}] },
          },
          {},
        ],
      },
    })
    await expect(handler('k8s:cronjobs')({}, 'ctx', 'default')).resolves.toEqual([
      { name: 'nightly', namespace: '', schedule: '0 0 * * *', lastSchedule: 't1', active: 2, suspended: true, age: undefined },
      { name: '', namespace: '', schedule: '', lastSchedule: null, active: 0, suspended: false, age: undefined },
    ])
  })

  it('k8s:services covers load balancer ip, hostname, and port formats', async () => {
    h.api.listNamespacedService.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: 'lb-ip' },
            spec: {
              type: 'LoadBalancer', clusterIP: '10.0.0.1',
              ports: [{ port: 80, nodePort: 30080, protocol: 'TCP' }, { port: 443, protocol: 'TCP' }],
            },
            status: { loadBalancer: { ingress: [{ ip: '1.2.3.4' }] } },
          },
          {
            metadata: { name: 'lb-host' },
            spec: { type: 'LoadBalancer' },
            status: { loadBalancer: { ingress: [{ hostname: 'lb.example.test' }] } },
          },
          {},
        ],
      },
    })
    const rows = (await handler('k8s:services')({}, 'ctx', 'default')) as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ name: 'lb-ip', externalIP: '1.2.3.4', ports: '80:30080/TCP, 443/TCP' })
    expect(rows[1]).toMatchObject({ name: 'lb-host', externalIP: 'lb.example.test', ports: '' })
    expect(rows[2]).toEqual({ name: '', namespace: '', type: '', clusterIP: '', externalIP: '', ports: '', age: undefined })
  })

  it('k8s:ingresses covers hosts, class fallbacks, and addresses', async () => {
    h.api.listNamespacedIngress.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: 'named-class' },
            spec: { rules: [{ host: 'a.example.test' }, {}], ingressClassName: 'nginx' },
            status: { loadBalancer: { ingress: [{ ip: '9.9.9.9' }] } },
          },
          {
            metadata: { name: 'annotated', annotations: undefined },
            spec: {},
            status: { loadBalancer: { ingress: [{ hostname: 'edge.example.test' }] } },
          },
          {
            metadata: { name: 'legacy', annotations: { 'kubernetes.io/ingress.class': 'traefik' } },
          },
        ],
      },
    })
    const rows = (await handler('k8s:ingresses')({}, 'ctx', 'default')) as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ hosts: 'a.example.test, *', address: '9.9.9.9', ingressClass: 'nginx' })
    expect(rows[1]).toMatchObject({ hosts: '', address: 'edge.example.test', ingressClass: '' })
    expect(rows[2]).toMatchObject({ hosts: '', address: '', ingressClass: 'traefik', ports: '80, 443' })
  })

  it('k8s:configmaps and k8s:secrets count keys', async () => {
    h.api.listNamespacedConfigMap.mockResolvedValueOnce({
      body: { items: [{ metadata: { name: 'cm' }, data: { a: '1', b: '2' } }, {}] },
    })
    await expect(handler('k8s:configmaps')({}, 'ctx', 'default')).resolves.toEqual([
      { name: 'cm', namespace: '', keys: 2, age: undefined },
      { name: '', namespace: '', keys: 0, age: undefined },
    ])

    h.api.listNamespacedSecret.mockResolvedValueOnce({
      body: { items: [{ metadata: { name: 's1' }, type: 'Opaque', data: { token: 'eA==' } }, {}] },
    })
    await expect(handler('k8s:secrets')({}, 'ctx', 'default')).resolves.toEqual([
      { name: 's1', namespace: '', type: 'Opaque', keys: 1, age: undefined },
      { name: '', namespace: '', type: '', keys: 0, age: undefined },
    ])
  })

  it('k8s:nodes derives readiness and roles', async () => {
    h.api.listNode.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: {
              name: 'cp-1',
              labels: { 'node-role.kubernetes.io/control-plane': '', 'kubernetes.io/os': 'linux' },
            },
            status: {
              conditions: [{ type: 'Ready', status: 'True' }],
              capacity: { cpu: '8', memory: '32Gi' },
              nodeInfo: { osImage: 'Ubuntu', kubeletVersion: 'v1.30.0' },
            },
          },
          {},
        ],
      },
    })
    await expect(handler('k8s:nodes')({}, 'ctx')).resolves.toEqual([
      {
        name: 'cp-1', status: 'Ready', roles: 'control-plane', cpu: '8', memory: '32Gi',
        osImage: 'Ubuntu', kubeletVersion: 'v1.30.0', age: undefined,
      },
      {
        name: '', status: 'NotReady', roles: 'worker', cpu: '', memory: '',
        osImage: '', kubeletVersion: '', age: undefined,
      },
    ])
  })
})

describe('pod and deployment mutations', () => {
  it('k8s:deletePod deletes the validated pod', async () => {
    h.api.deleteNamespacedPod.mockResolvedValueOnce({})
    await handler('k8s:deletePod')({}, 'ctx', 'default', 'api-1')
    expect(h.api.deleteNamespacedPod).toHaveBeenCalledWith('api-1', 'default')
  })

  it('k8s:scaleDeployment validates the replica count', async () => {
    for (const bad of [-1, 1.5, 10_001, '3']) {
      await expect(handler('k8s:scaleDeployment')({}, 'ctx', 'default', 'web', bad)).rejects.toThrow('Invalid replica count')
    }
    expect(h.api.patchNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('k8s:scaleDeployment sends a merge patch with the new replica count', async () => {
    h.api.patchNamespacedDeployment.mockResolvedValueOnce({})
    await handler('k8s:scaleDeployment')({}, 'ctx', 'default', 'web', 3)
    expect(h.api.patchNamespacedDeployment).toHaveBeenCalledWith(
      'web', 'default', { spec: { replicas: 3 } },
      undefined, undefined, undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    )
  })

  it('k8s:restartDeployment patches the restartedAt annotation', async () => {
    h.api.patchNamespacedDeployment.mockResolvedValueOnce({})
    await handler('k8s:restartDeployment')({}, 'ctx', 'default', 'web')
    const patch = h.api.patchNamespacedDeployment.mock.calls.at(-1)?.[2] as {
      spec: { template: { metadata: { annotations: Record<string, string> } } }
    }
    expect(patch.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('k8s:secretDetail', () => {
  it('requires the app to be unlocked', async () => {
    ;(isUnlocked as Mock).mockReturnValueOnce(false)
    await expect(handler('k8s:secretDetail')({}, 'ctx', 'default', 's1')).rejects.toThrow('App must be unlocked to view secret values')
  })

  it('decodes base64 secret data', async () => {
    h.api.readNamespacedSecret.mockResolvedValueOnce({
      body: { data: { user: Buffer.from('admin').toString('base64'), pass: Buffer.from('hunter2').toString('base64') } },
    })
    await expect(handler('k8s:secretDetail')({}, 'ctx', 'default', 's1')).resolves.toEqual({ user: 'admin', pass: 'hunter2' })
  })

  it('returns an empty object for secrets without data', async () => {
    h.api.readNamespacedSecret.mockResolvedValueOnce({ body: {} })
    await expect(handler('k8s:secretDetail')({}, 'ctx', 'default', 's1')).resolves.toEqual({})
  })
})

describe('k8s:resourceDetail', () => {
  const detail = (kind: unknown, name = 'thing', namespace: unknown = 'default') =>
    handler('k8s:resourceDetail')({}, 'ctx', namespace, kind, name)

  it('rejects unknown or non-string kinds', async () => {
    await expect(detail('namespace')).rejects.toThrow('Unknown resource kind: namespace')
    await expect(detail(42)).rejects.toThrow('Unknown resource kind: 42')
  })

  it.each([
    ['pod', 'readNamespacedPod'],
    ['deployment', 'readNamespacedDeployment'],
    ['statefulset', 'readNamespacedStatefulSet'],
    ['daemonset', 'readNamespacedDaemonSet'],
    ['replicaset', 'readNamespacedReplicaSet'],
    ['service', 'readNamespacedService'],
    ['ingress', 'readNamespacedIngress'],
    ['configmap', 'readNamespacedConfigMap'],
    ['job', 'readNamespacedJob'],
    ['cronjob', 'readNamespacedCronJob'],
  ] as const)('returns pretty JSON for %s', async (kind, apiMethod) => {
    h.api[apiMethod].mockResolvedValueOnce({ body: { kind, metadata: { name: 'thing' } } })
    const json = (await detail(kind)) as string
    expect(JSON.parse(json)).toEqual({ kind, metadata: { name: 'thing' } })
    expect(h.api[apiMethod]).toHaveBeenCalledWith('thing', 'default')
  })

  it('reads nodes cluster-wide without validating the namespace', async () => {
    h.api.readNode.mockResolvedValueOnce({ body: { kind: 'Node' } })
    await expect(detail('node', 'cp-1', undefined)).resolves.toBe(JSON.stringify({ kind: 'Node' }, null, 2))
    expect(h.api.readNode).toHaveBeenCalledWith('cp-1')
  })

  it('redacts secret values but keeps the keys', async () => {
    h.api.readNamespacedSecret.mockResolvedValueOnce({ body: { data: { user: 'YWRtaW4=', pass: 'aHVudGVyMg==' } } })
    expect(JSON.parse((await detail('secret')) as string)).toEqual({ data: { user: '<redacted>', pass: '<redacted>' } })

    h.api.readNamespacedSecret.mockResolvedValueOnce({ body: { type: 'Opaque' } })
    expect(JSON.parse((await detail('secret')) as string)).toEqual({ type: 'Opaque' })
  })
})

describe('k8s:logsGet', () => {
  const logsGet = (tailLines: unknown = 100) =>
    handler('k8s:logsGet')({}, 'ctx', 'default', 'pod-1', 'main', tailLines)

  it('collects the stream into a single string and clamps tail lines', async () => {
    h.logFn.mockImplementationOnce(async (
      _ns: string, _pod: string, _c: string, stream: PassThrough, cb: (err: unknown) => void,
    ) => {
      stream.write('line one\n')
      stream.write('line two\n')
      cb(null)
      return {}
    })
    await expect(logsGet(100)).resolves.toBe('line one\nline two\n')
    expect(h.logFn.mock.calls.at(-1)?.[5]).toEqual({ follow: false, tailLines: 100 })

    h.logFn.mockImplementationOnce(async (
      _ns: string, _pod: string, _c: string, _stream: PassThrough, cb: (err: unknown) => void,
    ) => { cb(null); return {} })
    await expect(logsGet('not-a-number')).resolves.toBe('')
    expect(h.logFn.mock.calls.at(-1)?.[5]).toEqual({ follow: false, tailLines: 500 })
  })

  it('rejects with ConnectionError when the stream reports an error', async () => {
    h.logFn.mockImplementationOnce(async (
      _ns: string, _pod: string, _c: string, _s: PassThrough, cb: (err: unknown) => void,
    ) => { cb(new Error('container not found')); return {} })
    const rejection = logsGet().catch((err: unknown) => err)
    await expect(rejection).resolves.toBeInstanceOf(ConnectionError)
    await expect(rejection).resolves.toMatchObject({ message: expect.stringContaining('container not found') })
  })

  it('rejects with ConnectionError when the log request itself fails', async () => {
    h.logFn.mockRejectedValueOnce(new Error('api unreachable'))
    await expect(logsGet()).rejects.toThrow(ConnectionError)
  })

  it('rejects an unknown context', async () => {
    await expect(handler('k8s:logsGet')({}, 'nope', 'default', 'pod-1', 'main', 100)).rejects.toThrow('Unknown kube context: nope')
  })
})

describe('k8s:logsStream and k8s:logsStop', () => {
  interface CapturedLog {
    stream: PassThrough
    cb: (err: unknown) => void
    req: { abort: Mock }
  }

  async function startStream(event: FakeEvent = makeEvent(), req: unknown = { abort: vi.fn() }) {
    const captured = {} as CapturedLog
    captured.req = req as CapturedLog['req']
    h.logFn.mockImplementationOnce(async (
      _ns: string, _pod: string, _c: string, stream: PassThrough, cb: (err: unknown) => void,
    ) => {
      captured.stream = stream
      captured.cb = cb
      return req
    })
    const sessionId = (await handler('k8s:logsStream')(event, 'ctx', 'default', 'pod-1', 'main', 50)) as string
    return { sessionId, captured, event }
  }

  it('streams chunks to the renderer and reports the end of the stream', async () => {
    const { sessionId, captured, event } = await startStream()
    expect(sessionId).toMatch(/^k8s_/)
    expect(h.logFn.mock.calls.at(-1)?.[5]).toEqual({ follow: true, tailLines: 50 })

    captured.stream.write('log chunk')
    await flush()
    expect(event.sender.send).toHaveBeenCalledWith('k8s:logChunk', sessionId, 'log chunk')

    captured.cb(null)
    expect(event.sender.send).toHaveBeenCalledWith('k8s:logEnd', sessionId, null)
    // The session is gone: stop becomes a no-op and abort is never called.
    expect(handler('k8s:logsStop')(event, sessionId)).toBeUndefined()
    expect(captured.req.abort).not.toHaveBeenCalled()
  })

  it('sends the error message when the stream ends with a failure', async () => {
    const { sessionId, captured, event } = await startStream()
    captured.cb(new Error('pod deleted'))
    expect(event.sender.send).toHaveBeenCalledWith('k8s:logEnd', sessionId, 'pod deleted')
  })

  it('drops chunks and end notifications for destroyed senders', async () => {
    const event = makeEvent(true)
    const { sessionId, captured } = await startStream(event)
    captured.stream.write('chunk')
    await flush()
    captured.cb(null)
    expect(event.sender.send).not.toHaveBeenCalled()
    handler('k8s:logsStop')(event, sessionId)
  })

  it('logsStop enforces ownership, tolerates bogus ids, and aborts the request', async () => {
    const { sessionId, captured, event } = await startStream()
    expect(handler('k8s:logsStop')(event, 42)).toBeUndefined()
    expect(handler('k8s:logsStop')(event, 'k8s_missing')).toBeUndefined()
    expect(() => handler('k8s:logsStop')(makeEvent(), sessionId)).toThrow(OwnershipError)
    handler('k8s:logsStop')(event, sessionId)
    expect(captured.req.abort).toHaveBeenCalledTimes(1)
  })

  it('disposeK8sSessionsForSender swallows abort failures and handles missing requests', async () => {
    const throwing = await startStream(makeEvent(), { abort: () => { throw new Error('already aborted') } })
    const reqless = await startStream(makeEvent(), undefined)
    expect(() => disposeK8sSessionsForSender(throwing.event.sender.id)).not.toThrow()
    expect(() => disposeK8sSessionsForSender(reqless.event.sender.id)).not.toThrow()
    expect(handler('k8s:logsStop')(throwing.event, throwing.sessionId)).toBeUndefined()
    expect(handler('k8s:logsStop')(reqless.event, reqless.sessionId)).toBeUndefined()
  })
})

describe('k8s exec error paths', () => {
  it('execStart rejects an unknown context', async () => {
    await expect(handler('k8s:execStart')(makeEvent(), 'nope', 'default', 'pod-1', 'main')).rejects.toThrow('Unknown kube context: nope')
  })

  it('execStop swallows websocket close failures', async () => {
    h.execFn.mockImplementationOnce(async () => ({ close: () => { throw new Error('socket already closed') } }))
    const event = makeEvent()
    const sessionId = (await handler('k8s:execStart')(event, 'ctx', 'default', 'pod-1', 'main')) as string
    expect(() => handler('k8s:execStop')(event, sessionId)).not.toThrow()
    expect(handler('k8s:execStop')(event, sessionId)).toBeUndefined()
  })
})

describe('k8s:portForwardStart with an explicit local port', () => {
  it('binds the requested port when it is free', async () => {
    const event = makeEvent()
    const probe = (await handler('k8s:portForwardStart')(event, 'ctx', 'default', 'pod-1', 8080, 0)) as { id: string; localPort: number }
    handler('k8s:portForwardStop')(event, probe.id)

    const explicit = (await handler('k8s:portForwardStart')(event, 'ctx', 'default', 'pod-1', 8080, probe.localPort)) as { id: string; localPort: number }
    expect(explicit.localPort).toBe(probe.localPort)
    handler('k8s:portForwardStop')(event, explicit.id)
  })
})

describe('k8s:servicePortForwardStart', () => {
  const start = (event: FakeEvent, servicePort = 8080) =>
    handler('k8s:servicePortForwardStart')(event, 'ctx', 'default', 'svc-a', servicePort, 0) as Promise<{ id: string; localPort: number }>

  it('throws NotFoundError when the service exposes no ports', async () => {
    h.api.readNamespacedService.mockResolvedValueOnce({ body: { spec: { ports: [] } } })
    const rejection = start(makeEvent()).catch((err: unknown) => err)
    await expect(rejection).resolves.toBeInstanceOf(NotFoundError)
    await expect(rejection).resolves.toMatchObject({ message: expect.stringContaining('Port 8080 on service svc-a not found') })
    expect(h.api.readNamespacedEndpoints).not.toHaveBeenCalled()
  })

  it('forwards to the pod backing a single-port endpoint subset', async () => {
    h.api.readNamespacedService.mockResolvedValueOnce({
      body: { spec: { ports: [{ name: 'http', port: 8080 }] } },
    })
    h.api.readNamespacedEndpoints.mockResolvedValueOnce({
      body: {
        subsets: [{
          ports: [{ port: 9090 }],
          addresses: [{ targetRef: { kind: 'Pod', name: 'backend-1' } }],
        }],
      },
    })
    const event = makeEvent()
    const { id, localPort } = await start(event)
    expect(localPort).toBeGreaterThan(0)
    expect(handler('k8s:portForwardList')(event)).toEqual([
      { id, context: 'ctx', namespace: 'default', podName: 'backend-1', targetPort: 9090, localPort, service: 'svc-a' },
    ])
    handler('k8s:portForwardStop')(event, id)
  })

  it('matches multi-port subsets by name and falls back to the first service port', async () => {
    // Requested port 9999 does not exist, so the first service port spec wins.
    h.api.readNamespacedService.mockResolvedValueOnce({
      body: { spec: { ports: [{ name: 'http', port: 8080 }, { name: 'metrics', port: 9100 }] } },
    })
    h.api.readNamespacedEndpoints.mockResolvedValueOnce({
      body: {
        subsets: [{
          ports: [{ name: 'metrics', port: 9101 }, { name: 'http', port: 8081 }],
          addresses: [{ targetRef: { kind: 'Pod', name: 'backend-2' } }],
        }],
      },
    })
    const event = makeEvent()
    const { id } = await start(event, 9999)
    const listed = handler('k8s:portForwardList')(event) as Array<Record<string, unknown>>
    expect(listed[0]).toMatchObject({ podName: 'backend-2', targetPort: 8081, service: 'svc-a' })
    handler('k8s:portForwardStop')(event, id)
  })

  it('throws NotFoundError when no subset yields a ready pod', async () => {
    h.api.readNamespacedService.mockResolvedValue({
      body: { spec: { ports: [{ name: 'http', port: 8080 }] } },
    })
    h.api.readNamespacedEndpoints
      .mockResolvedValueOnce({ body: {} })
      .mockResolvedValueOnce({
        body: {
          subsets: [
            { ports: [{ port: 9090 }], addresses: [{ targetRef: { kind: 'Node', name: 'not-a-pod' } }] },
            { ports: [{ name: 'grpc', port: 5000 }, { name: 'other', port: 5001 }], addresses: [{ targetRef: { kind: 'Pod', name: 'backend-3' } }] },
          ],
        },
      })
    await expect(start(makeEvent())).rejects.toThrow('Ready endpoint for service svc-a not found')
    await expect(start(makeEvent())).rejects.toThrow('Ready endpoint for service svc-a not found')
    h.api.readNamespacedService.mockReset()
  })
})

describe('k8s:events with defaults', () => {
  it('maps events when kind and name are missing', async () => {
    h.api.listNamespacedEvent.mockResolvedValueOnce({ body: { items: [{}] } })
    const rows = (await handler('k8s:events')({}, 'ctx', 'default')) as Array<Record<string, unknown>>
    expect(rows[0]).toEqual({
      name: '', namespace: '', type: 'Normal', reason: '', message: '',
      object: 'undefined/undefined', count: 1, age: undefined,
    })
  })
})
