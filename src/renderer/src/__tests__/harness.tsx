/**
 * Shared harness for renderer component tests (jsdom).
 *
 * Usage — test files must opt into jsdom since the global vitest env is node:
 *   // @vitest-environment jsdom
 *   import { installWindowApi, seedStore, makeSession, makeTab } from '../../__tests__/harness'
 *
 * installWindowApi() builds a full vi.fn() mock of the preload bridge with
 * benign defaults; pass overrides for the calls a test cares about, and use
 * the returned object to assert on calls or swap resolved values.
 */
import { vi } from 'vitest'
import type { Session, Tab } from '../store'
import { useAppStore } from '../store'

const unsub = () => () => {}

export function buildWindowApi() {
  return {
    platform: 'darwin',
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 's1' }),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      getCredentials: vi.fn().mockResolvedValue({ password: 'pw' }),
      count: vi.fn().mockResolvedValue(0),
      clearAll: vi.fn().mockResolvedValue(undefined),
      export: vi.fn().mockResolvedValue({ ok: true }),
      import: vi.fn().mockResolvedValue({ ok: true }),
    },
    sshConfig: { hosts: vi.fn().mockResolvedValue([]) },
    tunnels: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockImplementation(unsub),
    },
    auth: {
      getMode: vi.fn().mockResolvedValue('none'),
      isAvailable: vi.fn().mockResolvedValue(true),
      isUnlocked: vi.fn().mockResolvedValue(true),
      unlock: vi.fn().mockResolvedValue(true),
      lock: vi.fn().mockResolvedValue(undefined),
      setup: vi.fn().mockResolvedValue(true),
      onLocked: vi.fn().mockImplementation(unsub),
    },
    ssh: {
      connect: vi.fn().mockResolvedValue('stream-1'),
      send: vi.fn(),
      resize: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      onData: vi.fn().mockImplementation(unsub),
      onClose: vi.fn().mockImplementation(unsub),
      startMetrics: vi.fn().mockResolvedValue(undefined),
      stopMetrics: vi.fn(),
      onMetrics: vi.fn().mockImplementation(unsub),
    },
    sftp: {
      connect: vi.fn().mockResolvedValue('sftp-1'),
      list: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(''),
      writeFile: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(undefined),
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rmdir: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 0, mtime: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
    database: {
      connect: vi.fn().mockResolvedValue('db-1'),
      disconnect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ columns: [], rows: [], rowCount: 0, duration: 1 }),
      tables: vi.fn().mockResolvedValue([]),
      tableInfo: vi.fn().mockResolvedValue([]),
    },
    localfs: {
      home: vi.fn().mockResolvedValue('/home/user'),
      list: vi.fn().mockResolvedValue([]),
      readTextFile: vi.fn().mockResolvedValue(''),
      writeTextFile: vi.fn().mockResolvedValue(undefined),
    },
    fs: { readFile: vi.fn().mockResolvedValue('') },
    k8s: {
      contexts: vi.fn().mockResolvedValue([]),
      contextsDetailed: vi.fn().mockResolvedValue([]),
      importKubeconfig: vi.fn().mockResolvedValue([]),
      showFilePicker: vi.fn().mockResolvedValue(null),
      namespaces: vi.fn().mockResolvedValue(['default']),
      pods: vi.fn().mockResolvedValue([]),
      deletePod: vi.fn().mockResolvedValue(undefined),
      deployments: vi.fn().mockResolvedValue([]),
      scaleDeployment: vi.fn().mockResolvedValue(undefined),
      restartDeployment: vi.fn().mockResolvedValue(undefined),
      statefulsets: vi.fn().mockResolvedValue([]),
      daemonsets: vi.fn().mockResolvedValue([]),
      replicasets: vi.fn().mockResolvedValue([]),
      jobs: vi.fn().mockResolvedValue([]),
      cronjobs: vi.fn().mockResolvedValue([]),
      services: vi.fn().mockResolvedValue([]),
      ingresses: vi.fn().mockResolvedValue([]),
      configmaps: vi.fn().mockResolvedValue([]),
      secrets: vi.fn().mockResolvedValue([]),
      secretDetail: vi.fn().mockResolvedValue({}),
      nodes: vi.fn().mockResolvedValue([]),
      events: vi.fn().mockResolvedValue([]),
      resourceDetail: vi.fn().mockResolvedValue('{}'),
      logsGet: vi.fn().mockResolvedValue(''),
      logsStream: vi.fn().mockResolvedValue('log-1'),
      logsStop: vi.fn().mockResolvedValue(undefined),
      onLogChunk: vi.fn().mockImplementation(unsub),
      onLogEnd: vi.fn().mockImplementation(unsub),
      execStart: vi.fn().mockResolvedValue('exec-1'),
      execSend: vi.fn(),
      execResize: vi.fn(),
      execStop: vi.fn().mockResolvedValue(undefined),
      onExecData: vi.fn().mockImplementation(unsub),
      onExecClose: vi.fn().mockImplementation(unsub),
      portForwardStart: vi.fn().mockResolvedValue({ id: 'pf-1' }),
      servicePortForwardStart: vi.fn().mockResolvedValue({ id: 'pf-2' }),
      portForwardStop: vi.fn().mockResolvedValue(undefined),
      portForwardList: vi.fn().mockResolvedValue([]),
    },
    localpty: {
      start: vi.fn().mockResolvedValue('pty-1'),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn().mockResolvedValue(undefined),
      onData: vi.fn().mockImplementation(unsub),
      onExit: vi.fn().mockImplementation(unsub),
    },
    runner: {
      run: vi.fn().mockResolvedValue('run-1'),
      cancel: vi.fn().mockResolvedValue(undefined),
      onOutput: vi.fn().mockImplementation(unsub),
      onDone: vi.fn().mockImplementation(unsub),
    },
    docker: {
      connect: vi.fn().mockResolvedValue('docker-1'),
      disconnect: vi.fn().mockResolvedValue(undefined),
      containers: vi.fn().mockResolvedValue([]),
      stats: vi.fn().mockResolvedValue([]),
      images: vi.fn().mockResolvedValue([]),
      info: vi.fn().mockResolvedValue({}),
      action: vi.fn().mockResolvedValue(undefined),
      logsStart: vi.fn().mockResolvedValue('dlog-1'),
      logsStop: vi.fn().mockResolvedValue(undefined),
      onLogChunk: vi.fn().mockImplementation(unsub),
      onLogEnd: vi.fn().mockImplementation(unsub),
    },
    settings: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
    },
    redis: {
      connect: vi.fn().mockResolvedValue('redis-1'),
      disconnect: vi.fn().mockResolvedValue(undefined),
      info: vi.fn().mockResolvedValue({}),
      keys: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
      command: vi.fn().mockResolvedValue(''),
    },
    rdp: {
      connect: vi.fn().mockResolvedValue('rdp-1'),
      disconnect: vi.fn().mockResolvedValue(undefined),
      onFrame: vi.fn().mockImplementation(unsub),
      onClose: vi.fn().mockImplementation(unsub),
    },
    tabs: { onCycle: vi.fn().mockImplementation(unsub) },
    menu: { on: vi.fn().mockImplementation(unsub) },
    updater: {
      version: vi.fn().mockResolvedValue('0.0.0-test'),
      check: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(undefined),
      quitAndInstall: vi.fn().mockResolvedValue(undefined),
      onStatus: vi.fn().mockImplementation(unsub),
    },
  }
}

