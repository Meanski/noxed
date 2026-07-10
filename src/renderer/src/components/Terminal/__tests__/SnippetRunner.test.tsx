// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SnippetRunner, { Snippet } from '../SnippetRunner'

const varSnippet: Snippet = {
  id: 'snip-1',
  label: 'Tail log',
  command: 'tail -f /var/log/{{file}} | grep {{file}}',
  tags: ['logs'],
  scope: 'global',
}

const plainSnippet: Snippet = {
  id: 'snip-2',
  label: 'Uptime',
  command: 'uptime',
  tags: [],
  scope: 'host',
}

function renderRunner(overrides: Partial<React.ComponentProps<typeof SnippetRunner>> = {}) {
  const props = {
    hostSnippets: [plainSnippet],
    globalSnippets: [varSnippet],
    hostname: 'h1.example.com',
    onRun: vi.fn(),
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<SnippetRunner {...props} />)
  return props
}

describe('SnippetRunner', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs snippets without variables immediately', () => {
    const props = renderRunner()
    const runButtons = screen.getAllByTitle('Run')
    fireEvent.click(runButtons[1]) // host section renders after global
    expect(props.onRun).toHaveBeenCalledWith('uptime\n')
  })

  it('prompts for variables and substitutes every occurrence on Enter', () => {
    const props = renderRunner()
    fireEvent.click(screen.getAllByTitle('Run')[0])

    const input = screen.getByPlaceholderText('value…')
    fireEvent.change(input, { target: { value: 'syslog' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onRun).toHaveBeenCalledWith('tail -f /var/log/syslog | grep syslog\n')
    // The variable form is dismissed after running
    expect(screen.queryByPlaceholderText('value…')).toBeNull()
  })

  it('cancels the variable prompt with Escape', () => {
    const props = renderRunner()
    fireEvent.click(screen.getAllByTitle('Run')[0])
    fireEvent.keyDown(screen.getByPlaceholderText('value…'), { key: 'Escape' })
    expect(screen.queryByPlaceholderText('value…')).toBeNull()
    expect(props.onRun).not.toHaveBeenCalled()
  })

  it('runs from the inline Run button as well', () => {
    const props = renderRunner()
    fireEvent.click(screen.getAllByTitle('Run')[0])
    fireEvent.change(screen.getByPlaceholderText('value…'), { target: { value: 'auth.log' } })
    fireEvent.click(screen.getByText('Run'))
    expect(props.onRun).toHaveBeenCalledWith('tail -f /var/log/auth.log | grep auth.log\n')
  })

  it('saves a new snippet with parsed tags', () => {
    const props = renderRunner()
    // The add button is icon-only (no title/aria-label); it renders immediately
    // after the "Snippets" header label.
    fireEvent.click(screen.getByText('Snippets').nextElementSibling as HTMLElement)

    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Deploy)'), { target: { value: 'Disk' } })
    fireEvent.change(screen.getByPlaceholderText('Command (use {{var}} for placeholders)'), { target: { value: 'df -h' } })
    fireEvent.change(screen.getByPlaceholderText('Tags (comma-separated)'), { target: { value: 'disk, space' } })
    fireEvent.click(screen.getByText('Save'))

    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Disk', command: 'df -h', tags: ['disk', 'space'], scope: 'global',
    }))
  })

  it('deletes snippets with their scope', () => {
    const props = renderRunner()
    fireEvent.click(screen.getAllByTitle('Delete')[0])
    expect(props.onDelete).toHaveBeenCalledWith('snip-1', 'global')
  })
})
