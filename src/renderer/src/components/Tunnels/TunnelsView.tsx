import { useEffect, useState } from 'react'
import { Plus, Play, Square, Pencil, Trash2, X, ArrowRight, Cable, Globe, Loader2 } from 'lucide-react'
import { useAppStore, Session } from '../../store'

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

const TYPE_META: Record<TunnelInfo['type'], { label: string; color: string; description: string }> = {
  local: { label: 'Local', color: '#3B5CCC', description: 'Expose a remote service on a local port' },
  remote: { label: 'Remote', color: '#EC4899', description: 'Expose a local service on the server' },
  dynamic: { label: 'SOCKS', color: '#8B5CF6', description: 'SOCKS5 proxy that routes traffic through the server' },
}

export default function TunnelsView() {
  const sessions = useAppStore(s => s.sessions)
  const addNotification = useAppStore(s => s.addNotification)
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<TunnelInfo | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const sshSessions = sessions.filter(s => (s.type ?? 'ssh') === 'ssh')
  const sessionLabel = (id: string) => {
    const s = sessions.find(x => x.id === id)
    return s ? (s.label || s.host) : 'deleted connection'
  }

  const refresh = () => {
    window.api.tunnels.list().then(setTunnels).catch((err: any) => {
      addNotification({ type: 'error', message: err?.message ?? 'Failed to load tunnels' })
    })
  }

  useEffect(() => {
    refresh()
    return window.api.tunnels.onChanged(refresh)
  }, [])

  async function toggle(t: TunnelInfo) {
    setBusyId(t.id)
    try {
      if (t.status === 'stopped') await window.api.tunnels.start(t.id)
      else await window.api.tunnels.stop(t.id)
    } catch (err: any) {
      addNotification({ type: 'error', message: err?.message ?? 'Tunnel operation failed' })
    } finally {
      setBusyId(null)
      refresh()
    }
  }

  async function remove(t: TunnelInfo) {
    if (!confirm(`Delete tunnel "${t.label || routeText(t)}"?`)) return
    try {
      await window.api.tunnels.delete(t.id)
    } catch (err: any) {
      addNotification({ type: 'error', message: err?.message ?? 'Delete failed' })
    }
  }

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--nox-bg)' }}>
      <div className="p-6 max-w-3xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="font-['Plus_Jakarta_Sans'] font-bold text-[22px]" style={{ color: 'var(--nox-text)' }}>
              Tunnels
            </h1>
            <p className="font-['Inter'] text-[12.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
              Port forwarding and SOCKS proxies over your saved SSH connections
            </p>
          </div>
          <button
            onClick={() => { setEditing(null); setEditorOpen(true) }}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 font-['Inter'] text-[12px] font-medium text-white transition-colors"
            style={{ background: '#3B5CCC' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#2A4299' }}
            onMouseLeave={e => { e.currentTarget.style.background = '#3B5CCC' }}
          >
            <Plus className="w-3.5 h-3.5" />
            New Tunnel
          </button>
        </div>

        {tunnels.length === 0 ? (
          <div
            className="rounded-md p-10 text-center"
            style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
          >
            <Cable className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--nox-text-3)' }} />
            <p className="font-['Inter'] text-[13px] mb-1" style={{ color: 'var(--nox-text)' }}>
              No tunnels yet
            </p>
            <p className="font-['Inter'] text-[12px] max-w-sm mx-auto" style={{ color: 'var(--nox-text-2)' }}>
              Forward a remote database to localhost, publish a local dev server on a remote box,
              or route traffic through a server with a SOCKS proxy.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {tunnels.map(t => (
              <TunnelCard
                key={t.id}
                tunnel={t}
                via={sessionLabel(t.sessionId)}
                busy={busyId === t.id}
                onToggle={() => toggle(t)}
                onEdit={() => { setEditing(t); setEditorOpen(true) }}
                onDelete={() => remove(t)}
              />
            ))}
          </div>
        )}
      </div>

      {editorOpen && (
        <TunnelEditor
          tunnel={editing}
          sshSessions={sshSessions}
          onClose={() => setEditorOpen(false)}
          onSaved={() => { setEditorOpen(false); refresh() }}
        />
      )}
    </div>
  )
}

