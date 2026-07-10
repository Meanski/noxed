// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../../store'
import { installWindowApi, seedStore, makeTab } from '../../../__tests__/harness'

// Keep the dashboard shallow: the pod modals stream logs / open PTYs, which is
// out of scope here. Mocking sibling modules inside this test file is allowed.
vi.mock('../PodLogsModal', () => ({
  default: ({ pod, onClose }: { pod: string; onClose: () => void }) => (
    <div>
      stub-logs:{pod}
      <button onClick={onClose}>close-logs</button>
    </div>
  ),
}))
vi.mock('../PodExecModal', () => ({
  default: ({ pod }: { pod: string }) => <div>stub-exec:{pod}</div>,
}))
vi.mock('../ResourceDetailModal', () => ({
  default: ({ kind, name }: { kind: string; name: string }) => <div>stub-detail:{kind}:{name}</div>,
}))

import K8sDashboard from '../K8sDashboard'

const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()

const PODS = [
  { name: 'web-1', ready: '1/1', status: 'Running', restarts: 0, age: ago(30_000), node: 'node-a', containers: ['app'] },
  { name: 'web-2', ready: '1/1', status: 'Running', restarts: 3, age: ago(2 * 3600_000), node: 'node-b', containers: ['app'] },
  { name: 'crash-pod', ready: '0/1', status: 'CrashLoopBackOff', restarts: 7, age: ago(3 * 86_400_000), node: '', containers: [] },
]
const DEPLOYMENTS = [
  { name: 'api', ready: '2/2', available: 2, age: ago(600_000), replicas: 2 },
  { name: 'worker', ready: '1/2', available: 1, age: ago(600_000), replicas: 2 },
]
const JOBS = [
  { name: 'ok-job', completions: '1/1', active: 0, failed: 0, age: ago(60_000) },
  { name: 'active-job', completions: '0/1', active: 1, failed: 0, age: ago(60_000) },
  { name: 'failed-job', completions: '0/1', active: 0, failed: 2, age: ago(60_000) },
]

function k8sData() {
  return {
    namespaces: vi.fn().mockResolvedValue(['default', 'kube-system']),
    pods: vi.fn().mockResolvedValue(PODS),
    deployments: vi.fn().mockResolvedValue(DEPLOYMENTS),
    statefulsets: vi.fn().mockResolvedValue([{ name: 'db-ss', ready: '1/1', age: ago(60_000), replicas: 1 }]),
    daemonsets: vi.fn().mockResolvedValue([{ name: 'log-ds', desired: 2, ready: 1, available: 1, age: ago(60_000) }]),
    replicasets: vi.fn().mockResolvedValue([{ name: 'api-rs', desired: 1, ready: 1, age: ago(60_000) }]),
    jobs: vi.fn().mockResolvedValue(JOBS),
    cronjobs: vi.fn().mockResolvedValue([
      { name: 'backup-cj', schedule: '0 0 * * *', lastSchedule: null, active: 0, age: ago(60_000), suspended: true },
    ]),
    services: vi.fn().mockResolvedValue([
      { name: 'svc-web', type: 'LoadBalancer', clusterIP: '10.0.0.1', externalIP: '1.2.3.4', ports: '80/TCP,443/TCP', age: ago(60_000) },
      { name: 'svc-int', type: 'ClusterIP', clusterIP: '10.0.0.2', externalIP: '', ports: '', age: ago(60_000) },
    ]),
    ingresses: vi.fn().mockResolvedValue([
      { name: 'ing-a', hosts: 'app.example.com', address: '', ingressClass: 'nginx', age: ago(60_000) },
    ]),
    configmaps: vi.fn().mockResolvedValue([{ name: 'cm-app', keys: 2, age: ago(60_000) }]),
    secrets: vi.fn().mockResolvedValue([{ name: 'sec-tls', type: 'kubernetes.io/tls', keys: 1, age: ago(60_000) }]),
    nodes: vi.fn().mockResolvedValue([
      { name: 'node-a', status: 'Ready', roles: 'control-plane', cpu: '8', memory: '16Gi', kubeletVersion: 'v1.30.0', age: ago(86_400_000) },
      { name: 'node-b', status: 'NotReady', roles: 'worker', cpu: '4', memory: '8Gi', kubeletVersion: 'v1.30.0', age: ago(86_400_000) },
    ]),
    events: vi.fn().mockResolvedValue([
      { name: 'ev-1', type: 'Warning', reason: 'BackOff', object: 'pod/web-1', message: 'restarting container', count: 4, age: ago(60_000) },
      { name: 'ev-2', type: 'Normal', reason: 'Pulled', object: 'pod/web-2', message: 'image pulled', count: 1, age: ago(60_000) },
    ]),
    portForwardStart: vi.fn().mockResolvedValue({ id: 'pf-1', localPort: 50123 }),
    servicePortForwardStart: vi.fn().mockResolvedValue({ id: 'pf-2', localPort: 50456 }),
    portForwardList: vi.fn().mockResolvedValue([]),
  }
}

