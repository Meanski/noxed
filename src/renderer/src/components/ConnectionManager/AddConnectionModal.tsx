import { useState, useEffect } from 'react'
import {
  X, Terminal, FolderOpen, Database, Boxes, Check, ArrowRight,
  ArrowLeft, Key, Lock, Eye, EyeOff, Wifi, Layers, Monitor,
  FileCode2, RefreshCw, ChevronRight,
} from 'lucide-react'
import { useAppStore } from '../../store'
import { ipcErrorMessage } from '../../lib/format'
import { rdpSupported } from '../../lib/platform'

interface K8sContextEntry {
  name: string
  server: string
  source: 'default' | string  // 'default' or file path
}

type ConnectionType = 'ssh' | 'sftp' | 'database' | 'kubernetes' | 'redis' | 'rdp'
type Step = 'type' | 'config'

interface Props {
  onClose: () => void
}

const COLORS = ['#3B5CCC', '#8B5CF6', '#10B981', '#F59E0B', '#EC4899', '#EF4444']

const TYPE_OPTIONS: { type: ConnectionType; label: string; icon: any; desc: string; color: string }[] = [
  { type: 'ssh', label: 'SSH Server', icon: Terminal, desc: 'Secure shell access to remote servers', color: '#3B5CCC' },
  { type: 'sftp', label: 'SFTP Server', icon: FolderOpen, desc: 'File transfer over SSH connection', color: '#EC4899' },
  { type: 'database', label: 'Database', icon: Database, desc: 'Direct TCP connection to SQL databases', color: '#10B981' },
  { type: 'kubernetes', label: 'Kubernetes', icon: Boxes, desc: 'Cluster management with Helm & metrics', color: '#8B5CF6' },
  { type: 'redis', label: 'Redis', icon: Layers, desc: 'Key-value store browser and CLI', color: '#DC382D' },
  { type: 'rdp', label: 'Remote Desktop', icon: Monitor, desc: 'Graphical Windows desktop over RDP', color: '#06B6D4' },
]

