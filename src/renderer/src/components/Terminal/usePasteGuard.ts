import { useCallback, useRef, useState, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { TerminalBehavior } from './terminalSettings'

/**
 * A paste runs line by line in a shell unless the shell has turned on
 * bracketed paste (then pasted newlines don't execute until Enter), so only
 * line-break-containing pastes into a non-bracketed shell need confirming.
 */
export function needsPasteConfirmation(text: string, bracketedPasteMode: boolean): boolean {
  return !bracketedPasteMode && /[\r\n]/.test(text)
}

export interface PendingPaste {
  text: string
  term: Terminal
}

// Intercepts paste on an xterm before xterm handles it, holding multi-line
// pastes for confirmation. A capture listener on the terminal element runs
// ahead of xterm's own handler on its hidden textarea.
export function usePasteGuard(behavior: RefObject<TerminalBehavior>) {
  const [pending, setPending] = useState<PendingPaste | null>(null)
  // The ref is the source of truth for acting on a paste, so a double click
  // can't paste twice before the state update lands.
  const pendingRef = useRef<PendingPaste | null>(null)
  const hold = (p: PendingPaste | null) => {
    pendingRef.current = p
    setPending(p)
  }

  const attach = useCallback((term: Terminal): (() => void) => {
    const el = term.element
    if (!el) return () => {}
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!behavior.current?.confirmMultilinePaste || !needsPasteConfirmation(text, term.modes.bracketedPasteMode)) return
      e.preventDefault()
      e.stopPropagation()
      hold({ text, term })
    }
    el.addEventListener('paste', onPaste, true)
    return () => el.removeEventListener('paste', onPaste, true)
  }, [behavior])

  const confirm = useCallback(() => {
    const p = pendingRef.current
    hold(null)
    if (!p) return
    p.term.paste(p.text)
    p.term.focus()
  }, [])

  const cancel = useCallback(() => {
    const p = pendingRef.current
    hold(null)
    p?.term.focus()
  }, [])

  return { pending, attach, confirm, cancel }
}
