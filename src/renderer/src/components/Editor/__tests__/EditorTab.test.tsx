// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import EditorTab from '../EditorTab'
import { installWindowApi, seedStore, makeSession, makeTab, WindowApiMock } from '../../../__tests__/harness'
import { useAppStore, Tab } from '../../../store'

// CodeMirror is far too heavy for jsdom — stub it with hooks into the props.
vi.mock('../CodeEditor', () => ({
  default: ({ value, onChange, onSave }: { value: string; onChange: (v: string) => void; onSave: () => void }) => (
    <div data-testid="code-editor">
      <span data-testid="editor-value">{value}</span>
      <button data-testid="editor-change" onClick={() => onChange('changed content')}>change</button>
      <button data-testid="editor-save" onClick={onSave}>save</button>
    </div>
  ),
}))

let api: WindowApiMock

function localTab(overrides: Partial<Tab> = {}): Tab {
  return makeTab({
    id: 'ed-1',
    view: 'editor',
    label: 'notes.md',
    editorFile: { source: 'local', path: '/home/user/notes.md' },
    ...overrides,
  })
}

describe('EditorTab', () => {
  beforeEach(() => {
    api = installWindowApi({
      localfs: { readTextFile: vi.fn().mockResolvedValue('hello world') },
    })
    seedStore({ sessions: [], tabs: [], activeTabId: null, notifications: [] })
  })

  it('shows a message when the tab has no file', () => {
    render(<EditorTab tab={makeTab({ view: 'editor' })} />)
    expect(screen.getByText('This editor tab has no file associated with it')).toBeTruthy()
  })

  it('loads a local file into the editor and shows Saved when clean', async () => {
    const tab = localTab()
    seedStore({ tabs: [tab], activeTabId: tab.id })
    render(<EditorTab tab={tab} />)

    await waitFor(() => expect(screen.getByTestId('editor-value').textContent).toBe('hello world'))
    expect(screen.getByText('Saved')).toBeTruthy()
    expect(screen.getByText('local')).toBeTruthy()
    expect(screen.getByText('/home/user/notes.md')).toBeTruthy()
  })

  it('marks the tab dirty when the editor content changes', async () => {
    const tab = localTab()
    seedStore({ tabs: [tab], activeTabId: tab.id })
    render(<EditorTab tab={tab} />)
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeTruthy())

    fireEvent.click(screen.getByTestId('editor-change'))
    expect(useAppStore.getState().tabs[0].isDirty).toBe(true)
  })

  it('saves through the header button, flipping Save → Saving → clean', async () => {
    const tab = localTab({ isDirty: true })
    seedStore({ tabs: [tab], activeTabId: tab.id })

    let resolveWrite: () => void = () => {}
    api.localfs.writeTextFile.mockReturnValueOnce(new Promise<void>(res => { resolveWrite = res }))

    render(<EditorTab tab={tab} />)
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeTruthy())

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByText('Saving')).toBeTruthy())

    resolveWrite()
    await waitFor(() => expect(useAppStore.getState().tabs[0].isDirty).toBe(false))
    expect(api.localfs.writeTextFile).toHaveBeenCalledWith('/home/user/notes.md', 'hello world')
  })

  it('saves via Cmd+S when the tab is active', async () => {
    const tab = localTab({ isDirty: true })
    seedStore({ tabs: [tab], activeTabId: tab.id })
    render(<EditorTab tab={tab} />)
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeTruthy())

    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(api.localfs.writeTextFile).toHaveBeenCalled())
  })

  it('reports save failures as notifications', async () => {
    const tab = localTab({ isDirty: true })
    seedStore({ tabs: [tab], activeTabId: tab.id })
    api.localfs.writeTextFile.mockRejectedValueOnce(new Error('disk full'))

    render(<EditorTab tab={tab} />)
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeTruthy())

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => {
      const notes = useAppStore.getState().notifications
      expect(notes.some(n => n.message.includes('disk full'))).toBe(true)
    })
  })

  it('shows the error state with retry when loading fails', async () => {
    api.localfs.readTextFile
      .mockRejectedValueOnce(new Error('no such file'))
      .mockResolvedValueOnce('recovered')
    const tab = localTab()
    seedStore({ tabs: [tab], activeTabId: tab.id })
    render(<EditorTab tab={tab} />)

    await waitFor(() => expect(screen.getByText('no such file')).toBeTruthy())
    expect(useAppStore.getState().tabs[0].status).toBe('error')

    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(screen.getByTestId('editor-value').textContent).toBe('recovered'))
  })

  it('opens remote files over the terminal SFTP stream', async () => {
    const session = makeSession({ id: 'srv-1', host: 'remote.example.com' })
    api.sftp.readFile.mockResolvedValue('remote text')
    const tab = makeTab({
      id: 'ed-2', view: 'editor', label: 'app.conf', sessionId: 'srv-1', streamId: 'stream-7',
      editorFile: { source: 'remote', path: '/etc/app.conf' },
    })
    seedStore({ sessions: [session], tabs: [tab], activeTabId: tab.id })

    render(<EditorTab tab={tab} />)
    await waitFor(() => expect(screen.getByTestId('editor-value').textContent).toBe('remote text'))
    expect(screen.getByText('remote.example.com')).toBeTruthy()
    expect(api.sftp.connect).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'stream-7' }))
  })
})
