import { contextBridge, ipcRenderer } from 'electron'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}))

// Importing the module runs contextBridge.exposeInMainWorld('api', {...})
await import('../index')

const exposeMock = vi.mocked(contextBridge.exposeInMainWorld)
const api = exposeMock.mock.calls[0][1] as any
const invokeMock = vi.mocked(ipcRenderer.invoke)
const sendMock = vi.mocked(ipcRenderer.send)
const onMock = vi.mocked(ipcRenderer.on)
const offMock = vi.mocked(ipcRenderer.off)

beforeEach(() => {
  invokeMock.mockClear()
  sendMock.mockClear()
  onMock.mockClear()
  offMock.mockClear()
})

// Asserts that calling `fn(...args)` forwards to ipcRenderer.invoke(channel, ...forwarded)
function expectInvoke(fn: (...args: any[]) => any, args: any[], channel: string, forwarded: any[] = args) {
  fn(...args)
  expect(invokeMock).toHaveBeenCalledTimes(1)
  expect(invokeMock).toHaveBeenCalledWith(channel, ...forwarded)
  invokeMock.mockClear()
}

// Asserts that calling `fn(...args)` forwards to ipcRenderer.send(channel, ...args)
function expectSend(fn: (...args: any[]) => any, args: any[], channel: string) {
  fn(...args)
  expect(sendMock).toHaveBeenCalledTimes(1)
  expect(sendMock).toHaveBeenCalledWith(channel, ...args)
  sendMock.mockClear()
}

// Asserts subscription: registers on `channel`, forwards emitted args to the callback
// (stripping the event), and the returned unsubscribe removes the same handler.
function expectSubscription(
  subscribe: (cb: (...args: any[]) => void) => () => void,
  channel: string,
  emitted: any[],
  expectedCbArgs: any[] = emitted
) {
  const cb = vi.fn()
  const unsubscribe = subscribe(cb)
  expect(onMock).toHaveBeenCalledTimes(1)
  expect(onMock).toHaveBeenCalledWith(channel, expect.any(Function))
  const handler = onMock.mock.calls[0][1] as (...args: any[]) => void
  handler({ fakeEvent: true }, ...emitted)
  expect(cb).toHaveBeenCalledTimes(1)
  expect(cb).toHaveBeenCalledWith(...expectedCbArgs)
  expect(offMock).not.toHaveBeenCalled()
  unsubscribe()
  expect(offMock).toHaveBeenCalledTimes(1)
  expect(offMock).toHaveBeenCalledWith(channel, handler)
  onMock.mockClear()
  offMock.mockClear()
}

describe('preload api', () => {
  it('exposes the api object in the main world', () => {
    expect(exposeMock).toHaveBeenCalledTimes(1)
    expect(exposeMock.mock.calls[0][0]).toBe('api')
    expect(api).toBeTypeOf('object')
  })

  it('exposes the current platform', () => {
    expect(api.platform).toBe(process.platform)
  })
})

describe('sessions', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.sessions.list, [], 'sessions:list')
    expectInvoke(api.sessions.create, [{ name: 'srv' }], 'sessions:create')
    expectInvoke(api.sessions.update, ['id-1', { name: 'x' }], 'sessions:update')
    expectInvoke(api.sessions.delete, ['id-1'], 'sessions:delete')
    expectInvoke(api.sessions.getCredentials, ['id-1'], 'sessions:getCredentials')
    expectInvoke(api.sessions.count, [], 'sessions:count')
    expectInvoke(api.sessions.clearAll, [], 'sessions:clearAll')
    expectInvoke(api.sessions.export, [], 'sessions:export')
    expectInvoke(api.sessions.import, [], 'sessions:import')
  })
})

describe('sshConfig', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.sshConfig.hosts, [], 'sshconfig:hosts')
  })
})

describe('tunnels', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.tunnels.list, [], 'tunnels:list')
    expectInvoke(api.tunnels.save, [{ host: 'h' }, 't-1'], 'tunnels:save')
    expectInvoke(api.tunnels.delete, ['t-1'], 'tunnels:delete')
    expectInvoke(api.tunnels.start, ['t-1'], 'tunnels:start')
    expectInvoke(api.tunnels.stop, ['t-1'], 'tunnels:stop')
  })

  it('onChanged subscribes and unsubscribes', () => {
    expectSubscription(api.tunnels.onChanged, 'tunnel:changed', ['ignored'], [])
  })
})

