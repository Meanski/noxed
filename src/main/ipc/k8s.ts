import { app, ipcMain, dialog, BrowserWindow, IpcMainInvokeEvent, IpcMainEvent } from 'electron'
import * as k8s from '@kubernetes/client-node'
import * as net from 'node:net'
import { PassThrough } from 'node:stream'
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { join, basename, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { isUnlocked } from './keychain'
import { isAllowedKubeconfigPath, registerAllowedKubeconfigDir, validateK8sName, validatePort } from './security'
import { ConnectionError, NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'

// ── Config helpers ────────────────────────────────────────────────────────────

interface CachedConfig {
  kc: k8s.KubeConfig
  loadedAt: number
}

const KUBE_CONFIG_TTL_MS = 30_000
const MAX_KUBECONFIG_IMPORT_BYTES = 1024 * 1024
const configCache = new Map<string, CachedConfig>()

function managedKubeconfigDir(): string {
  return join(app.getPath('userData'), 'kubeconfigs')
}

function cacheKey(kubeconfigPath?: string): string {
  return kubeconfigPath ?? '<default>'
}

function loadKubeConfig(kubeconfigPath?: string): k8s.KubeConfig {
  const key = cacheKey(kubeconfigPath)
  const cached = configCache.get(key)
  if (cached && Date.now() - cached.loadedAt < KUBE_CONFIG_TTL_MS) return cached.kc

  const kc = new k8s.KubeConfig()
  if (kubeconfigPath) {
    const check = isAllowedKubeconfigPath(kubeconfigPath)
    if (!check.ok) throw new ValidationError(check.reason)
    kc.loadFromFile(check.resolved)
  } else {
    kc.loadFromDefault()
  }
  configCache.set(key, { kc, loadedAt: Date.now() })
  return kc
}

function makeClient(rawContext: unknown, kubeconfigPath?: string) {
  const context = validateK8sName(rawContext, 'context')
  const kc = loadKubeConfig(kubeconfigPath)
  if (!kc.getContexts().some((c) => c.name === context)) {
    throw new ValidationError(`Unknown kube context: ${context}`)
  }
  kc.setCurrentContext(context)
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    kc,
  }
}

function validateOptionalKubeconfig(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ValidationError('Invalid kubeconfig path')
  const check = isAllowedKubeconfigPath(value)
  if (!check.ok) throw new ValidationError(check.reason)
  return check.resolved
}

function validateNamespace(value: unknown): string {
  return validateK8sName(value, 'namespace', 63)
}

function validateResourceName(value: unknown): string {
  return validateK8sName(value, 'resource name', 253)
}

function contextsWithServer(kc: k8s.KubeConfig): { name: string; server: string }[] {
  const clusters = kc.getClusters()
  return kc.getContexts().map(ctx => {
    const cluster = clusters.find(c => c.name === ctx.cluster)
    return { name: ctx.name, server: cluster?.server ?? '' }
  })
}

// ── Active session maps ───────────────────────────────────────────────────────

interface OwnedSession { senderId: number }
interface LogSession extends OwnedSession { req: { abort?: () => void } | undefined }
interface ExecSession extends OwnedSession {
  stdin: PassThrough
  ws: { close?: () => void; send?: (data: Buffer) => void } | undefined
}
interface PfMeta {
  context: string
  namespace: string
  podName: string
  targetPort: number
  localPort: number
  service?: string
}
interface PfSession extends OwnedSession { server: net.Server; sockets: Set<net.Socket>; meta: PfMeta }

const logSessions = new Map<string, LogSession>()
const execSessions = new Map<string, ExecSession>()
const pfSessions = new Map<string, PfSession>()

function makeId(): string { return `k8s_${randomUUID()}` }

function safeLog(message: string, err: unknown): void {
  console.error(`[k8s] ${message}: ${toMessage(err)}`)
}

function disposeLogSession(id: string): void {
  const s = logSessions.get(id)
  if (!s) return
  logSessions.delete(id)
  try {
    s.req?.abort?.()
  } catch (err) {
    safeLog(`abort log stream ${id}`, err)
  }
}

function disposeExecSession(id: string): void {
  const s = execSessions.get(id)
  if (!s) return
  execSessions.delete(id)
  try { s.ws?.close?.() } catch (err) { safeLog(`close exec ws ${id}`, err) }
  try { s.stdin.end() } catch (err) { safeLog(`end exec stdin ${id}`, err) }
}

function disposePfSession(id: string): void {
  const s = pfSessions.get(id)
  if (!s) return
  pfSessions.delete(id)
  for (const sock of s.sockets) {
    try { sock.destroy() } catch (err) { safeLog(`destroy pf socket ${id}`, err) }
  }
  s.sockets.clear()
  try { s.server.close() } catch (err) { safeLog(`close pf server ${id}`, err) }
}

export function disposeK8sSessionsForSender(senderId: number): void {
  for (const [id, s] of logSessions) if (s.senderId === senderId) disposeLogSession(id)
  for (const [id, s] of execSessions) if (s.senderId === senderId) disposeExecSession(id)
  for (const [id, s] of pfSessions) if (s.senderId === senderId) disposePfSession(id)
}

// ── Handler registration ──────────────────────────────────────────────────────

function startPodForward(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  targetPort: number,
  localPort: unknown,
  senderId: number,
  meta: Omit<PfMeta, 'localPort'>,
): Promise<{ id: string; localPort: number }> {
  if (localPort !== undefined && localPort !== null && localPort !== 0) {
    validatePort(localPort, 'local port')
  }
  const sessionId = makeId()
  const forward = new k8s.PortForward(kc)
  const sockets = new Set<net.Socket>()

  return new Promise<{ id: string; localPort: number }>((resolve, reject) => {
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', (err) => safeLog(`pf socket ${sessionId}`, err))
      forward.portForward(namespace, podName, [targetPort], socket, null, socket)
        .catch((err) => {
          safeLog(`pf forward ${sessionId}`, err)
          socket.destroy()
        })
    })

    server.on('error', (err) => reject(new ConnectionError(toMessage(err))))
    server.listen(localPort && Number(localPort) > 0 ? Number(localPort) : 0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      pfSessions.set(sessionId, { server, sockets, senderId, meta: { ...meta, localPort: addr.port } })
      resolve({ id: sessionId, localPort: addr.port })
    })
  })
}

