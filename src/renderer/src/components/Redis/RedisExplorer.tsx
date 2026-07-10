import { useState, useEffect, useRef } from 'react'
import { Search, RefreshCw, Trash2, X, Loader } from 'lucide-react'
import { useAppStore, Tab } from '../../store'

interface KeyEntry {
  key: string
  type?: string
}

interface KeyValue {
  type: string
  value: any
  ttl: number
}

export default function RedisExplorer({ tab }: Readonly<{ tab: Tab }>) {
  const { sessions, updateTab } = useAppStore()
  const session = sessions.find(s => s.id === tab.sessionId)
  const [clientId, setClientId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const [keys, setKeys] = useState<KeyEntry[]>([])
  const [pattern, setPattern] = useState('*')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [keyValue, setKeyValue] = useState<KeyValue | null>(null)
  const [loadingKeys, setLoadingKeys] = useState(false)
  const [loadingValue, setLoadingValue] = useState(false)
  const [cmdInput, setCmdInput] = useState('')
  const [cmdHistory, setCmdHistory] = useState<{ cmd: string; result: string }[]>([])
  const [activeTab, setActiveTab] = useState<'browser' | 'cli'>('browser')
  const cmdRef = useRef<HTMLInputElement>(null)
  const clientRef = useRef<string | null>(null)

  useEffect(() => {
    if (!session) return
    connect()
    return () => {
      if (clientRef.current) {
        window.api.redis.disconnect(clientRef.current).catch((err: any) => {
          // Best-effort: main may have already cleaned up on window close.
          console.error('[redis] disconnect on unmount failed:', err?.message ?? err)
        })
      }
    }
  }, [])

  const connect = async () => {
    if (!session) return
    setConnecting(true)
    setError('')
    try {
      const creds = tab.sessionId
        ? await window.api.sessions.getCredentials(tab.sessionId).catch((err: any) => {
            const msg = err?.message ?? 'Failed to retrieve credentials'
            throw new Error(msg.includes('locked') ? 'App is locked — unlock noxed to reconnect' : msg)
          })
        : null

      const id = await window.api.redis.connect({
        host: session.host,
        port: session.port || 6379,
        password: creds?.password || undefined,
        db: session.redisDb ?? 0,
      })
      setClientId(id)
      clientRef.current = id
      updateTab(tab.id, { status: 'connected' })
      await loadKeys(id, pattern)
    } catch (e: any) {
      setError(e.message ?? 'Connection failed')
      updateTab(tab.id, { status: 'error' })
    } finally {
      setConnecting(false)
    }
  }

  const loadKeys = async (id: string, pat: string) => {
    setLoadingKeys(true)
    try {
      const result = await window.api.redis.keys(id, pat || '*')
      setKeys((result as string[]).sort((a, b) => a.localeCompare(b)).map(k => ({ key: k })))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingKeys(false)
    }
  }

  const selectKey = async (key: string) => {
    if (!clientId) return
    setSelectedKey(key)
    setLoadingValue(true)
    try {
      const result = await window.api.redis.get(clientId, key)
      setKeyValue(result as KeyValue)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingValue(false)
    }
  }

  const handleDelete = async (key: string) => {
    if (!clientId) return
    await window.api.redis.del(clientId, key)
    setKeys(prev => prev.filter(k => k.key !== key))
    if (selectedKey === key) { setSelectedKey(null); setKeyValue(null) }
  }

  const handleCommand = async () => {
    if (!clientId || !cmdInput.trim()) return
    const cmd = cmdInput.trim()
    setCmdInput('')
    try {
      const result = await window.api.redis.command(clientId, cmd)
      setCmdHistory(prev => [...prev, { cmd, result: JSON.stringify(result, null, 2) }])
    } catch (e: any) {
      setCmdHistory(prev => [...prev, { cmd, result: `ERR: ${e.message}` }])
    }
  }

  if (connecting) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--nox-bg)' }}>
        <div className="flex items-center gap-3" style={{ color: 'var(--nox-text-2)' }}>
          <Loader className="w-4 h-4 animate-spin" />
          <span className="font-['Inter'] text-[13px]">Connecting to Redis…</span>
        </div>
      </div>
    )
  }

  if (error && !clientId) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--nox-bg)' }}>
        <div className="text-center">
          <p className="font-['Inter'] text-[13px] text-[#EF4444] mb-3">{error}</p>
          <button
            onClick={connect}
            className="px-4 py-2 rounded-md text-white font-['Inter'] text-[12px]"
            style={{ background: '#DC382D' }}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--nox-bg)' }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-3 flex-shrink-0"
        style={{ background: 'var(--nox-shell)', borderBottom: '1px solid var(--nox-border)' }}
      >
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[#DC382D]" />
          <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[14px]" style={{ color: 'var(--nox-text)' }}>
            {session?.label || session?.host}
          </span>
          <span className="font-['Inter'] text-[11px] px-2 py-0.5 rounded" style={{ background: '#DC382D20', color: '#DC382D' }}>
            Redis · DB {session?.redisDb ?? 0}
          </span>
          {clientId && (
            <span className="font-['Inter'] text-[11px]" style={{ color: 'var(--nox-text-2)' }}>
              {keys.length} keys
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('browser')}
            className="px-3 py-1.5 rounded-md font-['Inter'] text-[11.5px] transition-colors"
            style={activeTab === 'browser'
              ? { background: '#DC382D', color: '#fff' }
              : { color: 'var(--nox-text-2)' }}
          >
            Key Browser
          </button>
          <button
            onClick={() => setActiveTab('cli')}
            className="px-3 py-1.5 rounded-md font-['Inter'] text-[11.5px] transition-colors"
            style={activeTab === 'cli'
              ? { background: '#DC382D', color: '#fff' }
              : { color: 'var(--nox-text-2)' }}
          >
            CLI
          </button>
        </div>
      </div>

      {activeTab === 'browser' ? (
        <div className="flex flex-1 overflow-hidden">
          <KeyListPane
            keys={keys}
            pattern={pattern}
            setPattern={setPattern}
            loadingKeys={loadingKeys}
            selectedKey={selectedKey}
            onQuery={() => { if (clientId) loadKeys(clientId, pattern) }}
            onSelect={selectKey}
            onDelete={handleDelete}
          />
          <ValuePane
            selectedKey={selectedKey}
            keyValue={keyValue}
            loadingValue={loadingValue}
            onClose={() => { setSelectedKey(null); setKeyValue(null) }}
          />
        </div>
      ) : (
        <CliPane
          cmdHistory={cmdHistory}
          cmdInput={cmdInput}
          setCmdInput={setCmdInput}
          onSubmit={handleCommand}
          inputRef={cmdRef}
        />
      )}
    </div>
  )
}

