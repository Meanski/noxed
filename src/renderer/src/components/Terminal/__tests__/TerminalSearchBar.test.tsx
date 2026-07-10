// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { SearchAddon } from '@xterm/addon-search'
import TerminalSearchBar from '../TerminalSearchBar'

type ResultsCallback = (results: { resultIndex: number; resultCount: number }) => void

function makeAddon() {
  let onResults: ResultsCallback = () => {}
  const addon = {
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn((cb: ResultsCallback) => {
      onResults = cb
      return { dispose: vi.fn() }
    }),
  }
  return { addon: addon as unknown as SearchAddon, mocks: addon, emit: (r: { resultIndex: number; resultCount: number }) => act(() => onResults(r)) }
}

describe('TerminalSearchBar', () => {
  beforeEach(() => vi.clearAllMocks())

  it('searches forward as you type and shows the match position', () => {
    const { addon, mocks, emit } = makeAddon()
    render(<TerminalSearchBar addon={addon} onClose={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'err' } })
    expect(mocks.findNext).toHaveBeenCalledWith('err', expect.anything())

    emit({ resultIndex: 1, resultCount: 5 })
    expect(screen.getByText('2/5')).toBeTruthy()

    emit({ resultIndex: -1, resultCount: 0 })
    expect(screen.getByText('0/0')).toBeTruthy()
  })

  it('shows nothing before a search has produced results', () => {
    const { addon } = makeAddon()
    render(<TerminalSearchBar addon={addon} onClose={vi.fn()} />)
    // The label span is empty until results arrive
    expect(screen.queryByText('0/0')).toBeNull()
  })

  it('navigates with Enter, Shift+Enter and the arrow buttons', () => {
    const { addon, mocks } = makeAddon()
    render(<TerminalSearchBar addon={addon} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Search')

    fireEvent.change(input, { target: { value: 'foo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.findNext).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(mocks.findPrevious).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTitle('Previous match (Shift+Enter)'))
    expect(mocks.findPrevious).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByTitle('Next match (Enter)'))
    expect(mocks.findNext).toHaveBeenCalledTimes(3)
  })

  it('clears decorations when the query becomes empty', () => {
    const { addon, mocks } = makeAddon()
    render(<TerminalSearchBar addon={addon} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Search')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.change(input, { target: { value: '' } })
    expect(mocks.clearDecorations).toHaveBeenCalled()
  })

  it('closes on Escape and the close button', () => {
    const { addon } = makeAddon()
    const onClose = vi.fn()
    render(<TerminalSearchBar addon={addon} onClose={onClose} />)

    fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTitle('Close (Esc)'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