function setup(
  k8sOverrides: Record<string, unknown> = {},
  props: Partial<React.ComponentProps<typeof K8sDashboard>> = {},
) {
  const api = installWindowApi({ k8s: { ...k8sData(), ...k8sOverrides } })
  seedStore({ sessions: [], tabs: [], activeTabId: null })
  const utils = render(<K8sDashboard context="test-ctx" {...props} />)
  return { api, ...utils }
}

async function podsLoaded() {
  await waitFor(() => expect(screen.getByText('web-1')).toBeTruthy())
}

beforeEach(() => {
  cleanup()
})

describe('K8sDashboard — pods and connection state', () => {
  it('loads pods for the default namespace and shows connected state', async () => {
    const { api } = setup()
    await podsLoaded()
    expect(api.k8s.pods).toHaveBeenCalledWith('test-ctx', 'default', undefined)
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0)
    expect(screen.getByText('Namespace: default · 3 pods')).toBeTruthy()
    // restart counts across color thresholds
    expect(screen.getAllByText('0').length).toBeGreaterThan(0)
    expect(screen.getAllByText('3').length).toBeGreaterThan(0)
    expect(screen.getAllByText('7').length).toBeGreaterThan(0)
    // age buckets: seconds / hours / days
    expect(screen.getByText('30s')).toBeTruthy()
    expect(screen.getByText('2h')).toBeTruthy()
    expect(screen.getByText('3d')).toBeTruthy()
  })

  it('marks the owning tab connected once loaded', async () => {
    const tab = makeTab({ view: 'k8s', k8sContext: 'test-ctx', status: 'connecting' })
    installWindowApi({ k8s: k8sData() })
    seedStore({ sessions: [], tabs: [tab], activeTabId: tab.id })
    render(<K8sDashboard context="test-ctx" tabId={tab.id} />)
    await podsLoaded()
    await waitFor(() => expect(useAppStore.getState().tabs[0].status).toBe('connected'))
  })

  it('switches namespace and refetches', async () => {
    const { api, container } = setup()
    await podsLoaded()
    fireEvent.change(container.querySelector('select')!, { target: { value: 'kube-system' } })
    await waitFor(() => expect(api.k8s.pods).toHaveBeenCalledWith('test-ctx', 'kube-system', undefined))
  })

  it('filters rows by name', async () => {
    setup()
    await podsLoaded()
    fireEvent.change(screen.getByPlaceholderText('Filter pods…'), { target: { value: 'crash' } })
    expect(screen.queryByText('web-1')).toBeNull()
    expect(screen.getByText('crash-pod')).toBeTruthy()
  })

  it('shows an error banner and error tab status when the fetch fails, then retries', async () => {
    const tab = makeTab({ view: 'k8s', k8sContext: 'test-ctx' })
    const pods = vi.fn().mockRejectedValueOnce(new Error('cluster unreachable')).mockResolvedValue(PODS)
    installWindowApi({ k8s: { ...k8sData(), pods } })
    seedStore({ sessions: [], tabs: [tab], activeTabId: tab.id })
    render(<K8sDashboard context="test-ctx" tabId={tab.id} />)
    await waitFor(() => expect(screen.getByText('Cluster request failed')).toBeTruthy())
    expect(screen.getByText('cluster unreachable')).toBeTruthy()
    expect(screen.getAllByText('Connection error').length).toBeGreaterThan(0)
    // The tab status is written by a passive useEffect, which can flush after
    // the banner's commit — poll instead of asserting synchronously.
    await waitFor(() => expect(useAppStore.getState().tabs[0].status).toBe('error'))
    fireEvent.click(screen.getByText('Retry'))
    await podsLoaded()
  })

  it('shows the empty state when there are no resources', async () => {
    setup({ pods: vi.fn().mockResolvedValue([]) })
    await waitFor(() => expect(screen.getByText('No pods found')).toBeTruthy())
    expect(screen.getByText('in this namespace')).toBeTruthy()
  })

  it('surfaces namespace loading failures', async () => {
    setup({ namespaces: vi.fn().mockRejectedValue(new Error('forbidden')) })
    await waitFor(() => expect(screen.getByText('Cluster request failed')).toBeTruthy())
  })
})

