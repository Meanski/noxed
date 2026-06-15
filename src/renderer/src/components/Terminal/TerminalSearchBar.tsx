import { useEffect, useRef, useState } from 'react'
import { SearchAddon } from '@xterm/addon-search'
import { ChevronUp, ChevronDown, X } from 'lucide-react'

// Highlight colors for search matches, shared by both terminal themes.
const SEARCH_DECORATIONS = {
  matchBackground: '#7c3aed55',
  matchOverviewRuler: '#7c3aed',
  activeMatchBackground: '#f59e0baa',
  activeMatchColorOverviewRuler: '#f59e0b',
}

interface Props {
  addon: SearchAddon
  onClose: () => void
}

export default function TerminalSearchBar({ addon, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const sub = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResults(resultCount > 0 ? { index: resultIndex, count: resultCount } : { index: -1, count: 0 })
    })
    return () => {
      sub.dispose()
      addon.clearDecorations()
    }
  }, [addon])

  function search(text: string, direction: 'next' | 'previous') {
    if (!text) {
      addon.clearDecorations()
      setResults(null)
      return
    }
    const find = direction === 'next' ? addon.findNext : addon.findPrevious
    find.call(addon, text, { decorations: SEARCH_DECORATIONS })
  }

  function handleChange(text: string) {
    setQuery(text)
    search(text, 'next')
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      search(query, e.shiftKey ? 'previous' : 'next')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="absolute top-2 right-3 z-40 flex items-center gap-1 rounded-lg px-2 py-1.5 shadow-xl"
      style={{ background: 'var(--nox-surface)', border: '1px solid var(--nox-border)' }}
      onMouseDown={e => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={e => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search"
        spellCheck={false}
        className="w-44 bg-transparent text-xs outline-none font-mono"
        style={{ color: 'var(--nox-text)' }}
      />
      <span className="text-2xs tabular-nums min-w-[40px] text-right" style={{ color: 'var(--nox-text-3)' }}>
        {results ? (results.count > 0 ? `${results.index + 1}/${results.count}` : '0/0') : ''}
      </span>
      <SearchNavButton title="Previous match (Shift+Enter)" onClick={() => search(query, 'previous')}>
        <ChevronUp className="w-3.5 h-3.5" />
      </SearchNavButton>
      <SearchNavButton title="Next match (Enter)" onClick={() => search(query, 'next')}>
        <ChevronDown className="w-3.5 h-3.5" />
      </SearchNavButton>
      <SearchNavButton title="Close (Esc)" onClick={onClose}>
        <X className="w-3.5 h-3.5" />
      </SearchNavButton>
    </div>
  )
}

function SearchNavButton({ title, onClick, children }: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex items-center justify-center w-5 h-5 rounded transition-colors"
      style={{ color: 'var(--nox-text-3)' }}
      onMouseEnter={e => { e.currentTarget.style.color = 'var(--nox-text)' }}
      onMouseLeave={e => { e.currentTarget.style.color = 'var(--nox-text-3)' }}
    >
      {children}
    </button>
  )
}
