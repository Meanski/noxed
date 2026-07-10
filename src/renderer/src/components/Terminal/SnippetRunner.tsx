import { useState } from 'react'
import { Play, Plus, Trash2, X, Code2, Variable, Copy, Globe, Server } from 'lucide-react'

export type SnippetScope = 'global' | 'host'

export interface Snippet {
  id: string
  label: string
  command: string
  tags: string[]
  scope: SnippetScope
}

const VAR_RE = /\{\{(\w+)\}\}/g

function extractVars(cmd: string): string[] {
  const vars: string[] = []
  let m: RegExpExecArray | null
  while ((m = VAR_RE.exec(cmd)) !== null) if (!vars.includes(m[1])) vars.push(m[1])
  return vars
}

function VarInput({ name, value, autoFocus, onChange, onEnter, onCancel }: Readonly<{
  name: string
  value: string
  autoFocus: boolean
  onChange: (value: string) => void
  onEnter: () => void
  onCancel: () => void
}>) {
  return (
    <div className="flex items-center gap-2">
      <Variable className="w-3 h-3 flex-shrink-0" style={{ color: '#9d6ff8' }} />
      <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'rgba(255,255,255,0.5)' }}>{name}</span>
      <input value={value} onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onEnter()
          if (e.key === 'Escape') onCancel()
        }}
        autoFocus={autoFocus}
        className="flex-1 bg-transparent text-[10px] font-mono px-1.5 py-0.5 rounded focus:outline-none"
        style={{ color: '#eeeef2', border: '1px solid rgba(157,111,248,0.3)' }} placeholder="value…" />
    </div>
  )
}