export default function AddConnectionModal({ onClose }: Props) {
  const { addSession, sessions, editingConnectionId, setEditingConnectionId, pendingConnectionGroup, setPendingConnectionGroup } = useAppStore()
  const [step, setStep] = useState<Step>('type')
  const [selectedType, setSelectedType] = useState<ConnectionType>('ssh')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null)
  const [error, setError] = useState('')

  // Kubernetes-specific state
  const [k8sContexts, setK8sContexts] = useState<K8sContextEntry[]>([])
  const [k8sLoading, setK8sLoading] = useState(false)
  const [k8sSelected, setK8sSelected] = useState<K8sContextEntry | null>(null)

  const editingSession = editingConnectionId
    ? sessions.find(s => s.id === editingConnectionId)
    : null

  const [passwordDirty, setPasswordDirty] = useState(false)

  const [form, setForm] = useState({
    label: '',
    host: '',
    port: '22',
    username: '',
    authType: 'password' as 'password' | 'key',
    password: '',
    keyPath: '',
    jumpHostId: '',
    group: pendingConnectionGroup ?? '',
    color: COLORS[0],
    tags: '',
    pollingEnabled: false,
    pollingIntervalSeconds: '60',
    connectOnStart: false,
    dbType: 'postgresql',
    databaseName: '',
    sslMode: 'disable',
    redisDb: '0',
    showPassword: false,
  })

  useEffect(() => {
    if (editingSession) {
      const type = (editingSession.type as ConnectionType) ?? 'ssh'
      setSelectedType(type)
      setStep('config')
      setForm(f => ({
        ...f,
        label: editingSession.label ?? '',
        host: editingSession.host ?? '',
        port: String(editingSession.port ?? 22),
        username: editingSession.username ?? '',
        authType: editingSession.authType ?? 'password',
        password: editingSession.password ?? '',
        keyPath: editingSession.keyPath ?? '',
        jumpHostId: editingSession.jumpHostId ?? '',
        group: editingSession.group ?? '',
        color: editingSession.color ?? COLORS[0],
        tags: (editingSession.tags ?? []).join(', '),
        pollingEnabled: editingSession.pollingEnabled ?? false,
        pollingIntervalSeconds: String(editingSession.pollingIntervalSeconds ?? 60),
        connectOnStart: editingSession.connectOnStart ?? false,
        dbType: editingSession.dbType ?? 'postgresql',
        databaseName: editingSession.databaseName ?? '',
        sslMode: editingSession.sslMode ?? 'disable',
        redisDb: String(editingSession.redisDb ?? 0),
      }))
      if (type === 'kubernetes') {
        loadDefaultK8sContexts().then(() => {
          if (editingSession.contextName) {
            setK8sSelected({
              name: editingSession.contextName,
              server: '',
              source: editingSession.kubeconfigPath ?? 'default',
            })
          }
        })
      }
    }
  }, [editingConnectionId])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleClose = () => {
    setEditingConnectionId(null)
    setPendingConnectionGroup(null)
    onClose()
  }

  const set = (field: string, value: any) => {
    setError('')
    setTestResult(null)
    if (field === 'password') setPasswordDirty(true)
    setForm(f => ({ ...f, [field]: value }))
  }

  const getDefaultPort = (type: ConnectionType) => {
    switch (type) {
      case 'ssh': return '22'
      case 'sftp': return '22'
      case 'database': return form.dbType === 'postgresql' ? '5432' : form.dbType === 'mysql' ? '3306' : '5432'
      case 'redis': return '6379'
      case 'rdp': return '3389'
      default: return '443'
    }
  }

  const loadDefaultK8sContexts = async () => {
    setK8sLoading(true)
    try {
      const ctxs = await window.api.k8s.contextsDetailed()
      setK8sContexts(prev => {
        const nonDefault = prev.filter(c => c.source !== 'default')
        return [...ctxs.map(c => ({ ...c, source: 'default' as const })), ...nonDefault]
      })
    } catch {
      // kubeconfig may not exist — silently leave list empty
    } finally {
      setK8sLoading(false)
    }
  }

  const handleImportFile = async (droppedPath?: string) => {
    const picked = droppedPath ?? await window.api.k8s.showFilePicker()
    if (!picked) return
    setK8sLoading(true)
    setError('')
    try {
      // Main copies the file into noxed's managed kubeconfig folder; the
      // saved connection references that stable copy, not e.g. ~/Downloads
      const { path, contexts } = await window.api.k8s.importKubeconfig(picked)
      setK8sContexts(prev => {
        const withoutThisFile = prev.filter(c => c.source !== path)
        return [...withoutThisFile, ...contexts.map(c => ({ ...c, source: path }))]
      })
    } catch (e: any) {
      setError(ipcErrorMessage(e, 'Failed to import kubeconfig file'))
    } finally {
      setK8sLoading(false)
    }
  }

  const handleTypeSelect = (type: ConnectionType) => {
    setSelectedType(type)
    set('port', getDefaultPort(type))
    if (type === 'rdp') {
      set('authType', 'password')
    }
    if (type === 'kubernetes' && k8sContexts.length === 0) {
      loadDefaultK8sContexts()
    }
  }

  const parsedPort = (): number => {
    const raw = form.port.trim()
    if (!raw) return parseInt(getDefaultPort(selectedType))
    return parseInt(raw)
  }

  // One source of truth for "is this form submittable" — Test and Save must
  // never disagree about what a valid connection looks like.
  const validateConfigForm = (): string | null => {
    if (selectedType === 'kubernetes') {
      return k8sSelected ? null : 'Select a context to continue'
    }
    if (!form.host.trim()) return 'Host is required'
    const port = parsedPort()
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be between 1 and 65535'
    if (selectedType === 'ssh' || selectedType === 'sftp') {
      if (!form.username.trim()) return 'Username is required'
      if (form.authType === 'key' && !form.keyPath.trim()) return 'Private key path is required'
    }
    if (selectedType === 'database') {
      if (!form.username.trim()) return 'Username is required'
      if (!form.databaseName.trim()) return 'Database name is required'
    }
    if (selectedType === 'redis') {
      const db = parseInt(form.redisDb)
      if (!Number.isInteger(db) || db < 0 || db > 15) return 'DB index must be 0–15'
    }
    if (selectedType === 'rdp') {
      if (!form.username.trim()) return 'Username is required'
    }
    return null
  }

  // When editing without retyping the password, fall back to the stored one
  // so Test Connection exercises the credentials that will actually be used.
  const effectivePassword = async (): Promise<string | undefined> => {
    if (form.password) return form.password
    if (editingConnectionId && editingSession?.hasPassword && !passwordDirty) {
      try {
        const creds = await window.api.sessions.getCredentials(editingConnectionId)
        return creds.password
      } catch (err: any) {
        // Locked app or missing keychain entry — test proceeds without a password
        console.error('[connections] stored credential unavailable:', err?.message ?? err)
      }
    }
    return undefined
  }

  const handleTest = async () => {
    const invalid = validateConfigForm()
    if (invalid) {
      setTestResult(null)
      setError(invalid)
      return
    }

    setTesting(true)
    setTestResult(null)
    setError('')
    const host = form.host.trim()
    const port = parsedPort()

    try {
      const password = await effectivePassword()

      if (selectedType === 'ssh' || selectedType === 'sftp') {
        let privateKey: string | undefined
        if (form.authType === 'key') {
          privateKey = await window.api.fs.readFile(form.keyPath.trim()).catch(() => undefined)
          if (!privateKey) throw new Error(`Cannot read private key: ${form.keyPath.trim()}`)
        }
        const target = {
          host,
          port,
          username: form.username.trim(),
          password: form.authType === 'password' ? password : undefined,
          privateKey,
          jumpHostId: form.jumpHostId || undefined,
        }
        if (selectedType === 'ssh') {
          const streamId = await window.api.ssh.connect(target)
          await window.api.ssh.disconnect(streamId)
        } else {
          const clientId = await window.api.sftp.connect(target)
          await window.api.sftp.disconnect(clientId)
        }
      } else if (selectedType === 'redis') {
        const id = await window.api.redis.connect({ host, port, password, db: parseInt(form.redisDb) })
        await window.api.redis.disconnect(id)
      } else if (selectedType === 'database') {
        const id = await window.api.database.connect({
          dbType: form.dbType,
          host,
          port,
          username: form.username.trim(),
          password,
          database: form.databaseName.trim(),
          ssl: form.sslMode,
        })
        await window.api.database.disconnect(id)
      }

      setTestResult('success')
    } catch (err: any) {
      setTestResult('error')
      setError(ipcErrorMessage(err, 'Connection failed'))
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()

    const invalid = validateConfigForm()
    if (invalid) {
      setTestResult(null)
      return setError(invalid)
    }

    if (selectedType === 'kubernetes') {
      if (!k8sSelected) return setError('Select a context to continue')
      setSaving(true)
      try {
        const data: any = {
          type: 'kubernetes',
          label: form.label.trim() || k8sSelected.name,
          host: k8sSelected.server || k8sSelected.name,
          port: 0,
          username: '',
          authType: 'password',
          color: form.color,
          tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
          contextName: k8sSelected.name,
          kubeconfigPath: k8sSelected.source !== 'default' ? k8sSelected.source : undefined,
        }
        if (editingConnectionId) {
          const updated = await window.api.sessions.update(editingConnectionId, data)
          useAppStore.getState().updateSession(editingConnectionId, updated)
        } else {
          const session = await window.api.sessions.create(data)
          addSession(session)
        }
        handleClose()
      } catch (err: any) {
        setError(ipcErrorMessage(err, 'Failed to save'))
      } finally {
        setSaving(false)
      }
      return
    }

    setSaving(true)
    try {
      const includePassword = !editingConnectionId || passwordDirty
      const data: any = {
        type: selectedType,
        label: form.label.trim() || undefined,
        host: form.host.trim(),
        port: parsedPort(),
        username: form.username.trim() || undefined,
        authType: form.authType,
        password: includePassword && form.authType === 'password' ? form.password : undefined,
        keyPath: form.authType === 'key' ? form.keyPath.trim() : undefined,
        jumpHostId: (selectedType === 'ssh' || selectedType === 'sftp') && form.jumpHostId ? form.jumpHostId : undefined,
        group: form.group || undefined,
        color: form.color,
        tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        pollingEnabled: selectedType === 'ssh' ? form.pollingEnabled : undefined,
        pollingIntervalSeconds: selectedType === 'ssh' ? parseInt(form.pollingIntervalSeconds) : undefined,
        connectOnStart: selectedType === 'ssh' ? form.connectOnStart : undefined,
        dbType: selectedType === 'database' ? form.dbType : undefined,
        databaseName: selectedType === 'database' ? form.databaseName : undefined,
        sslMode: selectedType === 'database' ? form.sslMode : undefined,
        redisDb: selectedType === 'redis' ? parseInt(form.redisDb) : undefined,
      }

      if (editingConnectionId) {
        const updated = await window.api.sessions.update(editingConnectionId, data)
        useAppStore.getState().updateSession(editingConnectionId, updated)
      } else {
        const session = await window.api.sessions.create(data)
        addSession(session)
      }
      handleClose()
    } catch (err: any) {
      setTestResult(null)
      setError(ipcErrorMessage(err, 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={handleClose}
    >
      <div
        className="rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden"
        style={{
          background: 'var(--nox-shell)',
          border: '1px solid var(--nox-border)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--nox-border)' }}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-['Plus_Jakarta_Sans'] font-semibold text-[17px]" style={{ color: 'var(--nox-text)' }}>
                {editingConnectionId ? 'Edit Connection' : 'Add New Connection'}
              </h2>
              <p className="font-['Inter'] text-[12px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
                {step === 'type' ? 'Choose a connection type to get started' : 'Step 2 — Enter connection details'}
              </p>
            </div>
            <button
              onClick={handleClose}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: 'var(--nox-text-2)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Stepper */}
          <div className="flex items-center gap-3 mt-4">
            {['Type', 'Configure', 'Save'].map((label, i) => {
              const active = (step === 'type' && i === 0) || (step === 'config' && i >= 1)
              const done = (step === 'config' && i === 0)
              return (
                <div key={label} className="flex items-center gap-2">
                  {i > 0 && (
                    <div
                      className="flex-1 h-[2px] w-12"
                      style={{ background: done || (step === 'config' && i === 1) ? '#3B5CCC' : 'var(--nox-border)' }}
                    />
                  )}
                  <div className="flex items-center gap-2">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                      style={{
                        background: done ? '#3B5CCC' : active ? '#3B5CCC' : 'var(--nox-border)',
                        color: done || active ? '#fff' : 'var(--nox-text-2)',
                      }}
                    >
                      {done ? <Check className="w-3 h-3" /> : i + 1}
                    </div>
                    <span
                      className="font-['Inter'] text-[11.5px]"
                      style={{ color: active || done ? '#3B5CCC' : 'var(--nox-text-3)', fontWeight: active ? 500 : 400 }}
                    >
                      {label}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {step === 'type' ? (
            <TypeSelector
              selected={selectedType}
              onSelect={handleTypeSelect}
            />
          ) : (
            <ConfigForm
              type={selectedType}
              form={form}
              set={set}
              error={error}
              testResult={testResult}
              isEditing={!!editingConnectionId}
              hasExistingPassword={!!editingSession?.hasPassword}
              k8sContexts={k8sContexts}
              k8sLoading={k8sLoading}
              k8sSelected={k8sSelected}
              onK8sSelect={setK8sSelected}
              onK8sImport={handleImportFile}
              onK8sRefresh={loadDefaultK8sContexts}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 flex-shrink-0 flex items-center justify-between" style={{ borderTop: '1px solid var(--nox-border)' }}>
          {step === 'type' ? (
            <>
              <button
                onClick={handleClose}
                className="px-4 py-2 rounded-md font-['Inter'] text-[12.5px] transition-colors"
                style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--nox-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                Cancel
              </button>
              <button
                onClick={() => setStep('config')}
                className="px-4 py-2 rounded-md text-white font-['Inter'] text-[12.5px] font-medium flex items-center gap-1.5 transition-colors"
                style={{ background: '#3B5CCC' }}
                onMouseEnter={e => { e.currentTarget.style.background = '#2A4299' }}
                onMouseLeave={e => { e.currentTarget.style.background = '#3B5CCC' }}
              >
                Next <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep('type')}
                className="flex items-center gap-1.5 px-3 py-2 rounded-md font-['Inter'] text-[12px] transition-colors"
                style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--nox-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </button>
              <div className="flex items-center gap-2">
                {selectedType !== 'kubernetes' && selectedType !== 'rdp' && (
                  <button
                    onClick={handleTest}
                    disabled={testing}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-md font-['Inter'] text-[12px] transition-colors disabled:opacity-60"
                    style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
                    onMouseEnter={e => { if (!testing) e.currentTarget.style.background = 'var(--nox-hover)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <Wifi className="w-3.5 h-3.5" />
                    {testing ? 'Testing…' : 'Test Connection'}
                    {testResult === 'success' && <span className="text-[#10B981]">✓</span>}
                    {testResult === 'error' && <span className="text-[#EF4444]">✗</span>}
                  </button>
                )}
                <button
                  onClick={handleSave as any}
                  disabled={saving}
                  className="px-4 py-2 rounded-md text-white font-['Inter'] text-[12.5px] font-medium flex items-center gap-1.5 transition-colors disabled:opacity-60"
                  style={{ background: '#3B5CCC' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#2A4299' }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#3B5CCC' }}
                >
                  <Check className="w-3.5 h-3.5" />
                  {saving ? 'Saving…' : editingConnectionId ? 'Save Changes' : 'Save Connection'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Type selector ───────────────────────────────────────────────────────── */
function TypeSelector({ selected, onSelect }: {
  selected: ConnectionType
  onSelect: (t: ConnectionType) => void
}) {
  // RDP needs the bundled FreeRDP sidecar, which ships on macOS + Windows.
  // Hide the type elsewhere so we never offer a connection that can't run.
  const options = TYPE_OPTIONS.filter(o => o.type !== 'rdp' || rdpSupported)
  return (
    <div className="px-6 py-4">
      <div className="grid grid-cols-2 gap-3">
        {options.map(opt => (
          <button
            key={opt.type}
            onClick={() => onSelect(opt.type)}
            className="flex items-start gap-3 p-4 rounded-lg text-left transition-all"
            style={selected === opt.type
              ? { borderColor: '#3B5CCC', background: 'var(--nox-active)', border: '1px solid #3B5CCC', boxShadow: '0 2px 8px rgba(59,92,204,0.1)' }
              : { border: '1px solid var(--nox-border)', background: 'var(--nox-bg)' }}
            onMouseEnter={e => { if (selected !== opt.type) e.currentTarget.style.background = 'var(--nox-hover)' }}
            onMouseLeave={e => { if (selected !== opt.type) e.currentTarget.style.background = 'var(--nox-bg)' }}
          >
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: opt.color + '18' }}
            >
              <opt.icon className="w-5 h-5" style={{ color: opt.color }} />
            </div>
            <div>
              <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[13.5px] block" style={{ color: 'var(--nox-text)' }}>
                {opt.label}
              </span>
              <span className="font-['Inter'] text-[11.5px] mt-0.5 block leading-relaxed" style={{ color: 'var(--nox-text-2)' }}>
                {opt.desc}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── Config form ─────────────────────────────────────────────────────────── */
function ConfigForm({ type, form, set, error, testResult, isEditing, hasExistingPassword, k8sContexts, k8sLoading, k8sSelected, onK8sSelect, onK8sImport, onK8sRefresh }: {
  type: ConnectionType
  form: any
  set: (f: string, v: any) => void
  error: string
  testResult: 'success' | 'error' | null
  isEditing: boolean
  hasExistingPassword: boolean
  k8sContexts: K8sContextEntry[]
  k8sLoading: boolean
  k8sSelected: K8sContextEntry | null
  onK8sSelect: (ctx: K8sContextEntry) => void
  onK8sImport: (filePath?: string) => void
  onK8sRefresh: () => void
}) {
  const [dropActive, setDropActive] = useState(false)
  const sessions = useAppStore(s => s.sessions)
  const editingConnectionId = useAppStore(s => s.editingConnectionId)
  const jumpHostCandidates = sessions.filter(s => (s.type ?? 'ssh') === 'ssh' && s.id !== editingConnectionId)
  const projectNames = [...new Set(sessions.map(s => s.group).filter(Boolean))] as string[]

  if (type === 'kubernetes') {
    const defaultContexts = k8sContexts.filter(c => c.source === 'default')
    const importedFiles = [...new Set(k8sContexts.filter(c => c.source !== 'default').map(c => c.source))]

    return (
      <div
        className="px-6 py-4 space-y-4"
        onDragOver={e => { e.preventDefault(); setDropActive(true) }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false) }}
        onDrop={async e => {
          e.preventDefault()
          setDropActive(false)
          const file = e.dataTransfer.files[0]
          if (!file) return
          const filePath = (file as any).path as string | undefined
          if (filePath) onK8sImport(filePath)
        }}
        style={dropActive ? { outline: '2px dashed #3B5CCC', outlineOffset: -2, borderRadius: 6 } : undefined}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="font-['Plus_Jakarta_Sans'] font-semibold text-[13.5px]" style={{ color: 'var(--nox-text)' }}>Select a context</p>
            <p className="font-['Inter'] text-[11.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
              Auto-discovered from <code className="font-mono text-[10.5px] px-1 py-0.5 rounded" style={{ background: 'var(--nox-hover)', color: 'var(--nox-text-2)' }}>~/.kube/config</code>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onK8sRefresh}
              disabled={k8sLoading}
              className="p-1.5 rounded-md transition-colors disabled:opacity-40"
              style={{ color: 'var(--nox-text-2)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${k8sLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => onK8sImport()}
              disabled={k8sLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] transition-colors disabled:opacity-40"
              style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <FileCode2 className="w-3.5 h-3.5" />
              Import file
            </button>
          </div>
        </div>

        {/* Context list / drop zone */}
        <div
          className="rounded-md overflow-hidden"
          style={{ border: dropActive ? '1px dashed #3B5CCC' : '1px solid var(--nox-border)', maxHeight: 280, overflowY: 'auto' }}
        >
          {k8sLoading && k8sContexts.length === 0 ? (
            <div className="flex items-center justify-center py-8 gap-2" style={{ color: 'var(--nox-text-3)' }}>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span className="font-['Inter'] text-[12px]">Reading kubeconfig…</span>
            </div>
          ) : k8sContexts.length === 0 ? (
            <div className="py-8 text-center">
              {dropActive ? (
                <>
                  <FileCode2 className="w-6 h-6 mx-auto mb-2 text-[#3B5CCC]" />
                  <p className="font-['Inter'] text-[12px] text-[#3B5CCC] font-medium">Drop to import</p>
                </>
              ) : (
                <>
                  <p className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-3)' }}>No contexts found</p>
                  <p className="font-['Inter'] text-[11px] mt-1" style={{ color: 'var(--nox-text-3)', opacity: 0.6 }}>
                    Click "Import file" or drag a kubeconfig here
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              {dropActive && (
                <div className="flex items-center justify-center gap-2 py-2 text-[#3B5CCC]" style={{ background: 'var(--nox-active)', borderBottom: '1px solid var(--nox-border)' }}>
                  <FileCode2 className="w-3.5 h-3.5" />
                  <span className="font-['Inter'] text-[11.5px] font-medium">Drop to import file</span>
                </div>
              )}
              {defaultContexts.length > 0 && (
                <ContextGroup
                  label="Default (~/.kube/config)"
                  contexts={defaultContexts}
                  selected={k8sSelected}
                  onSelect={onK8sSelect}
                />
              )}
              {importedFiles.map(filePath => (
                <ContextGroup
                  key={filePath}
                  label={filePath.split('/').pop() ?? filePath}
                  labelTitle={filePath}
                  contexts={k8sContexts.filter(c => c.source === filePath)}
                  selected={k8sSelected}
                  onSelect={onK8sSelect}
                />
              ))}
            </>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-md" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
            <span className="text-[#EF4444] text-[12px]">✗</span>
            <p className="font-['Inter'] text-[12px] text-[#EF4444]">{error}</p>
          </div>
        )}

        {/* Optional label + color for selected context */}
        {k8sSelected && (
          <div className="space-y-3 pt-1">
            <FormField label="Display Name">
              <FormInput
                placeholder={k8sSelected.name}
                value={form.label}
                onChange={e => set('label', e.target.value)}
              />
            </FormField>
            <FormField label="Color">
              <div className="flex items-center gap-2">
                {COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set('color', c)}
                    className="w-6 h-6 rounded-full transition-all"
                    style={{
                      background: c,
                      border: form.color === c ? '2px solid var(--nox-text)' : '2px solid transparent',
                      outline: form.color === c ? '2px solid rgba(128,128,128,0.3)' : 'none',
                      outlineOffset: 1,
                    }}
                  />
                ))}
              </div>
            </FormField>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="px-6 py-4 space-y-4">
      {/* Name */}
      <FormField label="Connection Name">
        <FormInput
          placeholder="e.g. web-server-01"
          value={form.label}
          onChange={e => set('label', e.target.value)}
        />
      </FormField>

      {/* Host + Port */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <FormField label="Hostname / IP">
            <FormInput
              placeholder={type === 'database' ? '192.168.1.30' : '192.168.1.10'}
              value={form.host}
              onChange={e => set('host', e.target.value)}
            />
          </FormField>
        </div>
        <FormField label="Port">
          <FormInput
            placeholder="22"
            value={form.port}
            onChange={e => set('port', e.target.value)}
            className="font-mono"
          />
        </FormField>
      </div>

      {/* Type-specific fields */}
      {(type === 'ssh' || type === 'sftp') && (
        <>
          <FormField label="Username">
            <FormInput
              placeholder="root"
              value={form.username}
              onChange={e => set('username', e.target.value)}
            />
          </FormField>

          <div>
            <label className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold block mb-2" style={{ color: 'var(--nox-text-3)' }}>
              Authentication Method
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => set('authType', 'key')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] font-medium transition-colors"
                style={form.authType === 'key'
                  ? { background: '#3B5CCC', color: '#fff' }
                  : { border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
              >
                <Key className="w-3.5 h-3.5" /> Private Key
              </button>
              <button
                type="button"
                onClick={() => set('authType', 'password')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] font-medium transition-colors"
                style={form.authType === 'password'
                  ? { background: '#3B5CCC', color: '#fff' }
                  : { border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
              >
                <Lock className="w-3.5 h-3.5" /> Password
              </button>
            </div>
          </div>

          {form.authType === 'password' && (
            <FormField label="Password">
              <div className="relative">
                <FormInput
                  type={form.showPassword ? 'text' : 'password'}
                  placeholder={isEditing && hasExistingPassword ? '••••••••  (leave blank to keep)' : 'Enter password'}
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => set('showPassword', !form.showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors"
                  style={{ color: 'var(--nox-text-3)' }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--nox-text-2)' }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--nox-text-3)' }}
                >
                  {form.showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </FormField>
          )}

          {form.authType === 'key' && (
            <FormField label="Private Key Path">
              <FormInput
                placeholder="~/.ssh/id_ed25519"
                value={form.keyPath}
                onChange={e => set('keyPath', e.target.value)}
              />
            </FormField>
          )}

          {jumpHostCandidates.length > 0 && (
            <FormField label="Connect via (jump host)">
              <FormSelect value={form.jumpHostId} onChange={e => set('jumpHostId', e.target.value)}>
                <option value="">None — connect directly</option>
                {jumpHostCandidates.map(s => (
                  <option key={s.id} value={s.id}>{s.label || s.host}</option>
                ))}
              </FormSelect>
            </FormField>
          )}
        </>
      )}

      {type === 'database' && (
        <>
          <FormField label="Database Type">
            <FormSelect value={form.dbType} onChange={e => set('dbType', e.target.value)}>
              <option value="postgresql">PostgreSQL</option>
              <option value="mysql">MySQL</option>
              <option value="mariadb">MariaDB</option>
            </FormSelect>
          </FormField>
          <FormField label="Database Name">
            <FormInput
              placeholder="mydb"
              value={form.databaseName}
              onChange={e => set('databaseName', e.target.value)}
            />
          </FormField>
          <FormField label="Username">
            <FormInput
              placeholder="postgres"
              value={form.username}
              onChange={e => set('username', e.target.value)}
            />
          </FormField>
          <FormField label="Password">
            <FormInput
              type="password"
              placeholder={isEditing && hasExistingPassword ? '••••••••  (leave blank to keep)' : 'Enter password'}
              value={form.password}
              onChange={e => set('password', e.target.value)}
            />
          </FormField>
          <FormField label="SSL Mode">
            <FormSelect value={form.sslMode} onChange={e => set('sslMode', e.target.value)}>
              <option value="disable">Disable</option>
              <option value="require">Require</option>
              <option value="verify-ca">Verify CA</option>
              <option value="verify-full">Verify Full</option>
            </FormSelect>
          </FormField>
        </>
      )}

      {type === 'rdp' && (
        <>
          <FormField label="Username">
            <FormInput
              placeholder="Administrator  (or DOMAIN\\user)"
              value={form.username}
              onChange={e => set('username', e.target.value)}
            />
          </FormField>
          <FormField label="Password">
            <div className="relative">
              <FormInput
                type={form.showPassword ? 'text' : 'password'}
                placeholder={isEditing && hasExistingPassword ? '••••••••  (leave blank to keep)' : 'Enter password'}
                value={form.password}
                onChange={e => set('password', e.target.value)}
              />
              <button
                type="button"
                onClick={() => set('showPassword', !form.showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors"
                style={{ color: 'var(--nox-text-3)' }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--nox-text-2)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--nox-text-3)' }}
              >
                {form.showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </FormField>
        </>
      )}

      {type === 'redis' && (
        <>
          <FormField label="Password (optional)">
            <FormInput
              type="password"
              placeholder={isEditing && hasExistingPassword ? '••••••••  (leave blank to keep)' : 'Leave blank if no auth'}
              value={form.password}
              onChange={e => set('password', e.target.value)}
            />
          </FormField>
          <FormField label="Database Index">
            <FormInput
              placeholder="0"
              value={form.redisDb}
              onChange={e => set('redisDb', e.target.value)}
              className="font-mono"
            />
          </FormField>
        </>
      )}

      {/* SSH-only options */}
      {type === 'ssh' && (
        <div className="space-y-2">
          <MiniToggleRow
            on={form.pollingEnabled}
            onToggle={() => set('pollingEnabled', !form.pollingEnabled)}
            label="Enable Dashboard Polling"
            description="Monitor CPU/RAM usage on the dashboard"
          />
          <MiniToggleRow
            on={form.connectOnStart}
            onToggle={() => set('connectOnStart', !form.connectOnStart)}
            label="Connect on App Start"
            description="Automatically open a terminal session when noxed launches"
          />
        </div>
      )}

      {/* Project */}
      <FormField label="Project (optional)">
        <FormInput
          list="nx-project-options"
          placeholder="e.g. Homelab"
          value={form.group}
          onChange={e => set('group', e.target.value)}
        />
        <datalist id="nx-project-options">
          {projectNames.map(g => <option key={g} value={g} />)}
        </datalist>
      </FormField>

      {/* Color + Tags */}
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Color">
          <div className="flex items-center gap-2">
            {COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => set('color', c)}
                className="w-6 h-6 rounded-full transition-all"
                style={{
                  background: c,
                  border: form.color === c ? '2px solid var(--nox-text)' : '2px solid transparent',
                  outline: form.color === c ? '2px solid rgba(128,128,128,0.3)' : 'none',
                  outlineOffset: 1,
                }}
              />
            ))}
          </div>
        </FormField>
        <FormField label="Tags (comma separated)">
          <FormInput
            placeholder="production, web"
            value={form.tags}
            onChange={e => set('tags', e.target.value)}
          />
        </FormField>
      </div>

      {/* Error */}
      {error && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 rounded-md"
          style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}
        >
          <span className="text-[#EF4444] text-[12px]">✗</span>
          <p className="font-['Inter'] text-[12px] text-[#EF4444]">{error}</p>
        </div>
      )}

      {testResult === 'success' && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 rounded-md"
          style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}
        >
          <Check className="w-4 h-4 text-[#10B981]" />
          <p className="font-['Inter'] text-[12px] text-[#10B981]">Connection successful!</p>
        </div>
      )}

      {testResult === 'error' && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 rounded-md"
          style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}
        >
          <span className="text-[#EF4444] text-[12px]">✗</span>
          <p className="font-['Inter'] text-[12px] text-[#EF4444]">Connection failed. Check your credentials.</p>
        </div>
      )}
    </div>
  )
}

function ContextGroup({ label, labelTitle, contexts, selected, onSelect }: {
  label: string
  labelTitle?: string
  contexts: K8sContextEntry[]
  selected: K8sContextEntry | null
  onSelect: (ctx: K8sContextEntry) => void
}) {
  return (
    <div>
      <div className="px-3 py-1.5" style={{ background: 'var(--nox-bg)', borderBottom: '1px solid var(--nox-border)' }}>
        <span className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--nox-text-3)' }} title={labelTitle}>
          {label}
        </span>
      </div>
      {contexts.map((ctx, i) => {
        const isSelected = selected?.name === ctx.name && selected?.source === ctx.source
        return (
          <button
            key={ctx.name + ctx.source}
            type="button"
            onClick={() => onSelect(ctx)}
            className="w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors"
            style={{
              background: isSelected ? 'var(--nox-active)' : 'transparent',
              borderTop: i > 0 ? '1px solid var(--nox-border)' : undefined,
            }}
            onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
            onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <Boxes className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#8B5CF6' }} />
              <div className="min-w-0">
                <span className="font-['Inter'] text-[12.5px] font-medium block truncate" style={{ color: isSelected ? '#3B5CCC' : 'var(--nox-text)' }}>
                  {ctx.name}
                </span>
                {ctx.server && (
                  <span className="font-mono text-[10px] truncate block" style={{ color: 'var(--nox-text-3)' }}>{ctx.server}</span>
                )}
              </div>
            </div>
            {isSelected
              ? <Check className="w-3.5 h-3.5 flex-shrink-0 text-[#3B5CCC]" />
              : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
            }
          </button>
        )
      })}
    </div>
  )
}

function MiniToggleRow({ on, onToggle, label, description }: {
  on: boolean; onToggle: () => void; label: string; description: string
}) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-md" style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}>
      <div
        className="relative flex-shrink-0 cursor-pointer"
        onClick={onToggle}
      >
        <div className="w-8 h-4 rounded-full transition-colors" style={{ background: on ? '#3B5CCC' : 'var(--nox-border)' }} />
        <div
          className="w-3.5 h-3.5 bg-white rounded-full absolute top-[1px] transition-all shadow-sm"
          style={{ left: on ? 'calc(100% - 14px - 2px)' : 2 }}
        />
      </div>
      <div>
        <span className="font-['Inter'] text-[12px] font-medium" style={{ color: 'var(--nox-text)' }}>{label}</span>
        <p className="font-['Inter'] text-[10.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>{description}</p>
      </div>
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold block mb-1.5" style={{ color: 'var(--nox-text-3)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function FormInput({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement> & { className?: string }) {
  return (
    <input
      {...props}
      className={`w-full rounded-md px-3 py-2 font-['Inter'] text-[12.5px] focus:outline-none focus:ring-1 focus:ring-[#3B5CCC] ${className}`}
      style={{
        background: 'var(--nox-bg)',
        border: '1px solid var(--nox-border)',
        color: 'var(--nox-text)',
        ...((props as any).style ?? {}),
      }}
    />
  )
}

function FormSelect({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      {...props}
      className="w-full rounded-md px-3 py-2 font-['Inter'] text-[12.5px] focus:outline-none focus:ring-1 focus:ring-[#3B5CCC]"
      style={{
        background: 'var(--nox-bg)',
        border: '1px solid var(--nox-border)',
        color: 'var(--nox-text)',
      }}
    >
      {children}
    </select>
  )
}
