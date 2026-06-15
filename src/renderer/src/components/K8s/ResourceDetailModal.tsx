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

export default function ResourceDetailModal({ context, namespace, kind, name, kubeconfigPath, onClose }: Props) {
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

  // Simple JSON syntax coloring
  function colorize(raw: string): string {
    return raw
      .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
        if (/^"/.test(match)) {
          if (/:$/.test(match)) return `<span style="color:#9d6ff8">${match}</span>`
          return `<span style="color:#10b981">${match}</span>`
        }
        if (/true|false/.test(match)) return `<span style="color:#06b6d4">${match}</span>`
        if (/null/.test(match)) return `<span style="color:#EF4444">${match}</span>`
        return `<span style="color:#f59e0b">${match}</span>`
      })
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