describe('auth', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.auth.getMode, [], 'auth:getMode')
    expectInvoke(api.auth.isAvailable, [], 'auth:isAvailable')
    expectInvoke(api.auth.isUnlocked, [], 'auth:isUnlocked')
    expectInvoke(api.auth.unlock, ['pin'], 'auth:unlock')
    expectInvoke(api.auth.lock, [], 'auth:lock')
    expectInvoke(api.auth.setup, ['pin', '1234', 'old'], 'auth:setup')
  })

  it('onLocked subscribes and unsubscribes', () => {
    expectSubscription(api.auth.onLocked, 'auth:locked', [], [])
  })
})

describe('ssh', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.ssh.connect, [{ host: 'h' }], 'ssh:connect')
    expectInvoke(api.ssh.disconnect, ['s-1'], 'ssh:disconnect')
    expectInvoke(api.ssh.startMetrics, ['s-1'], 'ssh:metrics-start')
  })

  it('forwards send calls', () => {
    expectSend(api.ssh.send, ['s-1', 'ls\n'], 'ssh:data')
    expectSend(api.ssh.resize, ['s-1', 80, 24], 'ssh:resize')
    expectSend(api.ssh.stopMetrics, ['s-1'], 'ssh:metrics-stop')
  })

  it('subscriptions forward events and unsubscribe', () => {
    expectSubscription(api.ssh.onData, 'ssh:data', ['s-1', 'chunk'])
    expectSubscription(api.ssh.onClose, 'ssh:closed', ['s-1'])
    expectSubscription(api.ssh.onMetrics, 'ssh:metrics', [
      's-1',
      { cpu: 1, memUsed: 2, memTotal: 4, available: true },
    ])
  })
})

describe('sftp', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.sftp.connect, [{ host: 'h' }], 'sftp:connect')
    expectInvoke(api.sftp.list, ['c-1', '/tmp'], 'sftp:list')
    expectInvoke(api.sftp.readFile, ['c-1', '/tmp/a'], 'sftp:readFile')
    expectInvoke(api.sftp.writeFile, ['c-1', '/tmp/a', 'body'], 'sftp:writeFile')
    expectInvoke(api.sftp.download, ['c-1', '/r/a', '/l/a'], 'sftp:download')
    expectInvoke(api.sftp.upload, ['c-1', '/l/a', '/r/a'], 'sftp:upload')
    expectInvoke(api.sftp.delete, ['c-1', '/r/a'], 'sftp:delete')
    expectInvoke(api.sftp.rename, ['c-1', '/r/a', '/r/b'], 'sftp:rename')
    expectInvoke(api.sftp.mkdir, ['c-1', '/r/dir'], 'sftp:mkdir')
    expectInvoke(api.sftp.rmdir, ['c-1', '/r/dir'], 'sftp:rmdir')
    expectInvoke(api.sftp.chmod, ['c-1', '/r/a', 0o644], 'sftp:chmod')
    expectInvoke(api.sftp.stat, ['c-1', '/r/a'], 'sftp:stat')
    expectInvoke(api.sftp.disconnect, ['c-1'], 'sftp:disconnect')
  })
})

describe('database', () => {
  it('forwards invoke calls', () => {
    const config = { dbType: 'postgres', host: 'h', port: 5432, username: 'u', database: 'd' }
    expectInvoke(api.database.connect, [config], 'db:connect')
    expectInvoke(api.database.disconnect, ['db-1'], 'db:disconnect')
    expectInvoke(api.database.query, ['db-1', 'select 1', [1, 'a']], 'db:query')
    expectInvoke(api.database.tables, ['db-1'], 'db:tables')
    expectInvoke(api.database.tableInfo, ['db-1', 'users'], 'db:tableInfo')
  })
})

describe('localfs', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.localfs.home, [], 'localfs:home')
    expectInvoke(api.localfs.list, ['/home/u'], 'localfs:list')
    expectInvoke(api.localfs.readTextFile, ['/home/u/a.txt'], 'localfs:readTextFile')
    expectInvoke(api.localfs.writeTextFile, ['/home/u/a.txt', 'text'], 'localfs:writeTextFile')
  })
})

describe('fs', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.fs.readFile, ['/home/u/.ssh/id_rsa'], 'fs:readFile')
  })
})

