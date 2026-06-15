import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // Sessions
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (data: any) => ipcRenderer.invoke('sessions:create', data),
    update: (id: string, data: any) => ipcRenderer.invoke('sessions:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
    getCredentials: (sessionId: string) => ipcRenderer.invoke('sessions:getCredentials', sessionId),
    count: () => ipcRenderer.invoke('sessions:count') as Promise<number>,
    clearAll: () => ipcRenderer.invoke('sessions:clearAll'),
    export: () => ipcRenderer.invoke('sessions:export'),
    import: () => ipcRenderer.invoke('sessions:import'),
  },

  // SSH config (~/.ssh/config) import
  sshConfig: {
    hosts: () => ipcRenderer.invoke('sshconfig:hosts'),
  },

  // SSH tunnels
  tunnels: {
    list: () => ipcRenderer.invoke('tunnels:list'),
    save: (def: any, id?: string) => ipcRenderer.invoke('tunnels:save', def, id),
    delete: (id: string) => ipcRenderer.invoke('tunnels:delete', id),
    start: (id: string) => ipcRenderer.invoke('tunnels:start', id),
    stop: (id: string) => ipcRenderer.invoke('tunnels:stop', id),
    onChanged: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('tunnel:changed', handler)
      return () => ipcRenderer.off('tunnel:changed', handler)
    },
  },

  // Auth (lock screen + method management)
  auth: {
    getMode: () => ipcRenderer.invoke('auth:getMode'),
    isAvailable: () => ipcRenderer.invoke('auth:isAvailable'),
    isUnlocked: () => ipcRenderer.invoke('auth:isUnlocked'),
    unlock: (credential?: string) => ipcRenderer.invoke('auth:unlock', credential),
    lock: () => ipcRenderer.invoke('auth:lock'),
    setup: (newMode: string, newCredential?: string, currentCredential?: string) =>
      ipcRenderer.invoke('auth:setup', newMode, newCredential, currentCredential),
    onLocked: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('auth:locked', handler)
      return () => ipcRenderer.off('auth:locked', handler)
    },
  },

  // SSH
  ssh: {
    connect: (config: any) => ipcRenderer.invoke('ssh:connect', config),
    send: (streamId: string, data: string) => ipcRenderer.send('ssh:data', streamId, data),
    resize: (streamId: string, cols: number, rows: number) =>
      ipcRenderer.send('ssh:resize', streamId, cols, rows),
    disconnect: (streamId: string) => ipcRenderer.invoke('ssh:disconnect', streamId),
    onData: (cb: (streamId: string, data: string) => void) => {
      const handler = (_e: any, streamId: string, data: string) => cb(streamId, data)
      ipcRenderer.on('ssh:data', handler)
      return () => ipcRenderer.off('ssh:data', handler)
    },
    onClose: (cb: (streamId: string) => void) => {
      const handler = (_e: any, streamId: string) => cb(streamId)
      ipcRenderer.on('ssh:closed', handler)
      return () => ipcRenderer.off('ssh:closed', handler)
    },
    startMetrics: (streamId: string) => ipcRenderer.invoke('ssh:metrics-start', streamId),
    stopMetrics: (streamId: string) => ipcRenderer.send('ssh:metrics-stop', streamId),
    onMetrics: (cb: (streamId: string, data: { cpu: number; memUsed: number; memTotal: number; available: boolean }) => void) => {
      const handler = (_e: any, streamId: string, data: any) => cb(streamId, data)
      ipcRenderer.on('ssh:metrics', handler)
      return () => ipcRenderer.off('ssh:metrics', handler)
    },
  },

  // SFTP
  sftp: {
    connect: (config: any) => ipcRenderer.invoke('sftp:connect', config),
    list: (clientId: string, path: string) => ipcRenderer.invoke('sftp:list', clientId, path),
    readFile: (clientId: string, remotePath: string) => ipcRenderer.invoke('sftp:readFile', clientId, remotePath),
    writeFile: (clientId: string, remotePath: string, content: string) => ipcRenderer.invoke('sftp:writeFile', clientId, remotePath, content),
    download: (clientId: string, remotePath: string, localPath: string) =>
      ipcRenderer.invoke('sftp:download', clientId, remotePath, localPath),
    upload: (clientId: string, localPath: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:upload', clientId, localPath, remotePath),
    delete: (clientId: string, remotePath: string) => ipcRenderer.invoke('sftp:delete', clientId, remotePath),
    rename: (clientId: string, oldPath: string, newPath: string) => ipcRenderer.invoke('sftp:rename', clientId, oldPath, newPath),
    mkdir: (clientId: string, remotePath: string) => ipcRenderer.invoke('sftp:mkdir', clientId, remotePath),
    rmdir: (clientId: string, remotePath: string) => ipcRenderer.invoke('sftp:rmdir', clientId, remotePath),
    chmod: (clientId: string, remotePath: string, mode: number) => ipcRenderer.invoke('sftp:chmod', clientId, remotePath, mode),
    stat: (clientId: string, remotePath: string) => ipcRenderer.invoke('sftp:stat', clientId, remotePath),
    disconnect: (clientId: string) => ipcRenderer.invoke('sftp:disconnect', clientId),
  },

  // Database
  database: {
    connect: (config: { dbType: string; host: string; port: number; username: string; password?: string; database: string; ssl?: string }) =>
      ipcRenderer.invoke('db:connect', config),
    disconnect: (id: string) => ipcRenderer.invoke('db:disconnect', id),
    query: (id: string, sql: string) => ipcRenderer.invoke('db:query', id, sql),
    tables: (id: string) => ipcRenderer.invoke('db:tables', id),
    tableInfo: (id: string, table: string) => ipcRenderer.invoke('db:tableInfo', id, table),
  },

  // Local filesystem
  localfs: {
    home: () => ipcRenderer.invoke('localfs:home') as Promise<string>,
    list: (dirPath: string) => ipcRenderer.invoke('localfs:list', dirPath),
    readTextFile: (filePath: string) => ipcRenderer.invoke('localfs:readTextFile', filePath) as Promise<string>,
    writeTextFile: (filePath: string, content: string) => ipcRenderer.invoke('localfs:writeTextFile', filePath, content),
  },

  // Filesystem (for reading SSH keys)
  fs: {
    readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  },

  // K8s
  k8s: {
    contexts: () => ipcRenderer.invoke('k8s:contexts'),
    contextsDetailed: () => ipcRenderer.invoke('k8s:contextsDetailed'),
    importKubeconfig: (path: string) => ipcRenderer.invoke('k8s:importKubeconfig', path),
    showFilePicker: () => ipcRenderer.invoke('k8s:showFilePicker'),
    namespaces: (context: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:namespaces', context, kubeconfigPath),
    // Workloads
    pods: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:pods', context, namespace, kubeconfigPath),
    deletePod: (context: string, namespace: string, name: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:deletePod', context, namespace, name, kubeconfigPath),
    deployments: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:deployments', context, namespace, kubeconfigPath),
    scaleDeployment: (context: string, namespace: string, name: string, replicas: number, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:scaleDeployment', context, namespace, name, replicas, kubeconfigPath),
    restartDeployment: (context: string, namespace: string, name: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:restartDeployment', context, namespace, name, kubeconfigPath),
    statefulsets: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:statefulsets', context, namespace, kubeconfigPath),
    daemonsets: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:daemonsets', context, namespace, kubeconfigPath),
    replicasets: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:replicasets', context, namespace, kubeconfigPath),
    jobs: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:jobs', context, namespace, kubeconfigPath),
    cronjobs: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:cronjobs', context, namespace, kubeconfigPath),
    // Network
    services: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:services', context, namespace, kubeconfigPath),
    ingresses: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:ingresses', context, namespace, kubeconfigPath),
    // Config
    configmaps: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:configmaps', context, namespace, kubeconfigPath),
    secrets: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:secrets', context, namespace, kubeconfigPath),
    secretDetail: (context: string, namespace: string, name: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:secretDetail', context, namespace, name, kubeconfigPath),
    // Nodes + Events
    nodes: (context: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:nodes', context, kubeconfigPath),
    events: (context: string, namespace: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:events', context, namespace, kubeconfigPath),
    // Resource detail
    resourceDetail: (context: string, namespace: string, kind: string, name: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:resourceDetail', context, namespace, kind, name, kubeconfigPath),
    // Logs
    logsGet: (context: string, namespace: string, pod: string, container: string, tailLines: number, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:logsGet', context, namespace, pod, container, tailLines, kubeconfigPath),
    logsStream: (context: string, namespace: string, pod: string, container: string, tailLines: number, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:logsStream', context, namespace, pod, container, tailLines, kubeconfigPath),
    logsStop: (sessionId: string) => ipcRenderer.invoke('k8s:logsStop', sessionId),
    onLogChunk: (cb: (sessionId: string, data: string) => void) => {
      const h = (_e: any, sessionId: string, data: string) => cb(sessionId, data)
      ipcRenderer.on('k8s:logChunk', h)
      return () => ipcRenderer.off('k8s:logChunk', h)
    },
    onLogEnd: (cb: (sessionId: string, err: string | null) => void) => {
      const h = (_e: any, sessionId: string, err: string | null) => cb(sessionId, err)
      ipcRenderer.on('k8s:logEnd', h)
      return () => ipcRenderer.off('k8s:logEnd', h)
    },
    // Exec
    execStart: (context: string, namespace: string, pod: string, container: string, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:execStart', context, namespace, pod, container, kubeconfigPath),
    execSend: (sessionId: string, data: string) => ipcRenderer.send('k8s:execSend', sessionId, data),
    execResize: (sessionId: string, cols: number, rows: number) => ipcRenderer.send('k8s:execResize', sessionId, cols, rows),
    execStop: (sessionId: string) => ipcRenderer.invoke('k8s:execStop', sessionId),
    onExecData: (cb: (sessionId: string, data: string) => void) => {
      const h = (_e: any, sessionId: string, data: string) => cb(sessionId, data)
      ipcRenderer.on('k8s:execData', h)
      return () => ipcRenderer.off('k8s:execData', h)
    },
    onExecClose: (cb: (sessionId: string, status: any) => void) => {
      const h = (_e: any, sessionId: string, status: any) => cb(sessionId, status)
      ipcRenderer.on('k8s:execClose', h)
      return () => ipcRenderer.off('k8s:execClose', h)
    },
    // Port forwarding
    portForwardStart: (context: string, namespace: string, podName: string, targetPort: number, localPort: number, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:portForwardStart', context, namespace, podName, targetPort, localPort, kubeconfigPath),
    servicePortForwardStart: (context: string, namespace: string, serviceName: string, servicePort: number, localPort: number, kubeconfigPath?: string) =>
      ipcRenderer.invoke('k8s:servicePortForwardStart', context, namespace, serviceName, servicePort, localPort, kubeconfigPath),
    portForwardStop: (id: string) => ipcRenderer.invoke('k8s:portForwardStop', id),
    portForwardList: () => ipcRenderer.invoke('k8s:portForwardList'),
  },

  // Local terminal (node-pty)
  localpty: {
    start: (cols: number, rows: number) => ipcRenderer.invoke('localpty:start', cols, rows),
    write: (id: string, data: string) => ipcRenderer.send('localpty:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('localpty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('localpty:kill', id),
    onData: (cb: (id: string, data: string) => void) => {
      const handler = (_e: any, id: string, data: string) => cb(id, data)
      ipcRenderer.on('localpty:data', handler)
      return () => ipcRenderer.off('localpty:data', handler)
    },
    onExit: (cb: (id: string, exitCode: number) => void) => {
      const handler = (_e: any, id: string, exitCode: number) => cb(id, exitCode)
      ipcRenderer.on('localpty:exit', handler)
      return () => ipcRenderer.off('localpty:exit', handler)
    },
  },

  // Multi-host command runner
  runner: {
    run: (sessionIds: string[], command: string) => ipcRenderer.invoke('runner:run', sessionIds, command),
    cancel: (runId: string) => ipcRenderer.invoke('runner:cancel', runId),
    onOutput: (cb: (runId: string, sessionId: string, data: string) => void) => {
      const handler = (_e: any, runId: string, sessionId: string, data: string) => cb(runId, sessionId, data)
      ipcRenderer.on('runner:output', handler)
      return () => ipcRenderer.off('runner:output', handler)
    },
    onDone: (cb: (runId: string, sessionId: string, exitCode: number | null, error: string | null) => void) => {
      const handler = (_e: any, runId: string, sessionId: string, exitCode: number | null, error: string | null) =>
        cb(runId, sessionId, exitCode, error)
      ipcRenderer.on('runner:done', handler)
      return () => ipcRenderer.off('runner:done', handler)
    },
  },

  // Docker over SSH
  docker: {
    connect: (sessionId: string) => ipcRenderer.invoke('docker:connect', sessionId),
    disconnect: (id: string) => ipcRenderer.invoke('docker:disconnect', id),
    containers: (id: string) => ipcRenderer.invoke('docker:containers', id),
    stats: (id: string) => ipcRenderer.invoke('docker:stats', id),
    images: (id: string) => ipcRenderer.invoke('docker:images', id),
    info: (id: string) => ipcRenderer.invoke('docker:info', id),
    action: (id: string, container: string, action: string) =>
      ipcRenderer.invoke('docker:action', id, container, action),
    logsStart: (id: string, container: string, tail: number) =>
      ipcRenderer.invoke('docker:logsStart', id, container, tail),
    logsStop: (logId: string) => ipcRenderer.invoke('docker:logsStop', logId),
    onLogChunk: (cb: (logId: string, data: string) => void) => {
      const handler = (_e: any, logId: string, data: string) => cb(logId, data)
      ipcRenderer.on('docker:logChunk', handler)
      return () => ipcRenderer.off('docker:logChunk', handler)
    },
    onLogEnd: (cb: (logId: string, err: string | null) => void) => {
      const handler = (_e: any, logId: string, err: string | null) => cb(logId, err)
      ipcRenderer.on('docker:logEnd', handler)
      return () => ipcRenderer.off('docker:logEnd', handler)
    },
  },

  // Settings
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    reset: () => ipcRenderer.invoke('settings:reset'),
  },

  // Redis
  redis: {
    connect: (config: any) => ipcRenderer.invoke('redis:connect', config),
    disconnect: (id: string) => ipcRenderer.invoke('redis:disconnect', id),
    info: (id: string) => ipcRenderer.invoke('redis:info', id),
    keys: (id: string, pattern: string) => ipcRenderer.invoke('redis:keys', id, pattern),
    get: (id: string, key: string) => ipcRenderer.invoke('redis:get', id, key),
    set: (id: string, key: string, value: string, ttl?: number) => ipcRenderer.invoke('redis:set', id, key, value, ttl),
    del: (id: string, ...keys: string[]) => ipcRenderer.invoke('redis:del', id, ...keys),
    command: (id: string, cmd: string) => ipcRenderer.invoke('redis:command', id, cmd),
  },

  tabs: {
    onCycle: (cb: (dir: 'next' | 'prev') => void) => {
      const handler = (_e: any, dir: 'next' | 'prev') => cb(dir)
      ipcRenderer.on('tab:cycle', handler)
      return () => ipcRenderer.off('tab:cycle', handler)
    },
  },
})