function routeText(t: TunnelInfo): string {
  if (t.type === 'dynamic') return `socks5://127.0.0.1:${t.listenPort}`
  if (t.type === 'remote') return `server:${t.listenPort} → ${t.targetHost}:${t.targetPort}`
  return `127.0.0.1:${t.listenPort} → ${t.targetHost}:${t.targetPort}`
}

function TunnelCard({ tunnel, via, busy, onToggle, onEdit, onDelete }: {
  tunnel: TunnelInfo
  via: string
  busy: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const meta = TYPE_META[tunnel.type]
  const active = tunnel.status === 'active'

  return (
    <div
      className="flex items-center gap-4 rounded-md px-4 py-3"
      style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
    >
      {active ? (
        <span className="relative w-2 h-2 flex-shrink-0">
          <span className="absolute inset-0 rounded-full animate-ping" style={{ background: 'rgba(16,185,129,0.4)' }} />
          <span className="w-full h-full rounded-full block" style={{ background: '#10B981' }} />
        </span>
      ) : (
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: tunnel.status === 'error' ? '#EF4444' : 'var(--nox-text-3)' }}
        />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[13px] truncate" style={{ color: 'var(--nox-text)' }}>
            {tunnel.label || routeText(tunnel)}
          </span>
          <span
            className="font-['Inter'] text-[9.5px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
            style={{ background: meta.color + '18', color: meta.color }}
          >
            {meta.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 font-mono text-[11px]" style={{ color: 'var(--nox-text-2)' }}>
          {tunnel.type === 'dynamic' ? (
            <>
              <Globe className="w-3 h-3" />
              <span>socks5://127.0.0.1:{tunnel.listenPort}</span>
            </>
          ) : (
            <>
              <span>{tunnel.type === 'remote' ? `server:${tunnel.listenPort}` : `127.0.0.1:${tunnel.listenPort}`}</span>
              <ArrowRight className="w-3 h-3" />
              <span>{tunnel.targetHost}:{tunnel.targetPort}</span>
            </>
          )}
          <span style={{ color: 'var(--nox-text-3)' }}>via {via}</span>
          {active && tunnel.connections > 0 && (
            <span style={{ color: 'var(--nox-text-3)' }}>· {tunnel.connections} conn</span>
          )}
        </div>
        {tunnel.error && (
          <p className="font-['Inter'] text-[11px] mt-1" style={{ color: '#EF4444' }}>{tunnel.error}</p>
        )}
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={onToggle}
          disabled={busy}
          title={active ? 'Stop tunnel' : 'Start tunnel'}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-['Inter'] text-[11.5px] font-medium transition-colors disabled:opacity-50"
          style={active
            ? { background: 'rgba(239,68,68,0.1)', color: '#EF4444' }
            : { background: 'rgba(16,185,129,0.1)', color: '#10B981' }}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : active ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
          {active ? 'Stop' : 'Start'}
        </button>
        <IconButton title="Edit" onClick={onEdit}><Pencil className="w-3.5 h-3.5" /></IconButton>
        <IconButton title="Delete" onClick={onDelete} danger><Trash2 className="w-3.5 h-3.5" /></IconButton>
      </div>
    </div>
  )
}

function IconButton({ title, onClick, danger, children }: {
  title: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="p-1.5 rounded transition-colors"
      style={{ color: 'var(--nox-text-2)' }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'var(--nox-hover)'
        if (danger) e.currentTarget.style.color = '#EF4444'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--nox-text-2)'
      }}
    >
      {children}
    </button>
  )
}