export default function SnippetRunner({ hostSnippets, globalSnippets, hostname, onRun, onSave, onDelete, onClose }: Readonly<{
  hostSnippets: Snippet[]
  globalSnippets: Snippet[]
  hostname: string
  onRun: (command: string) => void
  onSave: (snippet: Snippet) => void
  onDelete: (id: string, scope: SnippetScope) => void
  onClose: () => void
}>) {
  const [adding, setAdding] = useState(false)
  const [addScope, setAddScope] = useState<SnippetScope>('global')
  const [editLabel, setEditLabel] = useState('')
  const [editCmd, setEditCmd] = useState('')
  const [editTags, setEditTags] = useState('')
  const [runningId, setRunningId] = useState<string | null>(null)
  const [varValues, setVarValues] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState('')

  const all = [...globalSnippets, ...hostSnippets]
  const filtered = filter
    ? all.filter(s => s.label.toLowerCase().includes(filter.toLowerCase()) || s.command.toLowerCase().includes(filter.toLowerCase()) || s.tags.some(t => t.toLowerCase().includes(filter.toLowerCase())))
    : all

  const globalFiltered = filtered.filter(s => s.scope === 'global')
  const hostFiltered = filtered.filter(s => s.scope === 'host')

  function startRun(snippet: Snippet) {
    const vars = extractVars(snippet.command)
    if (vars.length > 0) {
      setRunningId(snippet.id)
      setVarValues(Object.fromEntries(vars.map(v => [v, ''])))
    } else {
      onRun(snippet.command + '\n')
    }
  }

  function executeWithVars(snippet: Snippet) {
    let cmd = snippet.command
    for (const [k, v] of Object.entries(varValues)) cmd = cmd.replaceAll(`{{${k}}}`, v)
    onRun(cmd + '\n')
    setRunningId(null); setVarValues({})
  }

  const setVar = (name: string, val: string) => setVarValues(p => ({ ...p, [name]: val }))

  function saveNew() {
    if (!editLabel.trim() || !editCmd.trim()) return
    onSave({
      id: `snip-${Date.now()}`,
      label: editLabel.trim(),
      command: editCmd.trim(),
      tags: editTags.split(',').map(t => t.trim()).filter(Boolean),
      scope: addScope,
    })
    setAdding(false); setEditLabel(''); setEditCmd(''); setEditTags('')
  }

  function renderSnippet(s: Snippet) {
    return (
      <div key={s.id} className="group" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <div className="flex items-center gap-2 px-3 py-2">
          <button onClick={() => startRun(s)} className="w-5 h-5 flex items-center justify-center rounded flex-shrink-0" style={{ color: '#10b981' }} title="Run">
            <Play className="w-3 h-3" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-medium truncate" style={{ color: '#eeeef2' }}>{s.label}</p>
            <p className="text-[10px] font-mono truncate" style={{ color: 'rgba(255,255,255,0.3)' }}>{s.command}</p>
          </div>
          <button onClick={() => navigator.clipboard.writeText(s.command)} className="w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100" style={{ color: 'rgba(255,255,255,0.3)' }} title="Copy">
            <Copy className="w-2.5 h-2.5" />
          </button>
          <button onClick={() => onDelete(s.id, s.scope)} className="w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100" style={{ color: '#ef4444' }} title="Delete">
            <Trash2 className="w-2.5 h-2.5" />
          </button>
        </div>
        {s.tags.length > 0 && (
          <div className="flex items-center gap-1 px-3 pb-2 pl-10">
            {s.tags.map(t => <span key={t} className="text-[9px] font-mono px-1.5 py-[1px] rounded" style={{ color: 'rgba(157,111,248,0.8)', background: 'rgba(157,111,248,0.08)' }}>{t}</span>)}
          </div>
        )}
        {runningId === s.id && (
          <div className="px-3 pb-3 pt-1 space-y-2" style={{ background: 'rgba(157,111,248,0.04)' }}>
            {extractVars(s.command).map(v => (
              <VarInput key={v} name={v} value={varValues[v] || ''}
                autoFocus={extractVars(s.command)[0] === v}
                onChange={val => setVar(v, val)}
                onEnter={() => executeWithVars(s)}
                onCancel={() => setRunningId(null)} />
            ))}
            <div className="flex items-center gap-2 pt-1">
              <button onClick={() => executeWithVars(s)} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium" style={{ background: '#10b981', color: '#fff' }}>
                <Play className="w-2.5 h-2.5" /> Run
              </button>
              <button onClick={() => setRunningId(null)} className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>Cancel</button>
              <span className="flex-1" />
              <span className="text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.15)' }}>Enter to run</span>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex-shrink-0 flex flex-col h-full animate-slide-in-right"
      style={{
        width: 300,
        background: 'var(--nox-sidebar)',
        borderLeft: '1px solid var(--nox-border)',
      }}
    >
      <div className="flex items-center gap-2 px-3 flex-shrink-0" style={{ height: 38, borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
        <Code2 className="w-3.5 h-3.5" style={{ color: '#9d6ff8' }} />
        <span className="text-[11px] font-semibold flex-1" style={{ color: '#eeeef2' }}>Snippets</span>
        <button onClick={() => setAdding(true)} className="w-5 h-5 flex items-center justify-center rounded" style={{ color: 'rgba(255,255,255,0.4)' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#9d6ff8')} onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.4)')}>
          <Plus className="w-3 h-3" />
        </button>
        <button onClick={onClose} className="w-5 h-5 flex items-center justify-center rounded" style={{ color: 'rgba(255,255,255,0.3)' }}>
          <X className="w-3 h-3" />
        </button>
      </div>

      {all.length > 3 && (
        <div className="px-2 py-2 flex-shrink-0">
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter…" className="w-full bg-transparent text-[10px] font-mono px-2 py-1 rounded focus:outline-none" style={{ color: '#eeeef2', border: '1px solid rgba(255,255,255,0.08)' }} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
        {all.length === 0 && !adding && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center px-4">
              <Code2 className="w-6 h-6 mx-auto mb-2" style={{ color: 'rgba(255,255,255,0.08)' }} />
              <p className="text-[11px] mb-2" style={{ color: 'rgba(255,255,255,0.3)' }}>No snippets yet</p>
              <p className="text-[10px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.2)' }}>
                Save commands you run often.<br />Use {'{{name}}'} for variables.<br />Global snippets work on every server.
              </p>
            </div>
          </div>
        )}

        {/* Global section */}
        {globalFiltered.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
              <Globe className="w-2.5 h-2.5" style={{ color: 'rgba(255,255,255,0.25)' }} />
              <span className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: 'rgba(255,255,255,0.25)' }}>Global</span>
            </div>
            {globalFiltered.map(renderSnippet)}
          </>
        )}

        {/* Host section */}
        {hostFiltered.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
              <Server className="w-2.5 h-2.5" style={{ color: 'rgba(255,255,255,0.25)' }} />
              <span className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: 'rgba(255,255,255,0.25)' }}>{hostname}</span>
            </div>
            {hostFiltered.map(renderSnippet)}
          </>
        )}

        {/* Add new */}
        {adding && (
          <div className="px-3 py-3 space-y-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(157,111,248,0.03)' }}>
            {/* Scope toggle */}
            <div className="flex items-center gap-1 mb-1">
              <button onClick={() => setAddScope('global')}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium"
                style={{ color: addScope === 'global' ? '#eeeef2' : 'rgba(255,255,255,0.3)', background: addScope === 'global' ? 'rgba(157,111,248,0.15)' : 'transparent' }}>
                <Globe className="w-2.5 h-2.5" /> Global
              </button>
              <button onClick={() => setAddScope('host')}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium"
                style={{ color: addScope === 'host' ? '#eeeef2' : 'rgba(255,255,255,0.3)', background: addScope === 'host' ? 'rgba(16,185,129,0.15)' : 'transparent' }}>
                <Server className="w-2.5 h-2.5" /> {hostname}
              </button>
            </div>
            <input value={editLabel} onChange={e => setEditLabel(e.target.value)} placeholder="Label (e.g. Deploy)" autoFocus
              className="w-full bg-transparent text-[11px] font-mono px-2 py-1 rounded focus:outline-none"
              style={{ color: '#eeeef2', border: '1px solid rgba(255,255,255,0.1)' }} />
            <textarea value={editCmd} onChange={e => setEditCmd(e.target.value)} placeholder="Command (use {{var}} for placeholders)" rows={3}
              className="w-full bg-transparent text-[10px] font-mono px-2 py-1 rounded resize-none focus:outline-none"
              style={{ color: '#eeeef2', border: '1px solid rgba(255,255,255,0.1)' }} />
            <input value={editTags} onChange={e => setEditTags(e.target.value)} placeholder="Tags (comma-separated)"
              className="w-full bg-transparent text-[10px] font-mono px-2 py-1 rounded focus:outline-none"
              style={{ color: '#eeeef2', border: '1px solid rgba(255,255,255,0.08)' }} />
            {extractVars(editCmd).length > 0 && (
              <p className="text-[9px]" style={{ color: 'rgba(157,111,248,0.6)' }}>
                Variables: {extractVars(editCmd).map(v => `{{${v}}}`).join(', ')}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button onClick={saveNew} disabled={!editLabel.trim() || !editCmd.trim()} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium disabled:opacity-30" style={{ background: '#9d6ff8', color: '#fff' }}>Save</button>
              <button onClick={() => setAdding(false)} className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
