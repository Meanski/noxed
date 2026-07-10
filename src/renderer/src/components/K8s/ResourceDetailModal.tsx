import { useState, useEffect } from 'react'
import { X, Copy, Check, RefreshCw } from 'lucide-react'

interface Props {
  context: string
  namespace: string
  kind: string
  name: string
  kubeconfigPath?: string
  onClose: () => void
}

// JSON token matchers (sticky, tried in order at each position by colorize).
const STRING_RE = /"(?:\\.|[^\\"])*"/y
const KEY_SUFFIX_RE = /\s*:/y
const KEYWORD_RE = /true|false|null/y
const NUMBER_RE = /-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/y

function matchAt(re: RegExp, text: string, index: number): string | null {
  re.lastIndex = index
  const m = re.exec(text)
  return m ? m[0] : null
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch)
}

// Returns the JSON token starting at `index` and its color, or null.
function tokenAt(text: string, index: number): { text: string; color: string } | null {
  const str = matchAt(STRING_RE, text, index)
  if (str) {
    const keySuffix = matchAt(KEY_SUFFIX_RE, text, index + str.length)
    if (keySuffix) return { text: str + keySuffix, color: '#9d6ff8' }
    return { text: str, color: '#10b981' }
  }
  if (!isWordChar(text[index - 1])) {
    const kw = matchAt(KEYWORD_RE, text, index)
    if (kw && !isWordChar(text[index + kw.length])) {
      return { text: kw, color: kw === 'null' ? '#EF4444' : '#06b6d4' }
    }
  }
  const num = matchAt(NUMBER_RE, text, index)
  if (num) return { text: num, color: '#f59e0b' }
  return null
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch])
}

// Simple JSON syntax coloring: single left-to-right pass so already-emitted
// <span> markup is never re-matched. The result feeds dangerouslySetInnerHTML,
// so every character of the (untrusted) resource JSON is HTML-escaped — only
// the generated spans (with colors from the fixed internal set) are markup.
function colorize(raw: string): string {
  let out = ''
  let i = 0
  while (i < raw.length) {
    const token = tokenAt(raw, i)
    if (token) {
      out += `<span style="color:${token.color}">${escapeHtml(token.text)}</span>`
      i += token.text.length
    } else {
      out += escapeHtml(raw[i])
      i++
    }
  }
  return out
}

export default function ResourceDetailModal({ context, namespace, kind, name, kubeconfigPath, onClose }: Readonly<Props>) {
  const [json, setJson] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await window.api.k8s.resourceDetail(context, namespace, kind, name, kubeconfigPath)
      setJson(data)
    } catch (err: any) {
      setJson(`Error: ${err?.message ?? 'Failed to load resource'}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function copy() {
    await navigator.clipboard.writeText(json)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-[860px] max-w-[95vw] h-[80vh] flex flex-col rounded-xl overflow-hidden shadow-2xl"
        style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{ background: 'var(--nox-shell)', borderBottom: '1px solid var(--nox-border)' }}
        >
          <div>
            <p className="font-['Plus_Jakarta_Sans'] font-semibold text-[14px]" style={{ color: 'var(--nox-text)' }}>
              {kindLabel(kind)} — {name}
            </p>
            <p className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>{namespace}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={load}
              disabled={loading}
              className="p-1.5 rounded-md transition-colors disabled:opacity-40"
              style={{ color: 'var(--nox-text-2)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={copy}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: copied ? '#10B981' : 'var(--nox-text-2)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              title="Copy JSON"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: 'var(--nox-text-2)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* JSON body */}
        <div className="flex-1 overflow-auto" style={{ background: '#0c0b0f' }}>
          {loading ? (
            <div className="p-8 flex items-center justify-center">
              <RefreshCw className="w-5 h-5 animate-spin text-[#8B5CF6]" />
            </div>
          ) : (
            <pre
              className="p-5 font-['JetBrains_Mono'] text-[12px] leading-relaxed"
              style={{ margin: 0, color: '#e5e7eb' }}
              dangerouslySetInnerHTML={{ __html: colorize(json) }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    pod: 'Pod', deployment: 'Deployment', statefulset: 'StatefulSet',
    daemonset: 'DaemonSet', replicaset: 'ReplicaSet', service: 'Service',
    ingress: 'Ingress', configmap: 'ConfigMap', secret: 'Secret',
    job: 'Job', cronjob: 'CronJob', node: 'Node',
  }
  return map[kind] ?? kind
}
