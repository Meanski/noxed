import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Boxes, Activity, ChevronDown, ChevronRight,
  Search, RefreshCw, FileText, Terminal, Trash2, AlertTriangle, Clock,
  RotateCcw, Minus, Plus, ArrowUpDown, ExternalLink, Server,
} from 'lucide-react'
import PodLogsModal from './PodLogsModal'
import PodExecModal from './PodExecModal'
import ResourceDetailModal from './ResourceDetailModal'
import { formatK8sMemory } from '../../lib/format'
import { podStatusColor } from '../../lib/colors'
import { useAppStore } from '../../store'

type ResourceKind =
  | 'pods' | 'deployments' | 'statefulsets' | 'daemonsets' | 'replicasets' | 'jobs' | 'cronjobs'
  | 'services' | 'ingresses'
  | 'configmaps' | 'secrets'
  | 'nodes' | 'events'

interface PortForward { id: string; localPort: number; podName: string; targetPort: number; service?: string }

interface LogsTarget { pod: string; containers: string[] }
interface ExecTarget { pod: string; containers: string[] }
interface DetailTarget { kind: string; name: string } // singular kind for IPC
interface ScaleTarget { name: string; current: number }
interface DeleteTarget { kind: ResourceKind; name: string }

function restartsColor(restarts: number): string {
  if (restarts > 5) return '#EF4444'
  if (restarts > 0) return '#F59E0B'
  return 'var(--nox-text-2)'
}

function jobDotColor(j: { failed: number; active: number }): string {
  if (j.failed > 0) return '#EF4444'
  if (j.active > 0) return '#F59E0B'
  return '#10B981'
}

function connStateOf(error: string | null, loading: boolean, empty: boolean): { label: string; color: string } {
  if (error) return { label: 'Connection error', color: '#EF4444' }
  if (loading && empty) return { label: 'Loading…', color: '#F59E0B' }
  return { label: 'Connected', color: '#10B981' }
}

