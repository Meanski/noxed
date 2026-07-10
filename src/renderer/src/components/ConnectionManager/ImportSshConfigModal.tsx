import { useEffect, useState } from 'react'
import { X, FileDown, Check, Loader2, Key, Terminal } from 'lucide-react'
import { useAppStore } from '../../store'

interface SshConfigHost {
  alias: string
  host: string
  port: number
  username?: string
  keyPath?: string
  proxyJump?: string
}

interface Props {
  onClose: () => void
}

export default function ImportSshConfigModal({ onClose }: Props) {
  const sessions = useAppStore(s => s.sessions)
  const addSession = useAppStore(s => s.addSession)
  const updateSession = useAppStore(s => s.updateSession)
  const addNotification = useAppStore(s => s.addNotification)

  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  const existingKeys = new Set(
    sessions
      .filter(s => !s.type || s.type === 'ssh')
      .map(s => `${s.host}:${s.port}:${s.username ?? ''}`)
  )
  const isExisting = (h: SshConfigHost) => existingKeys.has(`${h.host}:${h.port}:${h.username ?? ''}`)

  useEffect(() => {
    window.api.sshConfig.hosts()
      .then(found => {
        setHosts(found)
        setSelected(new Set(found.filter(h => !isExisting(h)).map(h => h.alias)))
      })
      .catch((err: any) => setError(err?.message ?? 'Failed to read SSH config'))
  }, [])

  function toggle(alias: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })
  }

  async function handleImport() {
    if (!hosts) return
    const picked = hosts.filter(h => selected.has(h.alias))
    setImporting(true)
    try {
      const createdByAlias = new Map<string, { id: string }>()
      for (const h of picked) {
        const session = await window.api.sessions.create({
          label: h.alias,
          host: h.host,
          port: h.port,
          username: h.username ?? '',
          authType: h.keyPath ? 'key' : 'password',
          keyPath: h.keyPath,
          type: 'ssh',
          tags: [],
          isFavorite: false,
        })
        addSession(session)
        createdByAlias.set(h.alias, session)
      }

      // Second pass: resolve ProxyJump references now that every imported
      // host has an id. A hop can name an imported alias or an existing
      // connection (by label or hostname).
      for (const h of picked) {
        if (!h.proxyJump) continue
        const hopHost = h.proxyJump.replace(/^.*@/, '').replace(/:\d+$/, '')
        const target =
          createdByAlias.get(h.proxyJump) ??
          createdByAlias.get(hopHost) ??
          sessions.find(s => (s.type ?? 'ssh') === 'ssh' && (s.label === hopHost || s.host === hopHost))
        const source = createdByAlias.get(h.alias)
        if (!target || !source || target.id === source.id) continue
        const updated = await window.api.sessions.update(source.id, { jumpHostId: target.id })
        updateSession(source.id, updated)
      }

      addNotification({
        type: 'success',
        message: `Imported ${picked.length} connection${picked.length !== 1 ? 's' : ''} from SSH config`,
      })
      onClose()
    } catch (err: any) {
      setError(err?.message ?? 'Import failed')
      setImporting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-[480px] max-h-[70vh] flex flex-col rounded-xl overflow-hidden animate-slide-up"
        style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--nox-border)' }}>
          <div className="flex items-center gap-2.5">
            <FileDown className="w-4 h-4" style={{ color: '#3B5CCC' }} />
            <div>
              <h2 className="font-['Plus_Jakarta_Sans'] font-bold text-[15px]" style={{ color: 'var(--nox-text)' }}>
                Import from SSH config
              </h2>
              <p className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>
                Hosts found in ~/.ssh/config
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded transition-colors"
            style={{ color: 'var(--nox-text-3)' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--nox-text)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--nox-text-3)' }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {error && (
            <p className="font-['Inter'] text-[12.5px] px-2 py-3" style={{ color: '#EF4444' }}>{error}</p>
          )}
          {!error && hosts === null && (
            <div className="flex items-center justify-center gap-2 py-10" style={{ color: 'var(--nox-text-2)' }}>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="font-['Inter'] text-[12.5px]">Reading SSH config…</span>
            </div>
          )}
          {!error && hosts?.length === 0 && (
            <p className="font-['Inter'] text-[12.5px] text-center py-10" style={{ color: 'var(--nox-text-2)' }}>
              No importable hosts found in ~/.ssh/config.
            </p>
          )}
          {hosts?.map(h => {
            const exists = isExisting(h)
            const checked = selected.has(h.alias)
            return (
              <label
                key={h.alias}
                className="flex items-center gap-3 px-2 py-2 rounded-md cursor-pointer"
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <div
                  className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                  style={{
                    border: `2px solid ${checked ? '#3B5CCC' : 'var(--nox-border)'}`,
                    background: checked ? '#3B5CCC' : 'transparent',
                  }}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(h.alias)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(h.alias) } }}
                >
                  {checked && <Check className="w-3 h-3 text-white" />}
                </div>
                <Terminal className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#3B5CCC' }} />
                <div className="flex-1 min-w-0">
                  <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[12.5px] block truncate" style={{ color: 'var(--nox-text)' }}>
                    {h.alias}
                  </span>
                  <span className="font-mono text-[11px] block truncate" style={{ color: 'var(--nox-text-2)' }}>
                    {h.username ? `${h.username}@` : ''}{h.host}{h.port !== 22 ? `:${h.port}` : ''}
                  </span>
                </div>
                {h.keyPath && (
                  <span title={h.keyPath}>
                    <Key className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
                  </span>
                )}
                {exists && (
                  <span
                    className="font-['Inter'] text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                    style={{ background: 'var(--nox-sidebar)', color: 'var(--nox-text-3)' }}
                  >
                    already added
                  </span>
                )}
              </label>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: '1px solid var(--nox-border)' }}>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md font-['Inter'] text-[12px] transition-colors"
            style={{ color: 'var(--nox-text-2)', border: '1px solid var(--nox-border)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={importing || selected.size === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] font-medium text-white transition-colors disabled:opacity-50"
            style={{ background: '#3B5CCC' }}
          >
            {importing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Import {selected.size > 0 ? `(${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
