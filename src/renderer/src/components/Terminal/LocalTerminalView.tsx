import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useAppStore, Tab } from '../../store'
import TerminalSearchBar from './TerminalSearchBar'
import {
  DEFAULT_SCROLLBACK_SIZE, resolveTerminalTheme, applyTerminalSettings,
  playBellSound, TerminalBehavior,
} from './terminalSettings'

interface Props {
  tab: Tab
}

export default function LocalTerminalView({ tab }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const behaviorRef = useRef<TerminalBehavior>({ copyOnSelect: false, bellSound: true, resourceAlerts: true })
  const activeTabId = useAppStore((s) => s.activeTabId)
  const [searchOpen, setSearchOpen] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)

  const isVisible = activeTabId === tab.id

  function fitAndResize(): void {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit || !containerRef.current?.clientHeight) return
    fit.fit()
    if (ptyIdRef.current) window.api.localpty.resize(ptyIdRef.current, term.cols, term.rows)
  }

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    let cancelled = false

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 14,
      lineHeight: 1.55,
      letterSpacing: 0.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: DEFAULT_SCROLLBACK_SIZE,
      rescaleOverlappingGlyphs: true,
      theme: resolveTerminalTheme('noxed Dark'),
    })

    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    termRef.current = term
    fitRef.current = fit
    searchAddonRef.current = search

    const onSelection = term.onSelectionChange(() => {
      if (!behaviorRef.current.copyOnSelect || !term.hasSelection()) return
      navigator.clipboard.writeText(term.getSelection()).catch((err: any) => {
        console.error('[localterm] copy on select failed:', err?.message ?? err)
      })
    })
    const onBell = term.onBell(() => {
      if (behaviorRef.current.bellSound) playBellSound()
    })

    applyTerminalSettings(term, behaviorRef, fitAndResize)

    const offData = window.api.localpty.onData((id, data) => {
      if (id === ptyIdRef.current) term.write(data)
    })
    const offExit = window.api.localpty.onExit((id, code) => {
      if (id !== ptyIdRef.current) return
      ptyIdRef.current = null
      setExitCode(code)
      term.write(`\r\n\x1b[2m— shell exited (${code}) —\x1b[0m\r\n`)
    })

    const onData = term.onData((data) => {
      if (ptyIdRef.current) window.api.localpty.write(ptyIdRef.current, data)
    })
    const onResize = term.onResize(({ cols, rows }) => {
      if (ptyIdRef.current) window.api.localpty.resize(ptyIdRef.current, cols, rows)
    })

    // Fit before spawning so the shell starts at the real size
    fit.fit()
    window.api.localpty.start(term.cols || 80, term.rows || 24)
      .then((id) => {
        if (cancelled) { window.api.localpty.kill(id).catch(() => {}); return }
        ptyIdRef.current = id
        term.focus()
      })
      .catch((err: any) => {
        term.write(`\x1b[31m✕ Failed to start shell: ${err?.message ?? err}\x1b[0m\r\n`)
        setExitCode(-1)
      })

    const ro = new ResizeObserver(() => fitAndResize())
    ro.observe(container)

    return () => {
      cancelled = true
      ro.disconnect()
      offData()
      offExit()
      onData.dispose()
      onResize.dispose()
      onSelection.dispose()
      onBell.dispose()
      if (ptyIdRef.current) {
        window.api.localpty.kill(ptyIdRef.current).catch(() => {})
        ptyIdRef.current = null
      }
      term.dispose()
    }
  }, [])

  // Re-apply settings when they change
  useEffect(() => {
    const handler = () => {
      if (termRef.current) applyTerminalSettings(termRef.current, behaviorRef, fitAndResize)
    }
    window.addEventListener('noxed:settings-changed', handler)
    return () => window.removeEventListener('noxed:settings-changed', handler)
  }, [])

  // Fit + focus when the tab becomes visible
  useEffect(() => {
    if (!isVisible) return
    const frame = requestAnimationFrame(() => {
      fitAndResize()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [isVisible])

  // Cmd+F scrollback search
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isVisible || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isVisible])

  return (
    <div className="relative flex flex-col h-full w-full" style={{ background: '#0c0b0f' }}>
      <div className="relative flex-1 min-w-0 min-h-0 px-3 pt-2 pb-1 overflow-hidden">
        <div ref={containerRef} className="h-full w-full" />
        {searchOpen && searchAddonRef.current && (
          <TerminalSearchBar
            addon={searchAddonRef.current}
            onClose={() => { setSearchOpen(false); termRef.current?.focus() }}
          />
        )}
        {exitCode !== null && (
          <div
            className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md text-[11.5px] font-mono"
            style={{ background: 'rgba(0,0,0,0.8)', color: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.12)' }}
          >
            shell exited — close this tab or ⌘W
          </div>
        )}
      </div>
    </div>
  )
}
