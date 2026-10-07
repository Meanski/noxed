import { useState } from 'react'
import { ChevronDown, ChevronRight, Database, Loader2, Table2 } from 'lucide-react'
import { formatBytesLong, ipcErrorMessage } from '../../lib/format'

interface MongoSidebarProps {
  clientId: string
  databases: Array<{ name: string; sizeOnDisk: number }>
  selected: { db: string; collection: string } | null
  onSelect: (db: string, collection: string) => void
}

// Databases, expanding to their collections on demand.
export default function MongoSidebar({ clientId, databases, selected, onSelect }: Readonly<MongoSidebarProps>) {
  const [collections, setCollections] = useState<Record<string, string[] | 'loading' | { error: string }>>({})

  const toggle = (db: string) => {
    if (collections[db]) {
      setCollections(({ [db]: _closed, ...rest }) => rest)
      return
    }
    setCollections((c) => ({ ...c, [db]: 'loading' }))
    window.api.mongo.collections(clientId, db).then(
      (names) => setCollections((c) => ({ ...c, [db]: names })),
      (err: unknown) => setCollections((c) => ({ ...c, [db]: { error: ipcErrorMessage(err, 'Could not list collections') } })),
    )
  }

  return (
    <nav aria-label="Databases" className="h-full overflow-y-auto py-2 text-[12px]" style={{ background: 'var(--nox-sidebar)' }}>
      {databases.map((d) => {
        const state = collections[d.name]
        return (
          <div key={d.name}>
            <button
              type="button"
              aria-expanded={!!state}
              onClick={() => toggle(d.name)}
              className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--nox-hover)]"
              style={{ color: 'var(--nox-text)' }}
            >
              {state ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <Database className="w-3.5 h-3.5" style={{ color: 'var(--nox-text-2)' }} />
              <span className="truncate">{d.name}</span>
              <span className="ml-auto text-[10px]" style={{ color: 'var(--nox-text-2)' }}>{formatBytesLong(d.sizeOnDisk)}</span>
            </button>
            {state === 'loading' && <Loader2 className="w-3 h-3 animate-spin ml-8 my-1" style={{ color: 'var(--nox-text-2)' }} />}
            {state && typeof state === 'object' && !Array.isArray(state) && (
              <p className="ml-8 my-1 text-[11px]" role="alert" style={{ color: 'var(--nox-danger-text)' }}>{state.error}</p>
            )}
            {Array.isArray(state) && state.length === 0 && (
              <p className="ml-8 my-1 text-[11px]" style={{ color: 'var(--nox-text-2)' }}>No collections</p>
            )}
            {Array.isArray(state) && state.map((name) => {
              const active = selected?.db === d.name && selected.collection === name
              return (
                <button
                  key={name}
                  type="button"
                  aria-current={active}
                  onClick={() => onSelect(d.name, name)}
                  className="w-full flex items-center gap-1.5 pl-8 pr-2 py-1 text-left hover:bg-[var(--nox-hover)]"
                  style={{ color: active ? 'var(--nox-active-t)' : 'var(--nox-text)', background: active ? 'var(--nox-active)' : undefined }}
                >
                  <Table2 className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{name}</span>
                </button>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
