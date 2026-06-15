import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { X, ChevronDown } from 'lucide-react'

interface Props {
  context: string
  namespace: string
  pod: string
  containers: string[]
  kubeconfigPath?: string
  onClose: () => void
}

export default function PodExecModal({ context, namespace, pod, containers, kubeconfigPath, onClose }: Props) {
  const [container, setContainer] = useState(containers[0] ?? '')
  const [connecting, setConnecting] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.55,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowTransparency: true,
      theme: {
        background: '#0c0b0f',
        foreground: '#ffffff',
        cursor: '#9d6ff8',
        cursorAccent: '#0c0b0f',
        selectionBackground: 'rgba(124,58,237,0.3)',
        black: '#1a1725', brightBlack: '#3d3952',
        red: '#ef4444', brightRed: '#f87171',
        green: '#10b981', brightGreen: '#34d399',
        yellow: '#f59e0b', brightYellow: '#fbbf24',
        blue: '#7c3aed', brightBlue: '#9d6ff8',
        magenta: '#c084fc', brightMagenta: '#d8b4fe',
        cyan: '#06b6d4', brightCyan: '#22d3ee',
        white: '#ffffff', brightWhite: '#ffffff',
      },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    setTimeout(() => fit.fit(), 0)

    term.onData(data => {
      if (sessionIdRef.current) window.api.k8s.execSend(sessionIdRef.current, data)
    })

    // Keep the remote pty in sync when the terminal refits
    term.onResize(({ cols, rows }) => {
      if (sessionIdRef.current) window.api.k8s.execResize(sessionIdRef.current, cols, rows)
    })

    termRef.current = term
    fitRef.current = fit

    const ro = new ResizeObserver(() => { fit.fit() })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      term.dispose()
    }
  }, [])

  // Subscribe to exec events
  useEffect(() => {
    const offData = window.api.k8s.onExecData((sid, data) => {
      if (sid !== sessionIdRef.current) return
      termRef.current?.write(data)
    })
    const offClose = window.api.k8s.onExecClose((sid) => {
      if (sid !== sessionIdRef.current) return
      termRef.current?.write('\r\n\x1b[31m[Connection closed]\x1b[0m\r\n')
      sessionIdRef.current = null
    })
    return () => { offData(); offClose() }
  }, [])

  // Connect when container changes
  useEffect(() => {
    connect()
    return () => {
      if (sessionIdRef.current) {
        window.api.k8s.execStop(sessionIdRef.current)
        sessionIdRef.current = null
      }
    }
  }, [container])

  async function connect() {
    // Stop existing session
    if (sessionIdRef.current) {
      await window.api.k8s.execStop(sessionIdRef.current)
      sessionIdRef.current = null
    }

    termRef.current?.clear()
    termRef.current?.write(`\x1b[36mConnecting to ${pod}/${container}…\x1b[0m\r\n`)
    setConnecting(true)

    try {
      const sid = await window.api.k8s.execStart(context, namespace, pod, container, kubeconfigPath)
      sessionIdRef.current = sid
      termRef.current?.write(`\x1b[32mConnected\x1b[0m\r\n`)

      // Send initial resize
      const { cols, rows } = termRef.current ?? { cols: 80, rows: 24 }
      window.api.k8s.execResize(sid, cols, rows)
    } catch (err: any) {
      termRef.current?.write(`\r\n\x1b[31mError: ${err?.message ?? 'Failed to connect'}\x1b[0m\r\n`)
    } finally {
      setConnecting(false)
    }
  }

  function handleClose() {
    if (sessionIdRef.current) {
      window.api.k8s.execStop(sessionIdRef.current)
      sessionIdRef.current = null
    }
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-[860px] max-w-[95vw] h-[75vh] flex flex-col rounded-xl overflow-hidden shadow-2xl"
        style={{ background: '#0c0b0f', border: '1px solid var(--nox-border)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-2.5 flex-shrink-0"
          style={{ background: '#1a1725', borderBottom: '1px solid #2d2b3a' }}
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-[#EF4444]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#F59E0B]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#10B981]" />
            </div>
            <div>
              <p className="font-['Plus_Jakarta_Sans'] font-semibold text-[13px] text-white">
                Shell — {pod}
              </p>
              <p className="font-['Inter'] text-[11px] text-[#6B7280]">{namespace}</p>
            </div>

            {containers.length > 1 && (
              <div className="relative flex items-center ml-2">
                <select
                  value={container}
                  onChange={e => setContainer(e.target.value)}
                  className="px-2 py-1 rounded-md font-['Inter'] text-[11.5px] focus:outline-none appearance-none pr-6 text-white"
                  style={{ background: '#2d2b3a', border: '1px solid #3d3952' }}
                >
                  {containers.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <ChevronDown className="w-3 h-3 absolute right-1.5 pointer-events-none text-[#6B7280]" />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {connecting && (
              <span className="font-['Inter'] text-[11.5px] text-[#F59E0B] animate-pulse">Connecting…</span>
            )}
            <button
              onClick={connect}
              className="px-2.5 py-1 rounded-md font-['Inter'] text-[11.5px] text-[#9d6ff8] transition-colors"
              style={{ background: '#2d2b3a', border: '1px solid #3d3952' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#3d3952' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#2d2b3a' }}
            >
              Reconnect
            </button>
            <button
              onClick={handleClose}
              className="p-1.5 rounded-md text-[#6B7280] transition-colors"
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2d2b3a' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Terminal */}
        <div ref={containerRef} className="flex-1 overflow-hidden p-2" style={{ background: '#0c0b0f' }} />
      </div>
    </div>
  )
}