describe('K8sDashboard — resource kind switching', () => {
  it('renders deployments with health coloring and actions', async () => {
    const { api } = setup()
    await podsLoaded()
    fireEvent.click(screen.getByText('Deployments'))
    await waitFor(() => expect(screen.getByText('api')).toBeTruthy())
    expect(api.k8s.deployments).toHaveBeenCalled()
    expect(screen.getByText('2/2')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
    // restart rollout
    fireEvent.click(screen.getAllByTitle('Restart rollout')[0])
    await waitFor(() =>
      expect(api.k8s.restartDeployment).toHaveBeenCalledWith('test-ctx', 'default', 'api', undefined),
    )
  })

  it('scales a deployment through the scale modal', async () => {
    const { api } = setup()
    await podsLoaded()
    fireEvent.click(screen.getByText('Deployments'))
    await waitFor(() => expect(screen.getByText('api')).toBeTruthy())
    fireEvent.click(screen.getAllByTitle('Scale')[0])
    expect(screen.getByText('Scale Deployment')).toBeTruthy()
    // + / − and direct input. The plus button is icon-only (no title/aria-label),
    // so anchor on the replica input it renders immediately after.
    const input = screen.getByDisplayValue('2') as HTMLInputElement
    fireEvent.click(input.nextElementSibling as HTMLElement)
    expect(input.value).toBe('3')
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.click(screen.getByText('Scale to 5'))
    await waitFor(() =>
      expect(api.k8s.scaleDeployment).toHaveBeenCalledWith('test-ctx', 'default', 'api', 5, undefined),
    )
  })

  it('cancels the scale modal', async () => {
    setup()
    await podsLoaded()
    fireEvent.click(screen.getByText('Deployments'))
    await waitFor(() => expect(screen.getByText('api')).toBeTruthy())
    fireEvent.click(screen.getAllByTitle('Scale')[0])
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Scale Deployment')).toBeNull()
  })

  it('renders statefulsets, daemonsets and replicasets', async () => {
    setup()
    await podsLoaded()
    fireEvent.click(screen.getByText('StatefulSets'))
    await waitFor(() => expect(screen.getByText('db-ss')).toBeTruthy())
    fireEvent.click(screen.getByText('DaemonSets'))
    await waitFor(() => expect(screen.getByText('log-ds')).toBeTruthy())
    fireEvent.click(screen.getByText('ReplicaSets'))
    await waitFor(() => expect(screen.getByText('api-rs')).toBeTruthy())
  })

  it('renders jobs with dot colors for ok/active/failed and cronjobs', async () => {
    setup()
    await podsLoaded()
    fireEvent.click(screen.getByText('Jobs'))
    await waitFor(() => expect(screen.getByText('ok-job')).toBeTruthy())
    expect(screen.getByText('active-job')).toBeTruthy()
    expect(screen.getByText('failed-job')).toBeTruthy()
    fireEvent.click(screen.getByText('CronJobs'))
    await waitFor(() => expect(screen.getByText('backup-cj')).toBeTruthy())
    expect(screen.getByText('0 0 * * *')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy() // null lastSchedule
  })

  it('renders services with type badges and starts a service port forward', async () => {
    const { api } = setup()
    await podsLoaded()
    fireEvent.click(screen.getByText('Services'))
    await waitFor(() => expect(screen.getByText('svc-web')).toBeTruthy())
    expect(screen.getByText('LoadBalancer')).toBeTruthy()
    expect(screen.getByText('ClusterIP')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Port forward'))
    await waitFor(() =>
      expect(api.k8s.servicePortForwardStart).toHaveBeenCalledWith('test-ctx', 'default', 'svc-web', 80, 0, undefined),
    )
    await waitFor(() => expect(screen.getByText('Port Forwards')).toBeTruthy())
    expect(screen.getByText(/:50456 → svc-web:80/)).toBeTruthy()
  })

  it('renders ingresses, configmaps and secrets', async () => {
    setup()
    await podsLoaded()
    fireEvent.click(screen.getByText('Ingresses'))
    await waitFor(() => expect(screen.getByText('ing-a')).toBeTruthy())
    expect(screen.getByText('Pending')).toBeTruthy() // no address
    fireEvent.click(screen.getByText('ConfigMaps'))
    await waitFor(() => expect(screen.getByText('cm-app')).toBeTruthy())
    expect(screen.getByText('2 keys')).toBeTruthy()
    fireEvent.click(screen.getByText('Secrets'))
    await waitFor(() => expect(screen.getByText('sec-tls')).toBeTruthy())
    expect(screen.getByText('1 key')).toBeTruthy()
  })

  it('renders nodes (behind the collapsed Infrastructure section) and events', async () => {
    const { api } = setup()
    await podsLoaded()
    fireEvent.click(screen.getByText('Infrastructure')) // collapsed by default
    fireEvent.click(screen.getByText('Nodes'))
    await waitFor(() => expect(screen.getByText('node-a')).toBeTruthy())
    expect(api.k8s.nodes).toHaveBeenCalledWith('test-ctx', undefined)
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByText('NotReady')).toBeTruthy()
    expect(screen.getAllByText('2 nodes').length).toBeGreaterThan(0) // subtitle + status bar
    fireEvent.click(screen.getByText('Events'))
    await waitFor(() => expect(screen.getByText('BackOff')).toBeTruthy())
    expect(screen.getByText('Warning')).toBeTruthy()
    expect(screen.getByText('restarting container')).toBeTruthy()
  })

  it('collapses and reopens the Workloads section', async () => {
    setup()
    await podsLoaded()
    fireEvent.click(screen.getByText('Workloads'))
    expect(screen.queryByText('Deployments')).toBeNull()
    fireEvent.click(screen.getByText('Workloads'))
    expect(screen.getByText('Deployments')).toBeTruthy()
  })
})

describe('K8sDashboard — pod actions', () => {
  it('opens logs and exec modals for a pod', async () => {
    setup()
    await podsLoaded()
    fireEvent.click(screen.getAllByTitle('View Logs')[0])
    expect(screen.getByText('stub-logs:web-1')).toBeTruthy()
    fireEvent.click(screen.getByText('close-logs'))
    expect(screen.queryByText('stub-logs:web-1')).toBeNull()
    fireEvent.click(screen.getAllByTitle('Shell')[0])
    expect(screen.getByText('stub-exec:web-1')).toBeTruthy()
  })

  it('opens the resource detail modal when a row is clicked', async () => {
    setup()
    await podsLoaded()
    fireEvent.click(screen.getByText('web-1'))
    expect(screen.getByText('stub-detail:pod:web-1')).toBeTruthy()
  })

  it('deletes a pod after confirming the modal', async () => {
    const { api } = setup()
    await podsLoaded()
    fireEvent.click(screen.getAllByTitle('Delete')[0])
    expect(screen.getByText('Delete Pod')).toBeTruthy()
    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() =>
      expect(api.k8s.deletePod).toHaveBeenCalledWith('test-ctx', 'default', 'web-1', undefined),
    )
    await waitFor(() => expect(screen.queryByText('web-1')).toBeNull())
  })

  it('cancels pod deletion', async () => {
    const { api } = setup()
    await podsLoaded()
    fireEvent.click(screen.getAllByTitle('Delete')[0])
    fireEvent.click(screen.getByText('Cancel'))
    expect(api.k8s.deletePod).not.toHaveBeenCalled()
    expect(screen.getByText('web-1')).toBeTruthy()
  })

  it('starts a pod port forward via the prompt and stops it', async () => {
    vi.stubGlobal('prompt', vi.fn(() => '8080'))
    const { api } = setup()
    await podsLoaded()
    fireEvent.click(screen.getAllByTitle('Port forward')[0])
    await waitFor(() =>
      expect(api.k8s.portForwardStart).toHaveBeenCalledWith('test-ctx', 'default', 'web-1', 8080, 0, undefined),
    )
    await waitFor(() => expect(screen.getByText(/:50123 → web-1:8080/)).toBeTruthy())
    expect(screen.getByText('1 port forward active')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Stop'))
    await waitFor(() => expect(api.k8s.portForwardStop).toHaveBeenCalledWith('pf-1'))
    await waitFor(() => expect(screen.queryByText('Port Forwards')).toBeNull())
    vi.unstubAllGlobals()
  })

  it('ignores invalid port forward input', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'not-a-port'))
    const { api } = setup()
    await podsLoaded()
    fireEvent.click(screen.getAllByTitle('Port forward')[0])
    expect(api.k8s.portForwardStart).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('rehydrates port forwards for this context from the main process', async () => {
    setup({
      portForwardList: vi.fn().mockResolvedValue([
        { id: 'pf-a', context: 'test-ctx', localPort: 40001, podName: 'web-1', targetPort: 80 },
        { id: 'pf-b', context: 'other-ctx', localPort: 40002, podName: 'zzz', targetPort: 81 },
      ]),
    })
    await podsLoaded()
    await waitFor(() => expect(screen.getByText(/:40001 → web-1:80/)).toBeTruthy())
    expect(screen.queryByText(/:40002/)).toBeNull()
  })
})