export type WindowApiMock = ReturnType<typeof buildWindowApi>

/** Deep-merge overrides into a fresh api mock and install it on window. */
export function installWindowApi(overrides: Record<string, any> = {}): WindowApiMock {
  const api = buildWindowApi() as any
  for (const [ns, fns] of Object.entries(overrides)) {
    api[ns] = typeof fns === 'object' && fns !== null && !Array.isArray(fns) ? { ...api[ns], ...fns } : fns
  }
  ;(window as any).api = api
  return api
}

let seq = 0

export function makeSession(overrides: Partial<Session> = {}): Session {
  seq += 1
  return {
    id: `session-${seq}`,
    label: `Server ${seq}`,
    host: `host${seq}.example.com`,
    port: 22,
    username: 'root',
    authType: 'password',
    createdAt: 1700000000000,
    type: 'ssh',
    ...overrides,
  }
}

export function makeTab(overrides: Partial<Tab> = {}): Tab {
  seq += 1
  return {
    id: `tab-${seq}`,
    label: `Tab ${seq}`,
    view: 'terminal' as Tab['view'],
    status: 'idle',
    filesOpen: false,
    ...overrides,
  }
}

/** Reset the zustand store and apply partial state for a test. */
export function seedStore(state: Partial<ReturnType<typeof useAppStore.getState>>) {
  useAppStore.setState(state as any)
}