describe('k8s', () => {
  it('forwards context and namespace calls', () => {
    expectInvoke(api.k8s.contexts, [], 'k8s:contexts')
    expectInvoke(api.k8s.contextsDetailed, [], 'k8s:contextsDetailed')
    expectInvoke(api.k8s.importKubeconfig, ['/kube/config'], 'k8s:importKubeconfig')
    expectInvoke(api.k8s.showFilePicker, [], 'k8s:showFilePicker')
    expectInvoke(api.k8s.namespaces, ['ctx', '/kc'], 'k8s:namespaces')
  })

  it('forwards workload calls', () => {
    expectInvoke(api.k8s.pods, ['ctx', 'ns', '/kc'], 'k8s:pods')
    expectInvoke(api.k8s.deletePod, ['ctx', 'ns', 'pod-1', '/kc'], 'k8s:deletePod')
    expectInvoke(api.k8s.deployments, ['ctx', 'ns', '/kc'], 'k8s:deployments')
    expectInvoke(api.k8s.scaleDeployment, ['ctx', 'ns', 'dep', 3, '/kc'], 'k8s:scaleDeployment')
    expectInvoke(api.k8s.restartDeployment, ['ctx', 'ns', 'dep', '/kc'], 'k8s:restartDeployment')
    expectInvoke(api.k8s.statefulsets, ['ctx', 'ns', '/kc'], 'k8s:statefulsets')
    expectInvoke(api.k8s.daemonsets, ['ctx', 'ns', '/kc'], 'k8s:daemonsets')
    expectInvoke(api.k8s.replicasets, ['ctx', 'ns', '/kc'], 'k8s:replicasets')
    expectInvoke(api.k8s.jobs, ['ctx', 'ns', '/kc'], 'k8s:jobs')
    expectInvoke(api.k8s.cronjobs, ['ctx', 'ns', '/kc'], 'k8s:cronjobs')
  })

  it('forwards network, config, nodes and events calls', () => {
    expectInvoke(api.k8s.services, ['ctx', 'ns', '/kc'], 'k8s:services')
    expectInvoke(api.k8s.ingresses, ['ctx', 'ns', '/kc'], 'k8s:ingresses')
    expectInvoke(api.k8s.configmaps, ['ctx', 'ns', '/kc'], 'k8s:configmaps')
    expectInvoke(api.k8s.secrets, ['ctx', 'ns', '/kc'], 'k8s:secrets')
    expectInvoke(api.k8s.secretDetail, ['ctx', 'ns', 'sec', '/kc'], 'k8s:secretDetail')
    expectInvoke(api.k8s.nodes, ['ctx', '/kc'], 'k8s:nodes')
    expectInvoke(api.k8s.events, ['ctx', 'ns', '/kc'], 'k8s:events')
    expectInvoke(api.k8s.resourceDetail, ['ctx', 'ns', 'Pod', 'pod-1', '/kc'], 'k8s:resourceDetail')
  })

  it('forwards log calls and subscriptions', () => {
    expectInvoke(api.k8s.logsGet, ['ctx', 'ns', 'pod', 'main', 100, '/kc'], 'k8s:logsGet')
    expectInvoke(api.k8s.logsStream, ['ctx', 'ns', 'pod', 'main', 100, '/kc'], 'k8s:logsStream')
    expectInvoke(api.k8s.logsStop, ['sess-1'], 'k8s:logsStop')
    expectSubscription(api.k8s.onLogChunk, 'k8s:logChunk', ['sess-1', 'line'])
    expectSubscription(api.k8s.onLogEnd, 'k8s:logEnd', ['sess-1', 'boom'])
  })

  it('forwards exec calls and subscriptions', () => {
    expectInvoke(api.k8s.execStart, ['ctx', 'ns', 'pod', 'main', '/kc'], 'k8s:execStart')
    expectInvoke(api.k8s.execStop, ['sess-1'], 'k8s:execStop')
    expectSend(api.k8s.execSend, ['sess-1', 'ls\n'], 'k8s:execSend')
    expectSend(api.k8s.execResize, ['sess-1', 120, 40], 'k8s:execResize')
    expectSubscription(api.k8s.onExecData, 'k8s:execData', ['sess-1', 'out'])
    expectSubscription(api.k8s.onExecClose, 'k8s:execClose', ['sess-1', { code: 0 }])
  })

  it('forwards port forwarding calls', () => {
    expectInvoke(api.k8s.portForwardStart, ['ctx', 'ns', 'pod', 8080, 9090, '/kc'], 'k8s:portForwardStart')
    expectInvoke(api.k8s.servicePortForwardStart, ['ctx', 'ns', 'svc', 80, 8080, '/kc'], 'k8s:servicePortForwardStart')
    expectInvoke(api.k8s.portForwardStop, ['pf-1'], 'k8s:portForwardStop')
    expectInvoke(api.k8s.portForwardList, [], 'k8s:portForwardList')
  })
})