export function registerK8sHandlers(): void {
  registerAllowedKubeconfigDir(managedKubeconfigDir())

  ipcMain.handle('k8s:contexts', () => loadKubeConfig().getContexts().map(c => c.name))

  ipcMain.handle('k8s:contextsDetailed', () => contextsWithServer(loadKubeConfig()))

  // Imports a kubeconfig from anywhere in the user's home: validates that it
  // really parses as a kubeconfig, then copy it into the app's managed folder
  // so the saved connection keeps working when the original moves (Downloads).
  ipcMain.handle('k8s:importKubeconfig', (_e, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0') || rawPath.length > 4096) {
      throw new ValidationError('Invalid kubeconfig path')
    }
    const src = resolvePath(rawPath.replace(/^~/, homedir()))
    const home = homedir()
    if (src !== home && !src.startsWith(`${home}/`)) {
      throw new ValidationError('Kubeconfig must be inside your home directory')
    }

    let size: number
    try {
      const stat = statSync(src)
      if (!stat.isFile()) throw new ValidationError('Path is not a regular file')
      size = stat.size
    } catch (err) {
      if (err instanceof ValidationError) throw err
      throw new ValidationError('File does not exist or is not accessible')
    }
    if (size > MAX_KUBECONFIG_IMPORT_BYTES) {
      throw new ValidationError(`Kubeconfig is too large (max ${MAX_KUBECONFIG_IMPORT_BYTES / 1024 / 1024}MB)`)
    }

    const kc = new k8s.KubeConfig()
    try {
      kc.loadFromFile(src)
    } catch (err) {
      throw new ValidationError(`Not a valid kubeconfig: ${toMessage(err)}`)
    }
    if (kc.getContexts().length === 0) {
      throw new ValidationError('Kubeconfig contains no contexts')
    }

    // Files already inside an allowed directory are referenced in place
    const allowed = isAllowedKubeconfigPath(src)
    if (allowed.ok) {
      return { path: allowed.resolved, contexts: contextsWithServer(kc) }
    }

    const dir = managedKubeconfigDir()
    mkdirSync(dir, { recursive: true })
    const suffix = createHash('sha256').update(src).digest('hex').slice(0, 8)
    const safeName = basename(src).replace(/[^a-zA-Z0-9._-]/g, '_')
    const dest = join(dir, `${safeName}-${suffix}`)
    copyFileSync(src, dest)
    return { path: dest, contexts: contextsWithServer(kc) }
  })

  ipcMain.handle('k8s:showFilePicker', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new ValidationError('No active window')
    const result = await dialog.showOpenDialog(win, {
      title: 'Select kubeconfig file',
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ── Namespaces ──────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:namespaces', async (_e, context: unknown, kubeconfigPath?: unknown) => {
    const { core } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await core.listNamespace()
    return res.body.items.map(n => n.metadata?.name ?? '')
  })

  // ── Pods ────────────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:pods', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { core } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await core.listNamespacedPod(validateNamespace(namespace))
    return res.body.items.map(p => ({
      name: p.metadata?.name ?? '',
      namespace: p.metadata?.namespace ?? '',
      status: p.status?.phase ?? 'Unknown',
      ready: `${p.status?.containerStatuses?.filter(c => c.ready).length ?? 0}/${p.spec?.containers?.length ?? 0}`,
      restarts: p.status?.containerStatuses?.reduce((sum, c) => sum + c.restartCount, 0) ?? 0,
      age: p.metadata?.creationTimestamp,
      node: p.spec?.nodeName ?? '',
      containers: p.spec?.containers?.map(c => c.name) ?? [],
    }))
  })

  ipcMain.handle('k8s:deletePod', async (_e, context: unknown, namespace: unknown, name: unknown, kubeconfigPath?: unknown) => {
    const { core } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    await core.deleteNamespacedPod(validateResourceName(name), validateNamespace(namespace))
  })

  // ── Deployments ─────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:deployments', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { apps } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await apps.listNamespacedDeployment(validateNamespace(namespace))
    return res.body.items.map(d => ({
      name: d.metadata?.name ?? '',
      namespace: d.metadata?.namespace ?? '',
      ready: `${d.status?.readyReplicas ?? 0}/${d.spec?.replicas ?? 0}`,
      available: d.status?.availableReplicas ?? 0,
      replicas: d.spec?.replicas ?? 0,
      age: d.metadata?.creationTimestamp,
    }))
  })

  ipcMain.handle('k8s:scaleDeployment', async (_e, context: unknown, namespace: unknown, name: unknown, replicas: unknown, kubeconfigPath?: unknown) => {
    if (!Number.isInteger(replicas) || (replicas as number) < 0 || (replicas as number) > 10_000) {
      throw new ValidationError('Invalid replica count')
    }
    const { apps } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    await apps.patchNamespacedDeployment(validateResourceName(name), validateNamespace(namespace),
      { spec: { replicas: replicas as number } },
      undefined, undefined, undefined, undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    )
  })

  ipcMain.handle('k8s:restartDeployment', async (_e, context: unknown, namespace: unknown, name: unknown, kubeconfigPath?: unknown) => {
    const { apps } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() }
          }
        }
      }
    }
    await apps.patchNamespacedDeployment(validateResourceName(name), validateNamespace(namespace), patch,
      undefined, undefined, undefined, undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    )
  })

  // ── StatefulSets ────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:statefulsets', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { apps } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await apps.listNamespacedStatefulSet(validateNamespace(namespace))
    return res.body.items.map(s => ({
      name: s.metadata?.name ?? '',
      namespace: s.metadata?.namespace ?? '',
      ready: `${s.status?.readyReplicas ?? 0}/${s.spec?.replicas ?? 0}`,
      replicas: s.spec?.replicas ?? 0,
      age: s.metadata?.creationTimestamp,
    }))
  })

  // ── DaemonSets ──────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:daemonsets', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { apps } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await apps.listNamespacedDaemonSet(validateNamespace(namespace))
    return res.body.items.map(d => ({
      name: d.metadata?.name ?? '',
      namespace: d.metadata?.namespace ?? '',
      desired: d.status?.desiredNumberScheduled ?? 0,
      ready: d.status?.numberReady ?? 0,
      available: d.status?.numberAvailable ?? 0,
      age: d.metadata?.creationTimestamp,
    }))
  })

  // ── ReplicaSets ─────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:replicasets', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { apps } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await apps.listNamespacedReplicaSet(validateNamespace(namespace))
    return res.body.items
      .filter(r => (r.spec?.replicas ?? 0) > 0 || (r.status?.replicas ?? 0) > 0)
      .map(r => ({
        name: r.metadata?.name ?? '',
        namespace: r.metadata?.namespace ?? '',
        desired: r.spec?.replicas ?? 0,
        ready: r.status?.readyReplicas ?? 0,
        age: r.metadata?.creationTimestamp,
      }))
  })

  // ── Jobs ────────────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:jobs', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { batch } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await batch.listNamespacedJob(validateNamespace(namespace))
    return res.body.items.map(j => ({
      name: j.metadata?.name ?? '',
      namespace: j.metadata?.namespace ?? '',
      completions: `${j.status?.succeeded ?? 0}/${j.spec?.completions ?? 1}`,
      failed: j.status?.failed ?? 0,
      active: j.status?.active ?? 0,
      age: j.metadata?.creationTimestamp,
    }))
  })

  // ── CronJobs ────────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:cronjobs', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { batch } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await batch.listNamespacedCronJob(validateNamespace(namespace))
    return res.body.items.map(c => ({
      name: c.metadata?.name ?? '',
      namespace: c.metadata?.namespace ?? '',
      schedule: c.spec?.schedule ?? '',
      lastSchedule: c.status?.lastScheduleTime ?? null,
      active: c.status?.active?.length ?? 0,
      suspended: c.spec?.suspend ?? false,
      age: c.metadata?.creationTimestamp,
    }))
  })

  // ── Services ────────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:services', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { core } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await core.listNamespacedService(validateNamespace(namespace))
    return res.body.items.map(s => ({
      name: s.metadata?.name ?? '',
      namespace: s.metadata?.namespace ?? '',
      type: s.spec?.type ?? '',
      clusterIP: s.spec?.clusterIP ?? '',
      externalIP: s.status?.loadBalancer?.ingress?.[0]?.ip ?? s.status?.loadBalancer?.ingress?.[0]?.hostname ?? '',
      ports: s.spec?.ports?.map(p => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol}`).join(', ') ?? '',
      age: s.metadata?.creationTimestamp,
    }))
  })

  // ── Ingresses ───────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:ingresses', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { networking } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await networking.listNamespacedIngress(validateNamespace(namespace))
    return res.body.items.map(i => ({
      name: i.metadata?.name ?? '',
      namespace: i.metadata?.namespace ?? '',
      hosts: i.spec?.rules?.map(r => r.host ?? '*').join(', ') ?? '',
      address: i.status?.loadBalancer?.ingress?.[0]?.ip ?? i.status?.loadBalancer?.ingress?.[0]?.hostname ?? '',
      ports: '80, 443',
      ingressClass: i.spec?.ingressClassName ?? i.metadata?.annotations?.['kubernetes.io/ingress.class'] ?? '',
      age: i.metadata?.creationTimestamp,
    }))
  })

  // ── ConfigMaps ──────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:configmaps', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { core } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await core.listNamespacedConfigMap(validateNamespace(namespace))
    return res.body.items.map(cm => ({
      name: cm.metadata?.name ?? '',
      namespace: cm.metadata?.namespace ?? '',
      keys: Object.keys(cm.data ?? {}).length,
      age: cm.metadata?.creationTimestamp,
    }))
  })

  // ── Secrets ─────────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:secrets', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { core } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await core.listNamespacedSecret(validateNamespace(namespace))
    return res.body.items.map(s => ({
      name: s.metadata?.name ?? '',
      namespace: s.metadata?.namespace ?? '',
      type: s.type ?? '',
      keys: Object.keys(s.data ?? {}).length,
      age: s.metadata?.creationTimestamp,
    }))
  })

  ipcMain.handle('k8s:secretDetail', async (_e, context: unknown, namespace: unknown, name: unknown, kubeconfigPath?: unknown) => {
    if (!isUnlocked()) {
      throw new ValidationError('App must be unlocked to view secret values')
    }
    const { core } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await core.readNamespacedSecret(validateResourceName(name), validateNamespace(namespace))
    const raw = res.body.data ?? {}
    const decoded: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      decoded[k] = Buffer.from(v, 'base64').toString('utf8')
    }
    return decoded
  })

  // ── Nodes ───────────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:nodes', async (_e, context: unknown, kubeconfigPath?: unknown) => {
    const { core } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await core.listNode()
    return res.body.items.map(n => {
      const conditions = n.status?.conditions ?? []
      const ready = conditions.find(c => c.type === 'Ready')?.status === 'True'
      const roles = Object.keys(n.metadata?.labels ?? {})
        .filter(k => k.startsWith('node-role.kubernetes.io/'))
        .map(k => k.replace('node-role.kubernetes.io/', ''))
        .join(', ') || 'worker'
      return {
        name: n.metadata?.name ?? '',
        status: ready ? 'Ready' : 'NotReady',
        roles,
        cpu: n.status?.capacity?.cpu ?? '',
        memory: n.status?.capacity?.memory ?? '',
        osImage: n.status?.nodeInfo?.osImage ?? '',
        kubeletVersion: n.status?.nodeInfo?.kubeletVersion ?? '',
        age: n.metadata?.creationTimestamp,
      }
    })
  })

  // ── Events ──────────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:events', async (_e, context: unknown, namespace: unknown, kubeconfigPath?: unknown) => {
    const { core } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const res = await core.listNamespacedEvent(validateNamespace(namespace))
    return [...res.body.items]
      .sort((a, b) => {
        const ta = a.lastTimestamp ? new Date(a.lastTimestamp as unknown as string).getTime() : 0
        const tb = b.lastTimestamp ? new Date(b.lastTimestamp as unknown as string).getTime() : 0
        return tb - ta
      })
      .map(e => ({
        name: e.metadata?.name ?? '',
        namespace: e.metadata?.namespace ?? '',
        type: e.type ?? 'Normal',
        reason: e.reason ?? '',
        message: e.message ?? '',
        object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
        count: e.count ?? 1,
        age: e.lastTimestamp ?? e.metadata?.creationTimestamp,
      }))
  })

  // ── Resource detail (full JSON) ─────────────────────────────────────────────

  const ALLOWED_KINDS = new Set([
    'pod', 'deployment', 'statefulset', 'daemonset', 'replicaset',
    'service', 'ingress', 'configmap', 'secret', 'job', 'cronjob', 'node',
  ])

  ipcMain.handle('k8s:resourceDetail', async (_e, context: unknown, namespace: unknown, kind: unknown, name: unknown, kubeconfigPath?: unknown) => {
    if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind)) {
      throw new ValidationError(`Unknown resource kind: ${String(kind)}`)
    }
    const { core, apps, networking, batch } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))
    const safeName = validateResourceName(name)
    const safeNs = kind === 'node' ? '' : validateNamespace(namespace)

    const reads: Record<string, () => Promise<unknown>> = {
      pod:          () => core.readNamespacedPod(safeName, safeNs).then(r => r.body),
      deployment:   () => apps.readNamespacedDeployment(safeName, safeNs).then(r => r.body),
      statefulset:  () => apps.readNamespacedStatefulSet(safeName, safeNs).then(r => r.body),
      daemonset:    () => apps.readNamespacedDaemonSet(safeName, safeNs).then(r => r.body),
      replicaset:   () => apps.readNamespacedReplicaSet(safeName, safeNs).then(r => r.body),
      service:      () => core.readNamespacedService(safeName, safeNs).then(r => r.body),
      ingress:      () => networking.readNamespacedIngress(safeName, safeNs).then(r => r.body),
      configmap:    () => core.readNamespacedConfigMap(safeName, safeNs).then(r => r.body),
      job:          () => batch.readNamespacedJob(safeName, safeNs).then(r => r.body),
      cronjob:      () => batch.readNamespacedCronJob(safeName, safeNs).then(r => r.body),
      node:         () => core.readNode(safeName).then(r => r.body),
      secret:       async () => {
        const s = (await core.readNamespacedSecret(safeName, safeNs)).body
        if (s.data) {
          const redacted: Record<string, string> = {}
          for (const k of Object.keys(s.data)) redacted[k] = '<redacted>'
          s.data = redacted
        }
        return s
      },
    }

    const obj = await reads[kind]()
    return JSON.stringify(obj, null, 2)
  })

  // ── Pod logs ─────────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:logsGet', async (_e, context: unknown, namespace: unknown, pod: unknown, container: unknown, tailLines: unknown, kubeconfigPath?: unknown) => {
    const safePath = validateOptionalKubeconfig(kubeconfigPath)
    const safeNs = validateNamespace(namespace)
    const safePod = validateResourceName(pod)
    const safeContainer = validateResourceName(container)
    const tail = Number.isInteger(tailLines) && (tailLines as number) > 0 ? Math.min(tailLines as number, 50_000) : 500
    const kc = loadKubeConfig(safePath)
    const ctx = validateK8sName(context, 'context')
    if (!kc.getContexts().some((c) => c.name === ctx)) throw new ValidationError(`Unknown kube context: ${ctx}`)
    kc.setCurrentContext(ctx)
    const log = new k8s.Log(kc)
    return new Promise<string>((resolve, reject) => {
      const chunks: string[] = []
      const stream = new PassThrough()
      stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
      stream.on('end', () => resolve(chunks.join('')))
      log.log(safeNs, safePod, safeContainer, stream, (err) => {
        if (err) reject(new ConnectionError(toMessage(err)))
        else stream.end()
      }, { follow: false, tailLines: tail }).catch((err) => reject(new ConnectionError(toMessage(err))))
    })
  })

  ipcMain.handle('k8s:logsStream', async (event: IpcMainInvokeEvent, context: unknown, namespace: unknown, pod: unknown, container: unknown, tailLines: unknown, kubeconfigPath?: unknown) => {
    const safePath = validateOptionalKubeconfig(kubeconfigPath)
    const safeNs = validateNamespace(namespace)
    const safePod = validateResourceName(pod)
    const safeContainer = validateResourceName(container)
    const tail = Number.isInteger(tailLines) && (tailLines as number) > 0 ? Math.min(tailLines as number, 50_000) : 200
    const sessionId = makeId()
    const kc = loadKubeConfig(safePath)
    const ctx = validateK8sName(context, 'context')
    if (!kc.getContexts().some((c) => c.name === ctx)) throw new ValidationError(`Unknown kube context: ${ctx}`)
    kc.setCurrentContext(ctx)
    const log = new k8s.Log(kc)
    const stream = new PassThrough()
    const senderId = event.sender.id

    stream.on('data', (chunk: Buffer) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('k8s:logChunk', sessionId, chunk.toString())
      }
    })

    const req = await log.log(safeNs, safePod, safeContainer, stream, (err) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('k8s:logEnd', sessionId, err ? toMessage(err) : null)
      }
      logSessions.delete(sessionId)
    }, { follow: true, tailLines: tail })

    logSessions.set(sessionId, { req, senderId })
    return sessionId
  })

  ipcMain.handle('k8s:logsStop', (event: IpcMainInvokeEvent, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return
    const entry = logSessions.get(sessionId)
    if (!entry) return
    if (entry.senderId !== event.sender.id) throw new OwnershipError('Log session')
    disposeLogSession(sessionId)
  })

  // ── Pod exec ─────────────────────────────────────────────────────────────────

  ipcMain.handle('k8s:execStart', async (event: IpcMainInvokeEvent, context: unknown, namespace: unknown, pod: unknown, container: unknown, kubeconfigPath?: unknown) => {
    const safePath = validateOptionalKubeconfig(kubeconfigPath)
    const safeNs = validateNamespace(namespace)
    const safePod = validateResourceName(pod)
    const safeContainer = validateResourceName(container)
    const sessionId = makeId()
    const kc = loadKubeConfig(safePath)
    const ctx = validateK8sName(context, 'context')
    if (!kc.getContexts().some((c) => c.name === ctx)) throw new ValidationError(`Unknown kube context: ${ctx}`)
    kc.setCurrentContext(ctx)
    const exec = new k8s.Exec(kc)
    const senderId = event.sender.id

    const stdin = new PassThrough()
    const stdout = new PassThrough()

    stdout.on('data', (chunk: Buffer) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('k8s:execData', sessionId, chunk.toString())
      }
    })

    const ws = await exec.exec(
      safeNs, safePod, safeContainer,
      ['/bin/sh'],
      stdout, stdout, stdin,
      true,
      (status) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('k8s:execClose', sessionId, status)
        }
        execSessions.delete(sessionId)
      }
    )

    execSessions.set(sessionId, { stdin, ws: ws as ExecSession['ws'], senderId })
    return sessionId
  })

  ipcMain.on('k8s:execSend', (event: IpcMainEvent, sessionId: unknown, data: unknown) => {
    if (typeof sessionId !== 'string' || typeof data !== 'string') return
    const entry = execSessions.get(sessionId)
    if (entry?.senderId !== event.sender.id) return
    if (Buffer.byteLength(data, 'utf8') > 64 * 1024) return
    entry.stdin.write(data)
  })

  ipcMain.on('k8s:execResize', (event: IpcMainEvent, sessionId: unknown, cols: unknown, rows: unknown) => {
    if (typeof sessionId !== 'string') return
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
    if ((cols as number) < 1 || (cols as number) > 1000 || (rows as number) < 1 || (rows as number) > 1000) return
    const entry = execSessions.get(sessionId)
    if (entry?.senderId !== event.sender.id) return
    if (!entry.ws?.send) return
    try {
      const buf = Buffer.alloc(5)
      buf.writeUInt8(4, 0)
      buf.writeUInt16BE(rows as number, 1)
      buf.writeUInt16BE(cols as number, 3)
      entry.ws.send(buf)
    } catch (err) {
      safeLog(`exec resize ${sessionId}`, err)
    }
  })

  ipcMain.handle('k8s:execStop', (event: IpcMainInvokeEvent, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return
    const entry = execSessions.get(sessionId)
    if (!entry) return
    if (entry.senderId !== event.sender.id) throw new OwnershipError('Exec session')
    disposeExecSession(sessionId)
  })

  // ── Port forwarding ───────────────────────────────────────────────────────────

  ipcMain.handle('k8s:portForwardStart', async (event: IpcMainInvokeEvent, context: unknown, namespace: unknown, podName: unknown, targetPort: unknown, localPort: unknown, kubeconfigPath?: unknown) => {
    const safePath = validateOptionalKubeconfig(kubeconfigPath)
    const safeNs = validateNamespace(namespace)
    const safePod = validateResourceName(podName)
    const safeTarget = validatePort(targetPort, 'target port')
    const ctx = validateK8sName(context, 'context')
    const kc = loadKubeConfig(safePath)
    if (!kc.getContexts().some((c) => c.name === ctx)) throw new ValidationError(`Unknown kube context: ${ctx}`)
    kc.setCurrentContext(ctx)
    return startPodForward(kc, safeNs, safePod, safeTarget, localPort, event.sender.id, {
      context: ctx, namespace: safeNs, podName: safePod, targetPort: safeTarget,
    })
  })

  // Forwards a service port by resolving its endpoints to a ready backing pod —
  // the PortForward API itself can only target pods.
  ipcMain.handle('k8s:servicePortForwardStart', async (event: IpcMainInvokeEvent, context: unknown, namespace: unknown, serviceName: unknown, servicePort: unknown, localPort: unknown, kubeconfigPath?: unknown) => {
    const safeNs = validateNamespace(namespace)
    const safeSvc = validateResourceName(serviceName)
    const safePort = validatePort(servicePort, 'service port')
    const { core, kc } = makeClient(context, validateOptionalKubeconfig(kubeconfigPath))

    const svc = (await core.readNamespacedService(safeSvc, safeNs)).body
    const portSpec = svc.spec?.ports?.find(p => p.port === safePort) ?? svc.spec?.ports?.[0]
    if (!portSpec) throw new NotFoundError(`Port ${safePort} on service ${safeSvc}`)

    const eps = (await core.readNamespacedEndpoints(safeSvc, safeNs)).body
    for (const subset of eps.subsets ?? []) {
      const epPort = subset.ports?.length === 1
        ? subset.ports[0]
        : subset.ports?.find(p => p.name === portSpec.name)
      const pod = subset.addresses?.find(a => a.targetRef?.kind === 'Pod')?.targetRef?.name
      if (epPort && pod) {
        return startPodForward(kc, safeNs, pod, epPort.port, localPort, event.sender.id, {
          context: kc.getCurrentContext(), namespace: safeNs, podName: pod, targetPort: epPort.port, service: safeSvc,
        })
      }
    }
    throw new NotFoundError(`Ready endpoint for service ${safeSvc}`)
  })

  ipcMain.handle('k8s:portForwardStop', (event: IpcMainInvokeEvent, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return
    const entry = pfSessions.get(sessionId)
    if (!entry) return
    if (entry.senderId !== event.sender.id) throw new OwnershipError('Port forward')
    disposePfSession(sessionId)
  })

  ipcMain.handle('k8s:portForwardList', (event: IpcMainInvokeEvent) => {
    const senderId = event.sender.id
    return Array.from(pfSessions.entries())
      .filter(([, s]) => s.senderId === senderId)
      .map(([id, s]) => ({ id, ...s.meta }))
  })
}