function TunnelEditor({ tunnel, sshSessions, onClose, onSaved }: {
  tunnel: TunnelInfo | null
  sshSessions: Session[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    sessionId: tunnel?.sessionId ?? sshSessions[0]?.id ?? '',
    type: tunnel?.type ?? 'local' as TunnelInfo['type'],
    label: tunnel?.label ?? '',
    listenPort: tunnel ? String(tunnel.listenPort) : '',
    targetHost: tunnel?.targetHost ?? '',
    targetPort: tunnel ? String(tunnel.targetPort ?? '') : '',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = (field: string, value: string) => {
    setError('')
    setForm(f => ({ ...f, [field]: value }))
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!form.sessionId) return setError('Choose an SSH connection')
    const listenPort = parseInt(form.listenPort)
    if (!listenPort || listenPort < 1 || listenPort > 65535) return setError('Listen port must be 1–65535')
    if (form.type !== 'dynamic') {
      if (!form.targetHost.trim()) return setError('Target host is required')
      const targetPort = parseInt(form.targetPort)
      if (!targetPort || targetPort < 1 || targetPort > 65535) return setError('Target port must be 1–65535')
    }

    setSaving(true)
    try {
      await window.api.tunnels.save(
        {
          sessionId: form.sessionId,
          type: form.type,
          label: form.label.trim() || undefined,
          listenPort,
          targetHost: form.type !== 'dynamic' ? form.targetHost.trim() : undefined,
          targetPort: form.type !== 'dynamic' ? parseInt(form.targetPort) : undefined,
        },
        tunnel?.id,
      )
      onSaved()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to save tunnel')
      setSaving(false)
    }
  }

  const inputStyle = {
    background: 'var(--nox-bg)',
    border: '1px solid var(--nox-border)',
    color: 'var(--nox-text)',
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <form
        onSubmit={save}
        className="w-[420px] rounded-xl overflow-hidden animate-slide-up"
        style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--nox-border)' }}>
          <h2 className="font-['Plus_Jakarta_Sans'] font-bold text-[15px]" style={{ color: 'var(--nox-text)' }}>
            {tunnel ? 'Edit Tunnel' : 'New Tunnel'}
          </h2>
          <button type="button" onClick={onClose} className="p-1 rounded" style={{ color: 'var(--nox-text-3)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold block mb-2" style={{ color: 'var(--nox-text-3)' }}>
              Tunnel Type
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(TYPE_META) as TunnelInfo['type'][]).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => set('type', t)}
                  className="px-2 py-1.5 rounded-md font-['Inter'] text-[11.5px] font-medium transition-colors"
                  style={form.type === t
                    ? { background: TYPE_META[t].color, color: '#fff' }
                    : { border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
                >
                  {TYPE_META[t].label}
                </button>
              ))}
            </div>
            <p className="font-['Inter'] text-[11px] mt-1.5" style={{ color: 'var(--nox-text-2)' }}>
              {TYPE_META[form.type].description}
            </p>
          </div>

          <Field label="SSH Connection">
            <select
              value={form.sessionId}
              onChange={e => set('sessionId', e.target.value)}
              className="w-full rounded-md px-3 py-1.5 font-['Inter'] text-[12.5px] focus:outline-none"
              style={inputStyle}
            >
              {sshSessions.map(s => (
                <option key={s.id} value={s.id}>{s.label || s.host}</option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={form.type === 'remote' ? 'Server Listen Port' : 'Local Listen Port'}>
              <input
                value={form.listenPort}
                onChange={e => set('listenPort', e.target.value)}
                placeholder={form.type === 'dynamic' ? '1080' : '8080'}
                className="w-full rounded-md px-3 py-1.5 font-mono text-[12.5px] focus:outline-none"
                style={inputStyle}
              />
            </Field>
            <Field label="Label (optional)">
              <input
                value={form.label}
                onChange={e => set('label', e.target.value)}
                placeholder="Staging DB"
                className="w-full rounded-md px-3 py-1.5 font-['Inter'] text-[12.5px] focus:outline-none"
                style={inputStyle}
              />
            </Field>
          </div>

          {form.type !== 'dynamic' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={form.type === 'remote' ? 'Forward To (local)' : 'Target Host (from server)'}>
                <input
                  value={form.targetHost}
                  onChange={e => set('targetHost', e.target.value)}
                  placeholder={form.type === 'remote' ? '127.0.0.1' : 'db.internal'}
                  className="w-full rounded-md px-3 py-1.5 font-mono text-[12.5px] focus:outline-none"
                  style={inputStyle}
                />
              </Field>
              <Field label="Target Port">
                <input
                  value={form.targetPort}
                  onChange={e => set('targetPort', e.target.value)}
                  placeholder="5432"
                  className="w-full rounded-md px-3 py-1.5 font-mono text-[12.5px] focus:outline-none"
                  style={inputStyle}
                />
              </Field>
            </div>
          )}

          {error && <p className="font-['Inter'] text-[12px]" style={{ color: '#EF4444' }}>{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: '1px solid var(--nox-border)' }}>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md font-['Inter'] text-[12px]"
            style={{ color: 'var(--nox-text-2)', border: '1px solid var(--nox-border)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: '#3B5CCC' }}
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {tunnel ? 'Save Changes' : 'Create Tunnel'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold block mb-1.5" style={{ color: 'var(--nox-text-3)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}
