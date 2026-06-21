export {}

interface TunnelInfo {
  id: string
  sessionId: string
  type: 'local' | 'remote' | 'dynamic'
  label?: string
  listenPort: number
  targetHost?: string
  targetPort?: number
  status: 'active' | 'error' | 'stopped'
  error?: string
  connections: number
}

declare global {
  interface File {
    readonly path: string
  }
  interface Window {
    api: {
      platform: NodeJS.Platform
      sessions: {
        list: () => Promise<any[]>
        create: (data: any) => Promise<any>
        update: (id: string, data: any) => Promise<any>
        delete: (id: string) => Promise<void>
        getCredentials: (sessionId: string) => Promise<{ password?: string }>
        count: () => Promise<number>
        clearAll: () => Promise<void>
        export: () => Promise<{ exported: number; canceled: boolean }>
        import: () => Promise<{ imported: number; skipped: number; canceled: boolean }>
      }
      sshConfig: {
        hosts: () => Promise<{ alias: string; host: string; port: number; username?: string; keyPath?: string; proxyJump?: string }[]>
      }
      localpty: {
        start: (cols: number, rows: number) => Promise<string>
        write: (id: string, data: string) => void
        resize: (id: string, cols: number, rows: number) => void
        kill: (id: string) => Promise<void>
        onData: (cb: (id: string, data: string) => void) => () => void
        onExit: (cb: (id: string, exitCode: number) => void) => () => void
      }
      runner: {
        run: (sessionIds: string[], command: string) => Promise<string>
        cancel: (runId: string) => Promise<void>
        onOutput: (cb: (runId: string, sessionId: string, data: string) => void) => () => void
        onDone: (cb: (runId: string, sessionId: string, exitCode: number | null, error: string | null) => void) => () => void
      }
      docker: {
        connect: (sessionId: string) => Promise<string>
        disconnect: (id: string) => Promise<void>
        containers: (id: string) => Promise<any[]>
        stats: (id: string) => Promise<any[]>
        images: (id: string) => Promise<any[]>
        info: (id: string) => Promise<Record<string, unknown> | null>
        action: (id: string, container: string, action: 'start' | 'stop' | 'restart' | 'rm') => Promise<void>
        logsStart: (id: string, container: string, tail: number) => Promise<string>
        logsStop: (logId: string) => Promise<void>
        onLogChunk: (cb: (logId: string, data: string) => void) => () => void
        onLogEnd: (cb: (logId: string, err: string | null) => void) => () => void
      }
      tunnels: {
        list: () => Promise<TunnelInfo[]>
        save: (def: Omit<TunnelInfo, 'id' | 'status' | 'error' | 'connections'>, id?: string) => Promise<TunnelInfo>
        delete: (id: string) => Promise<void>
        start: (id: string) => Promise<void>
        stop: (id: string) => Promise<void>
        onChanged: (cb: () => void) => () => void
      }
      auth: {
        getMode: () => Promise<'none' | 'pin' | 'password' | 'biometrics'>
        isAvailable: () => Promise<boolean>
        isUnlocked: () => Promise<boolean>
        unlock: (credential?: string) => Promise<{ success: boolean; error?: string }>
        lock: () => Promise<void>
        setup: (newMode: string, newCredential?: string, currentCredential?: string) => Promise<{ success: boolean; error?: string }>
        onLocked: (cb: () => void) => () => void
      }
      ssh: {
        connect: (config: any) => Promise<string>
        send: (streamId: string, data: string) => void
        resize: (streamId: string, cols: number, rows: number) => void
        disconnect: (streamId: string) => Promise<void>
        onData: (cb: (streamId: string, data: string) => void) => () => void
        onClose: (cb: (streamId: string) => void) => () => void
        startMetrics: (streamId: string) => Promise<void>
        stopMetrics: (streamId: string) => void
        onMetrics: (cb: (streamId: string, data: { cpu: number; memUsed: number; memTotal: number; diskUsed?: number; diskTotal?: number; load1?: number; uptimeSec?: number; available: boolean }) => void) => () => void
      }
      sftp: {
        connect: (config: any) => Promise<string>
        list: (clientId: string, path: string) => Promise<any[]>
        readFile: (clientId: string, remotePath: string) => Promise<string>
        writeFile: (clientId: string, remotePath: string, content: string) => Promise<void>
        download: (clientId: string, remotePath: string, localPath: string) => Promise<boolean>
        upload: (clientId: string, localPath: string, remotePath: string) => Promise<boolean>
        delete: (clientId: string, remotePath: string) => Promise<void>
        rename: (clientId: string, oldPath: string, newPath: string) => Promise<void>
        mkdir: (clientId: string, remotePath: string) => Promise<void>
        rmdir: (clientId: string, remotePath: string) => Promise<void>
        chmod: (clientId: string, remotePath: string, mode: number) => Promise<void>
        stat: (clientId: string, remotePath: string) => Promise<{ size: number; mtime: number; atime: number; mode: number; uid: number; gid: number; isDirectory: boolean }>
        disconnect: (clientId: string) => Promise<void>
      }
      localfs: {
        home: () => Promise<string>
        list: (dirPath: string) => Promise<{ name: string; size: number; mtime: number; permissions: number; isDirectory: boolean; path: string }[]>
        readTextFile: (filePath: string) => Promise<string>
        writeTextFile: (filePath: string, content: string) => Promise<boolean>
      }
      fs: {
        readFile: (path: string) => Promise<string>
      }
      k8s: {
        contexts: () => Promise<string[]>
        contextsDetailed: () => Promise<{ name: string; server: string }[]>
        importKubeconfig: (path: string) => Promise<{ path: string; contexts: { name: string; server: string }[] }>
        showFilePicker: () => Promise<string | null>
        namespaces: (context: string, kubeconfigPath?: string) => Promise<string[]>
        pods: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        deletePod: (context: string, namespace: string, name: string, kubeconfigPath?: string) => Promise<void>
        deployments: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        scaleDeployment: (context: string, namespace: string, name: string, replicas: number, kubeconfigPath?: string) => Promise<void>
        restartDeployment: (context: string, namespace: string, name: string, kubeconfigPath?: string) => Promise<void>
        statefulsets: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        daemonsets: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        replicasets: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        jobs: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        cronjobs: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        services: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        ingresses: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        configmaps: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        secrets: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        secretDetail: (context: string, namespace: string, name: string, kubeconfigPath?: string) => Promise<Record<string, string>>
        nodes: (context: string, kubeconfigPath?: string) => Promise<any[]>
        events: (context: string, namespace: string, kubeconfigPath?: string) => Promise<any[]>
        resourceDetail: (context: string, namespace: string, kind: string, name: string, kubeconfigPath?: string) => Promise<string>
        logsGet: (context: string, namespace: string, pod: string, container: string, tailLines: number, kubeconfigPath?: string) => Promise<string>
        logsStream: (context: string, namespace: string, pod: string, container: string, tailLines: number, kubeconfigPath?: string) => Promise<string>
        logsStop: (sessionId: string) => Promise<void>
        onLogChunk: (cb: (sessionId: string, data: string) => void) => () => void
        onLogEnd: (cb: (sessionId: string, err: string | null) => void) => () => void
        execStart: (context: string, namespace: string, pod: string, container: string, kubeconfigPath?: string) => Promise<string>
        execSend: (sessionId: string, data: string) => void
        execResize: (sessionId: string, cols: number, rows: number) => void
        execStop: (sessionId: string) => Promise<void>
        onExecData: (cb: (sessionId: string, data: string) => void) => () => void
        onExecClose: (cb: (sessionId: string, status: any) => void) => () => void
        portForwardStart: (context: string, namespace: string, podName: string, targetPort: number, localPort: number, kubeconfigPath?: string) => Promise<{ id: string; localPort: number }>
        servicePortForwardStart: (context: string, namespace: string, serviceName: string, servicePort: number, localPort: number, kubeconfigPath?: string) => Promise<{ id: string; localPort: number }>
        portForwardStop: (id: string) => Promise<void>
        portForwardList: () => Promise<{ id: string; localPort: number; podName: string; targetPort: number; context: string; namespace: string; service?: string }[]>
      }
      settings: {
        get: () => Promise<Record<string, unknown>>
        set: (key: string, value: unknown) => Promise<Record<string, unknown>>
        reset: () => Promise<Record<string, unknown>>
      }
      database: {
        connect: (config: { dbType: string; host: string; port: number; username: string; password?: string; database: string; ssl?: string }) => Promise<string>
        disconnect: (id: string) => Promise<void>
        query: (id: string, sql: string) => Promise<{ columns: string[]; rows: any[]; rowCount: number; duration: number }>
        tables: (id: string) => Promise<string[]>
        tableInfo: (id: string, table: string) => Promise<{ columns: { name: string; type: string; nullable: boolean }[] }>
      }
      redis: {
        connect: (config: any) => Promise<string>
        disconnect: (id: string) => Promise<void>
        info: (id: string) => Promise<any>
        keys: (id: string, pattern: string) => Promise<string[]>
        get: (id: string, key: string) => Promise<any>
        set: (id: string, key: string, value: string, ttl?: number) => Promise<void>
        del: (id: string, ...keys: string[]) => Promise<void>
        command: (id: string, cmd: string) => Promise<any>
      }
      rdp: {
        connect: (config: { host: string; port?: number; username: string; password: string; width?: number; height?: number }) => Promise<string>
        disconnect: (id: string) => Promise<void>
        input: (id: string, type: number, flags: number, a: number, b: number) => void
        onFrame: (cb: (id: string, width: number, height: number, pixels: Uint8Array) => void) => () => void
        onClose: (cb: (id: string, error: string | null) => void) => () => void
      }
    }
  }
}