function KeyListPane({ keys, pattern, setPattern, loadingKeys, selectedKey, onQuery, onSelect, onDelete }: Readonly<{
  keys: KeyEntry[]
  pattern: string
  setPattern: (p: string) => void
  loadingKeys: boolean
  selectedKey: string | null
  onQuery: () => void
  onSelect: (key: string) => void
  onDelete: (key: string) => void
}>) {
  return (
    <div
      className="flex flex-col flex-shrink-0 overflow-hidden"
      style={{ width: 260, borderRight: '1px solid var(--nox-border)' }}
    >
      <div className="p-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--nox-border)' }}>
        <div className="flex items-center gap-2">
          <div
            className="flex items-center gap-1.5 flex-1 rounded px-2 py-1.5"
            style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}
          >
            <Search className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
            <input
              value={pattern}
              onChange={e => setPattern(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onQuery() }}
              placeholder="Pattern (e.g. user:*)"
              className="flex-1 bg-transparent outline-none font-['Inter'] text-[11.5px]"
              style={{ color: 'var(--nox-text)' }}
            />
          </div>
          <button
            onClick={onQuery}
            className="p-1.5 rounded transition-colors"
            style={{ color: 'var(--nox-text-2)' }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingKeys ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {keys.length === 0 ? (
          <div className="p-4 text-center">
            <p className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-3)' }}>
              {loadingKeys ? 'Loading…' : 'No keys found'}
            </p>
          </div>
        ) : (
          keys.map(({ key }) => (
            <div
              key={key}
              className="group flex items-center gap-2 pr-3 transition-colors"
              style={{
                background: selectedKey === key ? '#DC382D18' : 'transparent',
                borderLeft: selectedKey === key ? '2px solid #DC382D' : '2px solid transparent',
              }}
              onMouseEnter={e => { if (selectedKey !== key) (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { if (selectedKey !== key) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <button
                type="button"
                onClick={() => onSelect(key)}
                className="flex-1 min-w-0 flex items-center text-left pl-3 py-2 cursor-pointer"
              >
                <span
                  className="font-mono text-[11px] flex-1 truncate"
                  style={{ color: selectedKey === key ? '#DC382D' : 'var(--nox-text)' }}
                >
                  {key}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(key)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded transition-opacity"
                style={{ color: '#EF4444' }}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function ValuePane({ selectedKey, keyValue, loadingValue, onClose }: Readonly<{
  selectedKey: string | null
  keyValue: KeyValue | null
  loadingValue: boolean
  onClose: () => void
}>) {
  if (!selectedKey) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="h-full flex items-center justify-center">
          <p className="font-['Inter'] text-[13px]" style={{ color: 'var(--nox-text-3)' }}>
            Select a key to view its value
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex flex-col h-full overflow-hidden">
        <div
          className="px-5 py-3 flex items-center justify-between flex-shrink-0"
          style={{ borderBottom: '1px solid var(--nox-border)' }}
        >
          <div className="flex items-center gap-3">
            <span className="font-mono text-[13px] font-medium" style={{ color: 'var(--nox-text)' }}>{selectedKey}</span>
            {keyValue && (
              <>
                <span
                  className="font-['Inter'] text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide"
                  style={{ background: '#DC382D20', color: '#DC382D' }}
                >
                  {keyValue.type}
                </span>
                <span className="font-['Inter'] text-[11px]" style={{ color: 'var(--nox-text-3)' }}>
                  TTL: {keyValue.ttl === -1 ? 'No expiry' : `${keyValue.ttl}s`}
                </span>
              </>
            )}
          </div>
          <button onClick={onClose}>
            <X className="w-4 h-4" style={{ color: 'var(--nox-text-3)' }} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {loadingValue && (
            <div className="flex items-center gap-2" style={{ color: 'var(--nox-text-3)' }}>
              <Loader className="w-3.5 h-3.5 animate-spin" />
              <span className="font-['Inter'] text-[12px]">Loading…</span>
            </div>
          )}
          {!loadingValue && keyValue && <ValueViewer value={keyValue} />}
        </div>
      </div>
    </div>
  )
}

function CliPane({ cmdHistory, cmdInput, setCmdInput, onSubmit, inputRef }: Readonly<{
  cmdHistory: { cmd: string; result: string }[]
  cmdInput: string
  setCmdInput: (v: string) => void
  onSubmit: () => void
  inputRef: React.Ref<HTMLInputElement>
}>) {
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 font-mono text-[12px]" style={{ background: '#0D1117' }}>
        {cmdHistory.length === 0 ? (
          <p style={{ color: 'rgba(255,255,255,0.3)' }}>Type a Redis command below (e.g. INFO, DBSIZE, SET key value)</p>
        ) : (
          cmdHistory.map((h, i) => (
            <div key={`${i}-${h.cmd}`} className="mb-3">
              <div style={{ color: '#DC382D' }}>
                <span style={{ color: 'rgba(255,255,255,0.4)' }}>{'>'} </span>{h.cmd}
              </div>
              <pre className="mt-1 whitespace-pre-wrap" style={{ color: '#E6EDF3', paddingLeft: 14 }}>{h.result}</pre>
            </div>
          ))
        )}
      </div>
      <div
        className="flex items-center gap-2 px-4 py-3 flex-shrink-0"
        style={{ background: '#161B22', borderTop: '1px solid #30363D' }}
      >
        <span style={{ color: '#DC382D', fontFamily: 'monospace' }}>{'>'}</span>
        <input
          ref={inputRef}
          value={cmdInput}
          onChange={e => setCmdInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSubmit() }}
          placeholder="Enter command…"
          className="flex-1 bg-transparent outline-none font-mono text-[12px]"
          style={{ color: '#E6EDF3' }}
        />
      </div>
    </div>
  )
}

function ValueViewer({ value }: Readonly<{ value: KeyValue }>) {
  if (value.type === 'string') {
    return (
      <div
        className="rounded p-4 font-mono text-[12px] whitespace-pre-wrap break-all"
        style={{ background: 'var(--nox-surface)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
      >
        {value.value ?? '(nil)'}
      </div>
    )
  }
  if (value.type === 'hash' && value.value) {
    return (
      <div className="rounded overflow-hidden" style={{ border: '1px solid var(--nox-border)' }}>
        {Object.entries(value.value).map(([k, v], i) => (
          <div
            key={k}
            className="flex items-start px-4 py-2.5 font-mono text-[11.5px]"
            style={{
              borderTop: i > 0 ? '1px solid var(--nox-border)' : 'none',
              background: 'var(--nox-surface)',
            }}
          >
            <span className="w-1/3 flex-shrink-0 font-semibold" style={{ color: '#DC382D' }}>{k}</span>
            <span className="flex-1 break-all" style={{ color: 'var(--nox-text)' }}>{String(v)}</span>
          </div>
        ))}
      </div>
    )
  }
  if ((value.type === 'list' || value.type === 'set') && Array.isArray(value.value)) {
    return (
      <div className="rounded overflow-hidden" style={{ border: '1px solid var(--nox-border)' }}>
        {value.value.map((v, i) => (
          <div
            key={i}
            className="flex items-center px-4 py-2 font-mono text-[11.5px]"
            style={{ borderTop: i > 0 ? '1px solid var(--nox-border)' : 'none', background: 'var(--nox-surface)' }}
          >
            <span className="w-10 flex-shrink-0 text-[10px]" style={{ color: 'var(--nox-text-3)' }}>{i}</span>
            <span style={{ color: 'var(--nox-text)' }}>{String(v)}</span>
          </div>
        ))}
      </div>
    )
  }
  return (
    <pre
      className="rounded p-4 font-mono text-[11.5px] whitespace-pre-wrap"
      style={{ background: 'var(--nox-surface)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
    >
      {JSON.stringify(value.value, null, 2)}
    </pre>
  )
}