export default function K8sDashboard({ context, kubeconfigPath, tabId }: Readonly<{ context: string; kubeconfigPath?: string; tabId?: string }>) {
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [namespace, setNamespace] = useState('default')
  const [kind, setKind] = useState<ResourceKind>('pods')
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [filter, setFilter] = useState('')
  const [workloadsOpen, setWorkloadsOpen] = useState(true)
  const [portForwards, setPortForwards] = useState<PortForward[]>([])

  // Stale-fetch guard: each fetch gets an ID; results from superseded fetches are discarded
  const fetchSeqRef = useRef(0)

  // Modals
  const [logsTarget, setLogsTarget] = useState<LogsTarget | null>(null)
  const [execTarget, setExecTarget] = useState<ExecTarget | null>(null)
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null)
  const [scaleTarget, setScaleTarget] = useState<ScaleTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)

  useEffect(() => {
    window.api.k8s.namespaces(context, kubeconfigPath)
      .then((ns: string[]) => {
        setNamespaces(ns)
        if (ns.includes('default')) setNamespace('default')
        else if (ns.length > 0) setNamespace(ns[0])
      })
      .catch((err: any) => {
        setError(err?.message ?? 'Failed to load namespaces')
      })
  }, [context, kubeconfigPath])

  // Port forwards live in the main process; rehydrate so they survive tab remounts
  useEffect(() => {
    window.api.k8s.portForwardList()
      .then(list => setPortForwards(list.filter(pf => pf.context === context)))
      .catch((err: any) => {
        console.error('[k8s] port forward list failed:', err?.message ?? err)
      })
  }, [context])

  const refresh = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    setError(null)
    try {
      const rows = await fetchKind(context, namespace, kind, kubeconfigPath)
      if (seq !== fetchSeqRef.current) return // stale — a newer fetch is already in flight
      setData(rows)
      setLastRefresh(new Date())
    } catch (err: any) {
      if (seq !== fetchSeqRef.current) return
      setError(err?.message ?? 'Failed to fetch resources')
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false)
    }
  }, [context, namespace, kind, kubeconfigPath])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { const id = setInterval(refresh, 30_000); return () => clearInterval(id) }, [refresh])

  function switchKind(k: ResourceKind) {
    setData([])   // clear immediately so stale rows don't flash
    setKind(k)
    setFilter('')
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleDeletePod(name: string) {
    try {
      await window.api.k8s.deletePod(context, namespace, name, kubeconfigPath)
      setData(prev => prev.filter(r => r.name !== name))
    } catch (err: any) {
      setError(err?.message ?? 'Delete failed')
    }
    setDeleteTarget(null)
  }

  async function handleScale(name: string, replicas: number) {
    try {
      await window.api.k8s.scaleDeployment(context, namespace, name, replicas, kubeconfigPath)
      await refresh()
    } catch (err: any) {
      setError(err?.message ?? 'Scale failed')
    }
    setScaleTarget(null)
  }

  async function handleRestart(name: string) {
    try {
      await window.api.k8s.restartDeployment(context, namespace, name, kubeconfigPath)
      setTimeout(refresh, 2000)
    } catch (err: any) {
      setError(err?.message ?? 'Restart failed')
    }
  }

  async function handlePortForward(podName: string, targetPort: number) {
    try {
      const result = await window.api.k8s.portForwardStart(context, namespace, podName, targetPort, 0, kubeconfigPath)
      setPortForwards(prev => [...prev, { id: result.id, localPort: result.localPort, podName, targetPort }])
    } catch (err: any) {
      setError(err?.message ?? 'Port forward failed')
    }
  }

  async function handleServicePortForward(serviceName: string, servicePort: number) {
    try {
      const result = await window.api.k8s.servicePortForwardStart(context, namespace, serviceName, servicePort, 0, kubeconfigPath)
      setPortForwards(prev => [...prev, { id: result.id, localPort: result.localPort, podName: serviceName, targetPort: servicePort, service: serviceName }])
    } catch (err: any) {
      setError(err?.message ?? 'Port forward failed')
    }
  }

  async function stopPortForward(id: string) {
    await window.api.k8s.portForwardStop(id)
    setPortForwards(prev => prev.filter(pf => pf.id !== id))
  }

  // ── Filtered data ─────────────────────────────────────────────────────────

  const filtered = filter
    ? data.filter(r => r.name?.toLowerCase().includes(filter.toLowerCase()))
    : data

  const count = data.length
  const connState = connStateOf(error, loading, data.length === 0)
  const countFor = (k: ResourceKind) => (kind === k ? data.length : undefined)

  // Keep the tab-bar dot honest: a failing cluster should not show as connected
  const updateTab = useAppStore(s => s.updateTab)
  useEffect(() => {
    if (tabId) updateTab(tabId, { status: error ? 'error' : 'connected' })
  }, [tabId, !!error, updateTab])

  return (
    <div className="h-full w-full flex flex-col overflow-hidden" style={{ background: 'var(--nox-bg)' }}>
      {/* Top bar */}
      <div
        className="h-11 flex items-center px-4 gap-3 flex-shrink-0"
        style={{ background: 'var(--nox-shell)', borderBottom: '1px solid var(--nox-border)' }}
      >
        <div
          className="flex items-center gap-1.5 flex-1 rounded-md px-2.5 py-1.5"
          style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}
        >
          <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={`Filter ${kind}…`}
            className="flex-1 bg-transparent outline-none font-['Inter'] text-[12px]"
            style={{ color: 'var(--nox-text)' }}
          />
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="p-1.5 rounded-md transition-colors disabled:opacity-40"
          style={{ color: 'var(--nox-text-2)' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Sidebar */}
        <aside
          className="w-[220px] min-w-[220px] flex flex-col overflow-y-auto flex-shrink-0"
          style={{ background: 'var(--nox-shell)', borderRight: '1px solid var(--nox-border)' }}
        >
          {/* Cluster identity */}
          <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid var(--nox-border)' }}>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-md bg-[#8B5CF6] flex items-center justify-center flex-shrink-0">
                <Boxes className="w-4 h-4 text-white" />
              </div>
              <div className="min-w-0">
                <div className="font-['Plus_Jakarta_Sans'] font-semibold text-[12.5px] truncate" style={{ color: 'var(--nox-text)' }}>
                  {context}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: connState.color }} />
                  <span className="font-['Inter'] text-[10px]" style={{ color: 'var(--nox-text-3)' }}>{connState.label}</span>
                </div>
              </div>
            </div>
            <select
              value={namespace}
              onChange={e => setNamespace(e.target.value)}
              className="w-full rounded-md px-2 py-1.5 font-['Inter'] text-[12px] focus:outline-none focus:ring-1 focus:ring-[#8B5CF6]"
              style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
            >
              {namespaces.length === 0
                ? <option value={namespace}>{namespace}</option>
                : namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)
              }
            </select>
          </div>

          {/* Nav */}
          <nav className="flex-1 px-2 py-3 space-y-0.5">
            <NavItem icon={<Activity className="w-3.5 h-3.5" />} label="Events"
              active={kind === 'events'} onClick={() => switchKind('events')} />

            {/* Workloads */}
            <SideSection label="Workloads" open={workloadsOpen} onToggle={() => setWorkloadsOpen(o => !o)}>
              <NavItem dot label="Pods"
                count={countFor('pods')}
                active={kind === 'pods'} onClick={() => switchKind('pods')} />
              <NavItem dot label="Deployments"
                count={countFor('deployments')}
                active={kind === 'deployments'} onClick={() => switchKind('deployments')} />
              <NavItem dot label="StatefulSets"
                count={countFor('statefulsets')}
                active={kind === 'statefulsets'} onClick={() => switchKind('statefulsets')} />
              <NavItem dot label="DaemonSets"
                count={countFor('daemonsets')}
                active={kind === 'daemonsets'} onClick={() => switchKind('daemonsets')} />
              <NavItem dot label="ReplicaSets"
                count={countFor('replicasets')}
                active={kind === 'replicasets'} onClick={() => switchKind('replicasets')} />
              <NavItem dot label="Jobs"
                count={countFor('jobs')}
                active={kind === 'jobs'} onClick={() => switchKind('jobs')} />
              <NavItem dot label="CronJobs"
                count={countFor('cronjobs')}
                active={kind === 'cronjobs'} onClick={() => switchKind('cronjobs')} />
            </SideSection>

            <SideSection label="Network">
              <NavItem dot label="Services"
                count={countFor('services')}
                active={kind === 'services'} onClick={() => switchKind('services')} />
              <NavItem dot label="Ingresses"
                count={countFor('ingresses')}
                active={kind === 'ingresses'} onClick={() => switchKind('ingresses')} />
            </SideSection>

            <SideSection label="Config">
              <NavItem dot label="ConfigMaps"
                count={countFor('configmaps')}
                active={kind === 'configmaps'} onClick={() => switchKind('configmaps')} />
              <NavItem dot label="Secrets"
                count={countFor('secrets')}
                active={kind === 'secrets'} onClick={() => switchKind('secrets')} />
            </SideSection>

            <SideSection label="Infrastructure" collapsed>
              <NavItem icon={<Server className="w-3.5 h-3.5" />} label="Nodes"
                count={countFor('nodes')}
                active={kind === 'nodes'} onClick={() => switchKind('nodes')} />
            </SideSection>
          </nav>

          {/* Active port forwards */}
          {portForwards.length > 0 && (
            <div style={{ borderTop: '1px solid var(--nox-border)' }} className="px-3 py-2">
              <p className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold mb-1.5" style={{ color: 'var(--nox-text-3)' }}>
                Port Forwards
              </p>
              {portForwards.map(pf => (
                <div key={pf.id} className="flex items-center justify-between py-1 gap-1">
                  <span
                    className="font-['JetBrains_Mono'] text-[10.5px] truncate"
                    title={`localhost:${pf.localPort} → ${pf.service ?? pf.podName}:${pf.targetPort}`}
                    style={{ color: 'var(--nox-text-2)' }}
                  >
                    :{pf.localPort} → {pf.service ?? pf.podName}:{pf.targetPort}
                  </span>
                  <button
                    onClick={() => stopPortForward(pf.id)}
                    className="text-[#EF4444] hover:opacity-80 flex-shrink-0"
                    title="Stop"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div
            className="flex items-center justify-between px-5 py-3.5 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--nox-border)' }}
          >
            <div>
              <h2 className="font-['Plus_Jakarta_Sans'] font-semibold text-[16px]" style={{ color: 'var(--nox-text)' }}>
                {kindTitle(kind)}
              </h2>
              <p className="font-['Inter'] text-[12px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
                {kind === 'nodes' ? `${data.length} nodes` : `Namespace: ${namespace} · ${data.length} ${kind}`}
              </p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {error ? (
              <ErrorBanner message={error} onRetry={refresh} />
            ) : (
              <ResourceTable
                kind={kind}
                rows={filtered}
                loading={loading}
                namespace={namespace}
                onLogs={t => setLogsTarget(t)}
                onExec={t => setExecTarget(t)}
                onDetail={t => setDetailTarget(t)}
                onScale={t => setScaleTarget(t)}
                onDelete={t => setDeleteTarget(t)}
                onRestart={handleRestart}
                onPortForward={handlePortForward}
                onServicePortForward={handleServicePortForward}
              />
            )}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div
        className="h-7 flex items-center px-4 gap-4 flex-shrink-0"
        style={{ background: 'var(--nox-shell)', borderTop: '1px solid var(--nox-border)' }}
      >
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: connState.color }} />
          <span className="font-['Inter'] text-[10.5px]" style={{ color: 'var(--nox-text-2)' }}>{connState.label}</span>
        </div>
        <span style={{ color: 'var(--nox-border)' }}>|</span>
        <span className="font-['Inter'] text-[10.5px] truncate" style={{ color: 'var(--nox-text-2)' }}>
          {context}
        </span>
        <span style={{ color: 'var(--nox-border)' }}>|</span>
        <span className="font-['Inter'] text-[10.5px]" style={{ color: 'var(--nox-text-2)' }}>
          {count} {kind}
        </span>
        {portForwards.length > 0 && (
          <>
            <span style={{ color: 'var(--nox-border)' }}>|</span>
            <span className="font-['Inter'] text-[10.5px]" style={{ color: '#8B5CF6' }}>
              {portForwards.length} port forward{portForwards.length > 1 ? 's' : ''} active
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Clock className="w-3 h-3" style={{ color: 'var(--nox-text-3)' }} />
          <span className="font-['Inter'] text-[10.5px]" style={{ color: 'var(--nox-text-3)' }}>
            {formatTime(lastRefresh)}
          </span>
        </div>
      </div>

      {/* Modals */}
      {logsTarget && (
        <PodLogsModal
          context={context}
          namespace={namespace}
          pod={logsTarget.pod}
          containers={logsTarget.containers}
          kubeconfigPath={kubeconfigPath}
          onClose={() => setLogsTarget(null)}
        />
      )}
      {execTarget && (
        <PodExecModal
          context={context}
          namespace={namespace}
          pod={execTarget.pod}
          containers={execTarget.containers}
          kubeconfigPath={kubeconfigPath}
          onClose={() => setExecTarget(null)}
        />
      )}
      {detailTarget && (
        <ResourceDetailModal
          context={context}
          namespace={namespace}
          kind={detailTarget.kind}
          name={detailTarget.name}
          kubeconfigPath={kubeconfigPath}
          onClose={() => setDetailTarget(null)}
        />
      )}
      {scaleTarget && (
        <ScaleModal
          name={scaleTarget.name}
          current={scaleTarget.current}
          onConfirm={r => handleScale(scaleTarget.name, r)}
          onClose={() => setScaleTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteModal
          kind={deleteTarget.kind}
          name={deleteTarget.name}
          onConfirm={() => {
            if (deleteTarget.kind === 'pods') handleDeletePod(deleteTarget.name)
            else setDeleteTarget(null)
          }}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}

// ── Data fetcher ──────────────────────────────────────────────────────────────

async function fetchKind(context: string, namespace: string, kind: ResourceKind, kubeconfigPath?: string): Promise<any[]> {
  const api = window.api.k8s
  switch (kind) {
    case 'pods':         return api.pods(context, namespace, kubeconfigPath)
    case 'deployments':  return api.deployments(context, namespace, kubeconfigPath)
    case 'statefulsets': return api.statefulsets(context, namespace, kubeconfigPath)
    case 'daemonsets':   return api.daemonsets(context, namespace, kubeconfigPath)
    case 'replicasets':  return api.replicasets(context, namespace, kubeconfigPath)
    case 'jobs':         return api.jobs(context, namespace, kubeconfigPath)
    case 'cronjobs':     return api.cronjobs(context, namespace, kubeconfigPath)
    case 'services':     return api.services(context, namespace, kubeconfigPath)
    case 'ingresses':    return api.ingresses(context, namespace, kubeconfigPath)
    case 'configmaps':   return api.configmaps(context, namespace, kubeconfigPath)
    case 'secrets':      return api.secrets(context, namespace, kubeconfigPath)
    case 'nodes':        return api.nodes(context, kubeconfigPath)
    case 'events':       return api.events(context, namespace, kubeconfigPath)
    default:             return []
  }
}

// ── Resource table dispatcher ─────────────────────────────────────────────────

interface TableProps {
  kind: ResourceKind
  rows: any[]
  loading: boolean
  namespace: string
  onLogs: (t: LogsTarget) => void
  onExec: (t: ExecTarget) => void
  onDetail: (t: DetailTarget) => void
  onScale: (t: ScaleTarget) => void
  onDelete: (t: DeleteTarget) => void
  onRestart: (name: string) => void
  onPortForward: (podName: string, port: number) => void
  onServicePortForward: (serviceName: string, port: number) => void
}

function ResourceTable(props: TableProps) {
  const { kind, rows, loading } = props
  if (loading && rows.length === 0) return <TableSkeleton cols={6} />
  if (!loading && rows.length === 0) return <EmptyState kind={kind} />

  switch (kind) {
    case 'pods':         return <PodsTable {...props} />
    case 'deployments':  return <DeploymentsTable {...props} />
    case 'statefulsets': return <StatefulSetsTable {...props} />
    case 'daemonsets':   return <DaemonSetsTable {...props} />
    case 'replicasets':  return <ReplicaSetsTable {...props} />
    case 'jobs':         return <JobsTable {...props} />
    case 'cronjobs':     return <CronJobsTable {...props} />
    case 'services':     return <ServicesTable {...props} />
    case 'ingresses':    return <IngressesTable {...props} />
    case 'configmaps':   return <ConfigMapsTable {...props} />
    case 'secrets':      return <SecretsTable {...props} />
    case 'nodes':        return <NodesTable {...props} />
    case 'events':       return <EventsTable {...props} />
    default:             return null
  }
}

// ── Pods ──────────────────────────────────────────────────────────────────────

function PodsTable({ rows, onLogs, onExec, onDetail, onDelete, onPortForward }: Readonly<Pick<TableProps, 'rows' | 'onLogs' | 'onExec' | 'onDetail' | 'onDelete' | 'onPortForward'>>) {
  function promptPortForward(podName: string) {
    const raw = prompt('Container port to forward:')
    if (!raw) return
    const port = Number.parseInt(raw, 10)
    if (!Number.isNaN(port) && port >= 1 && port <= 65535) onPortForward(podName, port)
  }
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Ready</Th><Th>Status</Th><Th>Restarts</Th><Th>Age</Th><Th>Node</Th><Th align="right">Actions</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(pod => (
          <Tr key={pod.name} onClick={() => onDetail({ kind: 'pod', name: pod.name })}>
            <Td>
              <div className="flex items-center gap-2">
                <div className="w-[3px] h-5 rounded-full flex-shrink-0" style={{ background: podStatusColor(pod.status) }} />
                <span className="font-['JetBrains_Mono'] text-[12px]" style={{ color: 'var(--nox-text)' }}>{pod.name}</span>
              </div>
            </Td>
            <Td><Mono>{pod.ready}</Mono></Td>
            <Td><PodStatusBadge status={pod.status} /></Td>
            <Td>
              <span className="font-['JetBrains_Mono'] text-[12px]"
                style={{ color: restartsColor(pod.restarts) }}>
                {pod.restarts}
              </span>
            </Td>
            <Td><AgeCell age={pod.age} /></Td>
            <Td><span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-2)' }}>{pod.node || '—'}</span></Td>
            <Td align="right" stopPropagation>
              <div className="flex items-center justify-end gap-1">
                <ActionBtn title="View Logs" onClick={() => onLogs({ pod: pod.name, containers: pod.containers ?? [] })}>
                  <FileText className="w-3.5 h-3.5" />
                </ActionBtn>
                <ActionBtn title="Shell" onClick={() => onExec({ pod: pod.name, containers: pod.containers ?? [] })}>
                  <Terminal className="w-3.5 h-3.5" />
                </ActionBtn>
                <ActionBtn title="Port forward" onClick={() => promptPortForward(pod.name)}>
                  <ExternalLink className="w-3.5 h-3.5" />
                </ActionBtn>
                <ActionBtn title="Delete" danger onClick={() => onDelete({ kind: 'pods', name: pod.name })}>
                  <Trash2 className="w-3.5 h-3.5" />
                </ActionBtn>
              </div>
            </Td>
          </Tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Deployments ───────────────────────────────────────────────────────────────

function DeploymentsTable({ rows, onDetail, onScale, onRestart }: Readonly<Pick<TableProps, 'rows' | 'onDetail' | 'onScale' | 'onRestart'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Ready</Th><Th>Available</Th><Th>Age</Th><Th align="right">Actions</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(d => {
          const [ready, total] = d.ready.split('/').map(Number)
          const healthy = !Number.isNaN(ready) && !Number.isNaN(total) && ready === total
          return (
            <Tr key={d.name} onClick={() => onDetail({ kind: 'deployment', name: d.name })}>
              <Td>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: healthy ? '#10B981' : '#F59E0B' }} />
                  <span className="font-['JetBrains_Mono'] text-[12px]" style={{ color: 'var(--nox-text)' }}>{d.name}</span>
                </div>
              </Td>
              <Td><span className="font-['JetBrains_Mono'] text-[12px]" style={{ color: healthy ? '#10B981' : '#F59E0B' }}>{d.ready}</span></Td>
              <Td><Mono color="var(--nox-text-2)">{d.available}</Mono></Td>
              <Td><AgeCell age={d.age} /></Td>
              <Td align="right" stopPropagation>
                <div className="flex items-center justify-end gap-1">
                  <ActionBtn title="Scale" onClick={() => onScale({ name: d.name, current: d.replicas ?? 0 })}>
                    <ArrowUpDown className="w-3.5 h-3.5" />
                  </ActionBtn>
                  <ActionBtn title="Restart rollout" onClick={() => onRestart(d.name)}>
                    <RotateCcw className="w-3.5 h-3.5" />
                  </ActionBtn>
                </div>
              </Td>
            </Tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── StatefulSets ──────────────────────────────────────────────────────────────

function StatefulSetsTable({ rows, onDetail, onScale }: Readonly<Pick<TableProps, 'rows' | 'onDetail' | 'onScale'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Ready</Th><Th>Age</Th><Th align="right">Actions</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(s => {
          const [ready, total] = s.ready.split('/').map(Number)
          const healthy = !Number.isNaN(ready) && !Number.isNaN(total) && ready >= total
          return (
            <Tr key={s.name} onClick={() => onDetail({ kind: 'statefulset', name: s.name })}>
              <Td>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: healthy ? '#10B981' : '#F59E0B' }} />
                  <Mono>{s.name}</Mono>
                </div>
              </Td>
              <Td><span className="font-['JetBrains_Mono'] text-[12px]" style={{ color: healthy ? '#10B981' : '#F59E0B' }}>{s.ready}</span></Td>
              <Td><AgeCell age={s.age} /></Td>
              <Td align="right" stopPropagation>
                <ActionBtn title="Scale" onClick={() => onScale({ name: s.name, current: s.replicas ?? 0 })}>
                  <ArrowUpDown className="w-3.5 h-3.5" />
                </ActionBtn>
              </Td>
            </Tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── DaemonSets ────────────────────────────────────────────────────────────────

function DaemonSetsTable({ rows, onDetail }: Readonly<Pick<TableProps, 'rows' | 'onDetail'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Desired</Th><Th>Ready</Th><Th>Available</Th><Th>Age</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(d => (
          <Tr key={d.name} onClick={() => onDetail({ kind: 'daemonset', name: d.name })}>
            <Td>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: d.ready >= d.desired ? '#10B981' : '#F59E0B' }} />
                <Mono>{d.name}</Mono>
              </div>
            </Td>
            <Td><Mono color="var(--nox-text-2)">{d.desired}</Mono></Td>
            <Td><Mono color={d.ready >= d.desired ? '#10B981' : '#F59E0B'}>{d.ready}</Mono></Td>
            <Td><Mono color="var(--nox-text-2)">{d.available}</Mono></Td>
            <Td><AgeCell age={d.age} /></Td>
          </Tr>
        ))}
      </tbody>
    </table>
  )
}

// ── ReplicaSets ───────────────────────────────────────────────────────────────

function ReplicaSetsTable({ rows, onDetail }: Readonly<Pick<TableProps, 'rows' | 'onDetail'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Desired</Th><Th>Ready</Th><Th>Age</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <Tr key={r.name} onClick={() => onDetail({ kind: 'replicaset', name: r.name })}>
            <Td>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: r.ready >= r.desired ? '#10B981' : '#F59E0B' }} />
                <Mono>{r.name}</Mono>
              </div>
            </Td>
            <Td><Mono color="var(--nox-text-2)">{r.desired}</Mono></Td>
            <Td><Mono color={r.ready >= r.desired ? '#10B981' : '#F59E0B'}>{r.ready}</Mono></Td>
            <Td><AgeCell age={r.age} /></Td>
          </Tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

function JobsTable({ rows, onDetail }: Readonly<Pick<TableProps, 'rows' | 'onDetail'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Completions</Th><Th>Active</Th><Th>Failed</Th><Th>Age</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(j => (
          <Tr key={j.name} onClick={() => onDetail({ kind: 'job', name: j.name })}>
            <Td>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: jobDotColor(j) }} />
                <Mono>{j.name}</Mono>
              </div>
            </Td>
            <Td><Mono color="var(--nox-text-2)">{j.completions}</Mono></Td>
            <Td><Mono color={j.active > 0 ? '#F59E0B' : 'var(--nox-text-2)'}>{j.active}</Mono></Td>
            <Td><Mono color={j.failed > 0 ? '#EF4444' : 'var(--nox-text-2)'}>{j.failed}</Mono></Td>
            <Td><AgeCell age={j.age} /></Td>
          </Tr>
        ))}
      </tbody>
    </table>
  )
}

// ── CronJobs ──────────────────────────────────────────────────────────────────

function CronJobsTable({ rows, onDetail }: Readonly<Pick<TableProps, 'rows' | 'onDetail'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Schedule</Th><Th>Last Run</Th><Th>Active</Th><Th>Age</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(c => (
          <Tr key={c.name} onClick={() => onDetail({ kind: 'cronjob', name: c.name })}>
            <Td>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.suspended ? '#6B7280' : '#10B981' }} />
                <Mono>{c.name}</Mono>
              </div>
            </Td>
            <Td><code className="font-['JetBrains_Mono'] text-[11.5px] px-1.5 py-0.5 rounded" style={{ background: 'var(--nox-border)', color: 'var(--nox-text)' }}>{c.schedule}</code></Td>
            <Td><AgeCell age={c.lastSchedule} /></Td>
            <Td><Mono color={c.active > 0 ? '#F59E0B' : 'var(--nox-text-2)'}>{c.active}</Mono></Td>
            <Td><AgeCell age={c.age} /></Td>
          </Tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Services ──────────────────────────────────────────────────────────────────

function ServicesTable({ rows, onDetail, onServicePortForward }: Readonly<Pick<TableProps, 'rows' | 'onDetail' | 'onServicePortForward'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Type</Th><Th>Cluster IP</Th><Th>External IP</Th><Th>Ports</Th><Th>Age</Th><Th align="right">Actions</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(svc => (
          <Tr key={svc.name} onClick={() => onDetail({ kind: 'service', name: svc.name })}>
            <Td><Mono>{svc.name}</Mono></Td>
            <Td><ServiceTypeBadge type={svc.type} /></Td>
            <Td><Mono color="var(--nox-text-2)">{svc.clusterIP || '—'}</Mono></Td>
            <Td><Mono color={svc.externalIP ? '#10B981' : 'var(--nox-text-3)'}>{svc.externalIP || '—'}</Mono></Td>
            <Td><Mono color="var(--nox-text-2)">{svc.ports || '—'}</Mono></Td>
            <Td><AgeCell age={svc.age} /></Td>
            <Td align="right" stopPropagation>
              {svc.ports && (
                <ActionBtn title="Port forward" onClick={() => {
                  const port = Number.parseInt(svc.ports.split(',')[0])
                  if (!Number.isNaN(port)) onServicePortForward(svc.name, port)
                }}>
                  <ExternalLink className="w-3.5 h-3.5" />
                </ActionBtn>
              )}
            </Td>
          </Tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Ingresses ─────────────────────────────────────────────────────────────────

function IngressesTable({ rows, onDetail }: Readonly<Pick<TableProps, 'rows' | 'onDetail'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Hosts</Th><Th>Address</Th><Th>Class</Th><Th>Age</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(i => (
          <Tr key={i.name} onClick={() => onDetail({ kind: 'ingress', name: i.name })}>
            <Td><Mono>{i.name}</Mono></Td>
            <Td><span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text)' }}>{i.hosts || '—'}</span></Td>
            <Td><Mono color={i.address ? '#10B981' : 'var(--nox-text-3)'}>{i.address || 'Pending'}</Mono></Td>
            <Td><span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-2)' }}>{i.ingressClass || '—'}</span></Td>
            <Td><AgeCell age={i.age} /></Td>
          </Tr>
        ))}
      </tbody>
    </table>
  )
}

// ── ConfigMaps ────────────────────────────────────────────────────────────────

function ConfigMapsTable({ rows, onDetail }: Readonly<Pick<TableProps, 'rows' | 'onDetail'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Keys</Th><Th>Age</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(cm => (
          <Tr key={cm.name} onClick={() => onDetail({ kind: 'configmap', name: cm.name })}>
            <Td><Mono>{cm.name}</Mono></Td>
            <Td>
              <span className="inline-flex items-center px-2 py-0.5 rounded-md font-['Inter'] text-[11.5px]"
                style={{ background: 'var(--nox-border)', color: 'var(--nox-text-2)' }}>
                {cm.keys} key{cm.keys !== 1 ? 's' : ''}
              </span>
            </Td>
            <Td><AgeCell age={cm.age} /></Td>
          </Tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Secrets ───────────────────────────────────────────────────────────────────

function SecretsTable({ rows, onDetail }: Readonly<Pick<TableProps, 'rows' | 'onDetail'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Type</Th><Th>Keys</Th><Th>Age</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(s => (
          <Tr key={s.name} onClick={() => onDetail({ kind: 'secret', name: s.name })}>
            <Td>
              <div className="flex items-center gap-2">
                <span className="text-[#EF4444]">⬡</span>
                <Mono>{s.name}</Mono>
              </div>
            </Td>
            <Td><span className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>{s.type}</span></Td>
            <Td>
              <span className="inline-flex items-center px-2 py-0.5 rounded-md font-['Inter'] text-[11.5px]"
                style={{ background: 'var(--nox-border)', color: 'var(--nox-text-2)' }}>
                {s.keys} key{s.keys !== 1 ? 's' : ''}
              </span>
            </Td>
            <Td><AgeCell age={s.age} /></Td>
          </Tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

function NodesTable({ rows, onDetail }: Readonly<Pick<TableProps, 'rows' | 'onDetail'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Name</Th><Th>Status</Th><Th>Roles</Th><Th>CPU</Th><Th>Memory</Th><Th>Version</Th><Th>Age</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(n => (
          <Tr key={n.name} onClick={() => onDetail({ kind: 'node', name: n.name })}>
            <Td><Mono>{n.name}</Mono></Td>
            <Td>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md font-['Inter'] text-[11.5px] font-medium"
                style={{ color: n.status === 'Ready' ? '#10B981' : '#EF4444', background: n.status === 'Ready' ? '#10B98118' : '#EF444418' }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: n.status === 'Ready' ? '#10B981' : '#EF4444' }} />
                {n.status}
              </span>
            </Td>
            <Td><span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-2)' }}>{n.roles}</span></Td>
            <Td><Mono color="var(--nox-text-2)">{n.cpu}</Mono></Td>
            <Td><Mono color="var(--nox-text-2)">{formatK8sMemory(n.memory)}</Mono></Td>
            <Td><Mono color="var(--nox-text-2)">{n.kubeletVersion}</Mono></Td>
            <Td><AgeCell age={n.age} /></Td>
          </Tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Events ────────────────────────────────────────────────────────────────────

function EventsTable({ rows }: Readonly<Pick<TableProps, 'rows'>>) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <Th>Type</Th><Th>Reason</Th><Th>Object</Th><Th>Message</Th><Th>Count</Th><Th>Age</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e, i) => (
          <tr
            key={`${e.name}-${i}`}
            style={{ borderBottom: '1px solid var(--nox-border)' }}
            onMouseEnter={ev => { (ev.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
            onMouseLeave={ev => { (ev.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <Td>
              <span className="font-['Inter'] text-[11.5px] font-medium px-2 py-0.5 rounded-md"
                style={{ color: e.type === 'Warning' ? '#F59E0B' : '#10B981', background: e.type === 'Warning' ? '#F59E0B18' : '#10B98118' }}>
                {e.type}
              </span>
            </Td>
            <Td><Mono color="var(--nox-text)">{e.reason}</Mono></Td>
            <Td><Mono color="var(--nox-text-2)">{e.object}</Mono></Td>
            <Td>
              <span className="font-['Inter'] text-[12px] max-w-[360px] block truncate" title={e.message} style={{ color: 'var(--nox-text-2)' }}>
                {e.message}
              </span>
            </Td>
            <Td><Mono color="var(--nox-text-3)">{e.count}</Mono></Td>
            <Td><AgeCell age={e.age} /></Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Scale modal ───────────────────────────────────────────────────────────────

function ScaleModal({ name, current, onConfirm, onClose }: Readonly<{ name: string; current: number; onConfirm: (r: number) => void; onClose: () => void }>) {
  const [replicas, setReplicas] = useState(current)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="rounded-xl p-6 w-[340px] shadow-2xl" style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}>
        <h3 className="font-['Plus_Jakarta_Sans'] font-semibold text-[15px] mb-1" style={{ color: 'var(--nox-text)' }}>Scale Deployment</h3>
        <p className="font-['Inter'] text-[12.5px] mb-4" style={{ color: 'var(--nox-text-2)' }}>{name}</p>
        <div className="flex items-center gap-3 mb-5">
          <button
            onClick={() => setReplicas(r => Math.max(0, r - 1))}
            className="w-8 h-8 rounded-md flex items-center justify-center transition-colors"
            style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <Minus className="w-4 h-4" />
          </button>
          <input
            type="number"
            min={0}
            value={replicas}
            onChange={e => setReplicas(Math.max(0, Number.parseInt(e.target.value) || 0))}
            className="flex-1 text-center rounded-md px-3 py-2 font-['JetBrains_Mono'] text-[16px] font-semibold focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]"
            style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
          />
          <button
            onClick={() => setReplicas(r => r + 1)}
            className="w-8 h-8 rounded-md flex items-center justify-center transition-colors"
            style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 rounded-md font-['Inter'] text-[13px] transition-colors"
            style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-shell)' }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(replicas)} className="flex-1 py-2 rounded-md font-['Inter'] text-[13px] font-medium text-white transition-opacity"
            style={{ background: '#8B5CF6' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.85' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1' }}>
            Scale to {replicas}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Delete modal ──────────────────────────────────────────────────────────────

function DeleteModal({ kind, name, onConfirm, onClose }: Readonly<{ kind: ResourceKind; name: string; onConfirm: () => void; onClose: () => void }>) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="rounded-xl p-6 w-[360px] shadow-2xl" style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}>
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-xl bg-[#EF444418] flex items-center justify-center flex-shrink-0">
            <Trash2 className="w-4.5 h-4.5 text-[#EF4444]" />
          </div>
          <h3 className="font-['Plus_Jakarta_Sans'] font-semibold text-[15px]" style={{ color: 'var(--nox-text)' }}>Delete {kindTitle(kind).slice(0, -1)}</h3>
        </div>
        <p className="font-['Inter'] text-[13px] mb-4" style={{ color: 'var(--nox-text-2)' }}>
          Are you sure you want to delete <strong style={{ color: 'var(--nox-text)' }}>{name}</strong>? This cannot be undone.
        </p>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 rounded-md font-['Inter'] text-[13px]"
            style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-shell)' }}>
            Cancel
          </button>
          <button onClick={onConfirm} className="flex-1 py-2 rounded-md font-['Inter'] text-[13px] font-medium text-white"
            style={{ background: '#EF4444' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.85' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1' }}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sidebar helpers ───────────────────────────────────────────────────────────

function SideSection({ label, children, open: openProp, onToggle, collapsed }: Readonly<{
  label: string; children?: React.ReactNode; open?: boolean; onToggle?: () => void; collapsed?: boolean
}>) {
  const [open, setOpen] = useState(openProp ?? !collapsed)
  const isControlled = openProp !== undefined
  const toggle = () => { if (isControlled) onToggle?.(); else setOpen(o => !o) }
  const isOpen = isControlled ? openProp : open

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-2 py-1.5 font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: 'var(--nox-text-3)' }}
      >
        <span>{label}</span>
        {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {isOpen && children && <div className="ml-1 space-y-0.5">{children}</div>}
    </div>
  )
}

function NavItem({ icon, dot, label, count, active, onClick, disabled }: Readonly<{
  icon?: React.ReactNode; dot?: boolean; label: string; count?: number; active: boolean; onClick?: () => void; disabled?: boolean
}>) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors disabled:opacity-40 disabled:cursor-default"
      style={{ background: active ? 'var(--nox-active)' : 'transparent' }}
      onMouseEnter={e => { if (!active && !disabled) (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      {icon && <span style={{ color: active ? 'var(--nox-active-t)' : 'var(--nox-text-2)' }}>{icon}</span>}
      {/* Dots are wayfinding, not status — colored dots next to a connection
          error read as fake health lights */}
      {dot && (
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: active ? 'var(--nox-active-t)' : 'var(--nox-text-3)', opacity: active ? 1 : 0.6 }}
        />
      )}
      <span className="font-['Inter'] text-[12.5px] flex-1"
        style={{ color: active ? 'var(--nox-active-t)' : 'var(--nox-text)', fontWeight: active ? 500 : 400 }}>
        {label}
      </span>
      {count !== undefined && (
        <span className="font-['JetBrains_Mono'] text-[10px] px-1.5 py-0.5 rounded"
          style={{ background: 'var(--nox-border)', color: 'var(--nox-text-2)' }}>
          {count}
        </span>
      )}
    </button>
  )
}

// ── Table primitives ──────────────────────────────────────────────────────────

function Th({ children, align }: Readonly<{ children: React.ReactNode; align?: 'right' }>) {
  return (
    <th className={`px-4 py-2.5 font-['Plus_Jakarta_Sans'] text-[10.5px] uppercase tracking-wider font-semibold ${align === 'right' ? 'text-right' : 'text-left'}`}
      style={{ color: 'var(--nox-text-3)', whiteSpace: 'nowrap' }}>
      {children}
    </th>
  )
}

function Td({ children, align, stopPropagation }: Readonly<{ children: React.ReactNode; align?: 'right'; stopPropagation?: boolean }>) {
  return (
    <td className={`px-4 py-2.5 ${align === 'right' ? 'text-right' : ''}`}
      style={{ verticalAlign: 'middle' }}
      onClick={stopPropagation ? e => e.stopPropagation() : undefined}>
      {children}
    </td>
  )
}

function Tr({ children, onClick }: Readonly<{ children: React.ReactNode; onClick?: () => void }>) {
  return (
    <tr
      onClick={onClick}
      className={onClick ? 'cursor-pointer' : ''}
      style={{ borderBottom: '1px solid var(--nox-border)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      {children}
    </tr>
  )
}

function Mono({ children, color }: Readonly<{ children: React.ReactNode; color?: string }>) {
  return (
    <span className="font-['JetBrains_Mono'] text-[12px]" style={{ color: color ?? 'var(--nox-text)' }}>
      {children}
    </span>
  )
}

function ActionBtn({ children, title, danger, onClick }: Readonly<{ children: React.ReactNode; title?: string; danger?: boolean; onClick?: () => void }>) {
  return (
    <button
      className="p-1 rounded transition-colors"
      title={title}
      onClick={e => { e.stopPropagation(); onClick?.() }}
      style={{ color: danger ? '#EF4444' : 'var(--nox-text-2)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      {children}
    </button>
  )
}

// ── Status badges ─────────────────────────────────────────────────────────────

function PodStatusBadge({ status }: Readonly<{ status: string }>) {
  const color = podStatusColor(status)
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md font-['Inter'] text-[11.5px] font-medium"
      style={{ color, background: color + '18' }}>
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
      {status}
    </span>
  )
}

function ServiceTypeBadge({ type }: Readonly<{ type: string }>) {
  const colorMap: Record<string, string> = {
    LoadBalancer: '#8B5CF6', NodePort: '#F59E0B', ClusterIP: '#6B7280', ExternalName: '#06b6d4',
  }
  const color = colorMap[type] ?? '#6B7280'
  return (
    <span className="inline-flex px-2 py-0.5 rounded-md font-['Inter'] text-[11.5px] font-medium"
      style={{ color, background: color + '18' }}>
      {type || '—'}
    </span>
  )
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function AgeCell({ age }: Readonly<{ age: string | null | Date }>) {
  if (!age) return <span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-3)' }}>—</span>
  try {
    const date = typeof age === 'string' ? new Date(age) : age
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
    let ageStr: string
    if (seconds < 60) ageStr = `${seconds}s`
    else if (seconds < 3600) ageStr = `${Math.floor(seconds / 60)}m`
    else if (seconds < 86400) ageStr = `${Math.floor(seconds / 3600)}h`
    else ageStr = `${Math.floor(seconds / 86400)}d`
    return <span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-2)' }}>{ageStr}</span>
  } catch {
    return <span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-2)' }}>{String(age)}</span>
  }
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function kindTitle(kind: ResourceKind): string {
  const map: Record<ResourceKind, string> = {
    pods: 'Pods', deployments: 'Deployments', statefulsets: 'StatefulSets',
    daemonsets: 'DaemonSets', replicasets: 'ReplicaSets', jobs: 'Jobs', cronjobs: 'CronJobs',
    services: 'Services', ingresses: 'Ingresses', configmaps: 'ConfigMaps',
    secrets: 'Secrets', nodes: 'Nodes', events: 'Events',
  }
  return map[kind] ?? kind
}

function TableSkeleton({ cols }: Readonly<{ cols: number }>) {
  return (
    <div className="p-5 space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex gap-4" style={{ opacity: 1 - i * 0.12 }}>
          {Array.from({ length: cols }).map((_, j) => (
            <div key={j} className="h-4 rounded" style={{ flex: j === 0 ? 3 : 1, background: 'var(--nox-border)' }} />
          ))}
        </div>
      ))}
    </div>
  )
}

function EmptyState({ kind }: Readonly<{ kind: ResourceKind }>) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-2">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-1"
        style={{ border: '1px dashed var(--nox-border)', color: 'var(--nox-text-3)' }}>
        <Boxes className="w-5 h-5" />
      </div>
      <p className="font-['Inter'] text-[13px]" style={{ color: 'var(--nox-text-2)' }}>No {kindTitle(kind).toLowerCase()} found</p>
      <p className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-3)' }}>in this namespace</p>
    </div>
  )
}

function ErrorBanner({ message, onRetry }: Readonly<{ message: string; onRetry: () => void }>) {
  return (
    <div className="m-5 rounded-md p-4 flex items-start gap-3" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)' }}>
      <AlertTriangle className="w-4 h-4 text-[#EF4444] flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="font-['Inter'] text-[13px] font-medium text-[#EF4444] mb-1">Cluster request failed</p>
        <p className="font-['Inter'] text-[12px] leading-relaxed" style={{ color: 'var(--nox-text-2)' }}>{message}</p>
      </div>
      <button onClick={onRetry}
        className="flex-shrink-0 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] font-medium text-[#EF4444] transition-colors"
        style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)' }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(239,68,68,0.2)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(239,68,68,0.1)' }}>
        Retry
      </button>
    </div>
  )
}
