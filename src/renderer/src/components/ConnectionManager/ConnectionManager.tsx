import { useState } from 'react'
import {
  Filter, Search, Plus, Terminal, FolderOpen, Database, Boxes,
  Plug, Pencil, Copy, Trash2, ChevronDown, ChevronUp, Check, FileDown,
} from 'lucide-react'
import { useAppStore, Session } from '../../store'
import ImportSshConfigModal from './ImportSshConfigModal'

type FilterType = 'ssh' | 'sftp' | 'database' | 'kubernetes' | 'online' | 'offline'

export default function ConnectionManager() {
  const { sessions, openTab, removeSession, setShowAddConnection, setEditingConnectionId } = useAppStore()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Set<FilterType>>(new Set())
  const [filterOpen, setFilterOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const tabs = useAppStore(s => s.tabs)

  const connectedIds = new Set(tabs.filter(t => t.status === 'connected').map(t => t.sessionId))

  const filtered = sessions.filter(s => {
    const name = (s.label || s.host).toLowerCase()
    const host = s.host.toLowerCase()
    if (search && !name.includes(search.toLowerCase()) && !host.includes(search.toLowerCase())) {
      return false
    }
    if (filters.size > 0) {
      const sType = s.type ?? 'ssh'
      const hasType = filters.has(sType as FilterType)
      const isOnline = connectedIds.has(s.id)
      const hasStatus = filters.has('online') && isOnline || filters.has('offline') && !isOnline
      if (!hasType && !hasStatus) return false
    }
    return true
  })

  const toggleFilter = (f: FilterType) => {
    setFilters(prev => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f)
      else next.add(f)
      return next
    })
  }

  const handleDelete = async (id: string) => {
    if (confirm('Delete this connection?')) {
      await window.api.sessions.delete(id)
      removeSession(id)
    }
  }

  const handleDuplicate = async (s: Session) => {
    const { id, createdAt, hasPassword, ...rest } = s
    // Copy the stored password too, otherwise the duplicate cannot connect
    let password: string | undefined
    if (hasPassword) {
      password = (await window.api.sessions.getCredentials(s.id).catch(() => null))?.password
    }
    const newSession = await window.api.sessions.create({ ...rest, password, label: `${s.label || s.host} (copy)` })
    useAppStore.getState().addSession(newSession)
  }

  const handleConnect = (s: Session) => {
    if (s.type === 'kubernetes') return
    openTab(s)
  }

  const typeColor: Record<string, string> = {
    ssh: '#3B5CCC', sftp: '#EC4899', database: '#10B981', kubernetes: '#8B5CF6',
  }
  const typeLabel: Record<string, string> = {
    ssh: 'SSH', sftp: 'SFTP', database: 'Database', kubernetes: 'Kubernetes',
  }
  const TypeIcon = ({ type, ...props }: { type?: string; [k: string]: any }) => {
    const t = type ?? 'ssh'
    switch (t) {
      case 'sftp': return <FolderOpen {...props} />
      case 'database': return <Database {...props} />
      case 'kubernetes': return <Boxes {...props} />
      default: return <Terminal {...props} />
    }
  }

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--nox-bg)' }}>
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="font-['Plus_Jakarta_Sans'] font-bold text-[22px]" style={{ color: 'var(--nox-text)' }}>
              Connections
            </h1>
            <p className="font-['Inter'] text-[12.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
              {sessions.length} connection{sessions.length !== 1 ? 's' : ''} configured
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Filter */}
            <div className="relative">
              <button
                onClick={() => setFilterOpen(o => !o)}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-['Inter'] text-[12px] transition-colors"
                style={{
                  background: filters.size > 0 ? '#EBF0FF' : 'var(--nox-shell)',
                  border: `1px solid ${filters.size > 0 ? '#3B5CCC' : 'var(--nox-border)'}`,
                  color: filters.size > 0 ? '#3B5CCC' : 'var(--nox-text-2)',
                }}
              >
                <Filter className="w-3.5 h-3.5" />
                Filter {filters.size > 0 && `(${filters.size})`}
                {filterOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>

              {filterOpen && (
                <div
                  className="absolute top-full left-0 mt-1 w-56 rounded-md py-1.5 z-50"
                  style={{
                    background: 'var(--nox-shell)',
                    border: '1px solid var(--nox-border)',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                  }}
                >
                  <div
                    className="px-3 py-1.5 font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold"
                    style={{ color: 'var(--nox-text-3)' }}
                  >
                    Connection Type
                  </div>
                  {(['ssh', 'sftp', 'database', 'kubernetes'] as FilterType[]).map(ft => (
                    <label
                      key={ft}
                      className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                    >
                      <div
                        className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                        style={{
                          border: `2px solid ${filters.has(ft) ? '#3B5CCC' : 'var(--nox-border)'}`,
                          background: filters.has(ft) ? '#3B5CCC' : 'transparent',
                        }}
                        onClick={() => toggleFilter(ft)}
                      >
                        {filters.has(ft) && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <span className="w-2 h-2 rounded-full" style={{ background: typeColor[ft] }} />
                      <span className="font-['Inter'] text-[12.5px]" style={{ color: 'var(--nox-text)' }}>{typeLabel[ft]}</span>
                    </label>
                  ))}
                  <div style={{ borderTop: '1px solid var(--nox-border)', marginTop: 4, paddingTop: 4 }}>
                    <div
                      className="px-3 py-1.5 font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold"
                      style={{ color: 'var(--nox-text-3)' }}
                    >
                      Status
                    </div>
                    {(['online', 'offline'] as FilterType[]).map(ft => (
                      <label
                        key={ft}
                        className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                      >
                        <div
                          className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                          style={{
                            border: `2px solid ${filters.has(ft) ? '#3B5CCC' : 'var(--nox-border)'}`,
                            background: filters.has(ft) ? '#3B5CCC' : 'transparent',
                          }}
                          onClick={() => toggleFilter(ft)}
                        >
                          {filters.has(ft) && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <span className="w-2 h-2 rounded-full" style={{ background: ft === 'online' ? '#10B981' : 'var(--nox-text-3)' }} />
                        <span className="font-['Inter'] text-[12.5px] capitalize" style={{ color: 'var(--nox-text)' }}>{ft}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Search */}
            <div
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5"
              style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
            >
              <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="font-['Inter'] text-[12px] bg-transparent outline-none w-32"
                style={{ color: 'var(--nox-text)' }}
              />
            </div>

            <button
              onClick={() => setImportOpen(true)}
              title="Import hosts from ~/.ssh/config"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-['Inter'] text-[12px] transition-colors"
              style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--nox-text)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--nox-text-2)' }}
            >
              <FileDown className="w-3.5 h-3.5" />
              Import
            </button>

            <button
              onClick={() => setShowAddConnection(true)}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 font-['Inter'] text-[12px] font-medium text-white transition-colors"
              style={{ background: '#3B5CCC' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#2A4299' }}
              onMouseLeave={e => { e.currentTarget.style.background = '#3B5CCC' }}
            >
              <Plus className="w-3.5 h-3.5" />
              Add Connection
            </button>
          </div>
        </div>

        {/* Table */}
        {filtered.length === 0 ? (
          <div
            className="rounded-md p-10 text-center"
            style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
          >
            <p className="font-['Inter'] text-[13px] mb-3" style={{ color: 'var(--nox-text-2)' }}>
              {sessions.length === 0 ? 'No connections configured yet.' : 'No connections match your search.'}
            </p>
            {sessions.length === 0 && (
              <button
                onClick={() => setShowAddConnection(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] text-[#3B5CCC] border border-[#3B5CCC]/30 hover:bg-[#EBF0FF] transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Connection
              </button>
            )}
          </div>
        ) : (
          <div className="rounded-md overflow-hidden" style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}>
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-sidebar)' }}>
                  {['Name', 'Type', 'Host', 'Status', 'Tags', ''].map(h => (
                    <th
                      key={h}
                      className="text-left font-['Plus_Jakarta_Sans'] text-[10.5px] uppercase tracking-wider font-semibold px-4 py-2.5"
                      style={{ color: 'var(--nox-text-3)', textAlign: h === '' ? 'right' : 'left' }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((conn, i) => {
                  const color = conn.color ?? typeColor[conn.type ?? 'ssh'] ?? '#3B5CCC'
                  const isConnected = connectedIds.has(conn.id)
                  const tags = conn.tags ?? []
                  const connType = conn.type ?? 'ssh'
                  return (
                    <tr
                      key={conn.id}
                      className="group cursor-pointer"
                      style={i < filtered.length - 1 ? { borderBottom: '1px solid var(--nox-border)' } : {}}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center">
                          <div className="w-1 h-10 rounded-full mr-3 flex-shrink-0" style={{ background: color }} />
                          <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: color + '18' }}>
                              <TypeIcon type={connType} className="w-3.5 h-3.5" style={{ color }} />
                            </div>
                            <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[13px]" style={{ color: 'var(--nox-text)' }}>
                              {conn.label || conn.host}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text)' }}>
                          {typeLabel[connType] ?? connType}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>
                          {conn.host}:{conn.port}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="inline-flex items-center gap-1.5 font-['Inter'] text-[11.5px] font-medium"
                          style={{ color: isConnected ? '#10B981' : 'var(--nox-text-3)' }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: isConnected ? '#10B981' : 'var(--nox-text-3)' }} />
                          {isConnected ? 'Connected' : 'Idle'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          {tags.map((tag, j) => (
                            <span
                              key={j}
                              className="font-['Inter'] text-[10px] px-2 py-0.5 rounded"
                              style={{ background: 'var(--nox-sidebar)', color: 'var(--nox-text-2)' }}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            title="Connect"
                            onClick={() => handleConnect(conn)}
                            className="p-1 rounded transition-colors"
                            style={{ color: 'var(--nox-text-2)' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#3B5CCC'; (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--nox-text-2)'; (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                          >
                            <Plug className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Edit"
                            onClick={() => { setEditingConnectionId(conn.id); setShowAddConnection(true) }}
                            className="p-1 rounded transition-colors"
                            style={{ color: 'var(--nox-text-2)' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Duplicate"
                            onClick={() => handleDuplicate(conn)}
                            className="p-1 rounded transition-colors"
                            style={{ color: 'var(--nox-text-2)' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Delete"
                            onClick={() => handleDelete(conn.id)}
                            className="p-1 rounded transition-colors"
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#EF4444'; (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--nox-text-2)'; (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                            style={{ color: 'var(--nox-text-2)' }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {importOpen && <ImportSshConfigModal onClose={() => setImportOpen(false)} />}
    </div>
  )
}