describe('localpty', () => {
  it('forwards invoke and send calls', () => {
    expectInvoke(api.localpty.start, [80, 24], 'localpty:start')
    expectInvoke(api.localpty.kill, ['pty-1'], 'localpty:kill')
    expectSend(api.localpty.write, ['pty-1', 'echo hi\n'], 'localpty:write')
    expectSend(api.localpty.resize, ['pty-1', 100, 30], 'localpty:resize')
  })

  it('subscriptions forward events and unsubscribe', () => {
    expectSubscription(api.localpty.onData, 'localpty:data', ['pty-1', 'out'])
    expectSubscription(api.localpty.onExit, 'localpty:exit', ['pty-1', 0])
  })
})

describe('runner', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.runner.run, [['s-1', 's-2'], 'uptime'], 'runner:run')
    expectInvoke(api.runner.cancel, ['run-1'], 'runner:cancel')
  })

  it('subscriptions forward events and unsubscribe', () => {
    expectSubscription(api.runner.onOutput, 'runner:output', ['run-1', 's-1', 'out'])
    expectSubscription(api.runner.onDone, 'runner:done', ['run-1', 's-1', 0, null])
  })
})

describe('docker', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.docker.connect, ['sess-1'], 'docker:connect')
    expectInvoke(api.docker.disconnect, ['d-1'], 'docker:disconnect')
    expectInvoke(api.docker.containers, ['d-1'], 'docker:containers')
    expectInvoke(api.docker.stats, ['d-1'], 'docker:stats')
    expectInvoke(api.docker.images, ['d-1'], 'docker:images')
    expectInvoke(api.docker.info, ['d-1'], 'docker:info')
    expectInvoke(api.docker.action, ['d-1', 'nginx', 'restart'], 'docker:action')
    expectInvoke(api.docker.logsStart, ['d-1', 'nginx', 200], 'docker:logsStart')
    expectInvoke(api.docker.logsStop, ['log-1'], 'docker:logsStop')
  })

  it('subscriptions forward events and unsubscribe', () => {
    expectSubscription(api.docker.onLogChunk, 'docker:logChunk', ['log-1', 'line'])
    expectSubscription(api.docker.onLogEnd, 'docker:logEnd', ['log-1', null])
  })
})

describe('settings', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.settings.get, [], 'settings:get')
    expectInvoke(api.settings.set, ['theme', 'dark'], 'settings:set')
    expectInvoke(api.settings.reset, [], 'settings:reset')
  })
})

describe('redis', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.redis.connect, [{ host: 'h' }], 'redis:connect')
    expectInvoke(api.redis.disconnect, ['r-1'], 'redis:disconnect')
    expectInvoke(api.redis.info, ['r-1'], 'redis:info')
    expectInvoke(api.redis.keys, ['r-1', 'user:*'], 'redis:keys')
    expectInvoke(api.redis.get, ['r-1', 'user:1'], 'redis:get')
    expectInvoke(api.redis.set, ['r-1', 'user:1', 'val', 60], 'redis:set')
    expectInvoke(api.redis.command, ['r-1', 'PING'], 'redis:command')
  })

  it('spreads variadic keys for del', () => {
    expectInvoke(api.redis.del, ['r-1', 'k1', 'k2', 'k3'], 'redis:del')
  })
})

describe('rdp', () => {
  it('forwards invoke calls', () => {
    const config = { host: 'h', username: 'u', password: 'p' }
    expectInvoke(api.rdp.connect, [config], 'rdp:connect')
    expectInvoke(api.rdp.disconnect, ['rdp-1'], 'rdp:disconnect')
  })

  it('subscriptions forward events and unsubscribe', () => {
    const pixels = new Uint8Array([1, 2, 3])
    expectSubscription(api.rdp.onFrame, 'rdp:frame', ['rdp-1', 800, 600, pixels])
    expectSubscription(api.rdp.onClose, 'rdp:closed', ['rdp-1', 'lost'])
  })
})

describe('tabs', () => {
  it('onCycle subscribes and unsubscribes', () => {
    expectSubscription(api.tabs.onCycle, 'tab:cycle', ['next'])
  })
})

describe('menu', () => {
  it.each([
    'new-connection',
    'open-connection',
    'new-local-terminal',
    'close-tab',
  ] as const)('on(%s) subscribes to the menu channel and unsubscribes', (action) => {
    expectSubscription((cb) => api.menu.on(action, cb), `menu:${action}`, ['ignored'], [])
  })
})

describe('updater', () => {
  it('forwards invoke calls', () => {
    expectInvoke(api.updater.version, [], 'updater:version')
    expectInvoke(api.updater.check, [], 'updater:check')
    expectInvoke(api.updater.download, [], 'updater:download')
    expectInvoke(api.updater.quitAndInstall, [], 'updater:quitAndInstall')
  })

  it('onStatus subscribes and unsubscribes', () => {
    expectSubscription(api.updater.onStatus, 'updater:status', [{ state: 'downloading' }])
  })
})
