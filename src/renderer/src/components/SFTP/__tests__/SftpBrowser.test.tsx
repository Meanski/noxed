// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import SftpBrowser from '../SftpBrowser'
import { installWindowApi, seedStore, makeSession, makeTab } from '../../../__tests__/harness'

interface Entry { name: string; size: number; mtime: number; permissions: number; isDirectory: boolean }
const f = (name: string, size = 0, mtime = 0, isDirectory = false): Entry =>
  ({ name, size, mtime, permissions: 0o644, isDirectory })

const LOCAL_ENTRIES = [f('docs', 0, 0, true), f('notes.txt', 300, 1000), f('big.log', 900, 500), f('.env', 10, 1)]
const REMOTE_ENTRIES = [f('etc', 0, 0, true), f('alpha.txt', 50, 900), f('zeta.txt', 5, 100), f('.bashrc', 1, 1)]

function setup(overrides: Record<string, any> = {}) {
  const api = installWindowApi({
    localfs: {
      home: vi.fn().mockResolvedValue('/home/user'),
      list: vi.fn().mockResolvedValue(LOCAL_ENTRIES),
      readTextFile: vi.fn().mockResolvedValue('local file contents'),
    },
    sftp: {
      connect: vi.fn().mockResolvedValue('sftp-1'),
      list: vi.fn().mockResolvedValue(REMOTE_ENTRIES),
      readFile: vi.fn().mockResolvedValue('remote file contents'),
    },
    ...overrides,
  })
  const session = makeSession({ type: 'sftp' })
  seedStore({ sessions: [session], tabs: [], activeTabId: null })
  // streamId → connectSftp piggybacks on the live SSH stream, no credential lookup
  const tab = makeTab({ view: 'sftp', sessionId: session.id, streamId: 'stream-1' })
  const utils = render(<SftpBrowser tab={tab} />)
  return { api, session, tab, ...utils }
}

/** First-column names of a pane's table (0 = local, 1 = remote). */
function paneNames(container: HTMLElement, idx: 0 | 1): string[] {
  const table = container.querySelectorAll('table')[idx]
  return [...table.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent ?? '')
}

async function ready() {
  await waitFor(() => expect(screen.getByText('alpha.txt')).toBeTruthy())
}

beforeEach(() => {
  cleanup()
})

describe('SftpBrowser — connect and listing', () => {
  it('connects and renders both panes with directories first and hidden files filtered', async () => {
    const { container } = setup()
    await ready()
    const remote = paneNames(container, 1)
    expect(remote[0]).toContain('etc')
    expect(remote.join()).toContain('alpha.txt')
    expect(remote.join()).toContain('zeta.txt')
    expect(remote.join()).not.toContain('.bashrc')
    const local = paneNames(container, 0)
    expect(local.some(n => n.includes('docs'))).toBe(true)
    expect(local.join()).not.toContain('.env')
    // status bar counts exclude hidden files
    expect(screen.getByText('3 items')).toBeTruthy()
    expect(screen.getByText('3 items · /')).toBeTruthy()
  })

  it('shows hidden files when the eye toggle is flipped', async () => {
    setup()
    await ready()
    expect(screen.queryByText('.bashrc')).toBeNull()
    fireEvent.click(screen.getAllByTitle('Hidden files')[1]) // remote pane
    expect(screen.getByText('.bashrc')).toBeTruthy()
    fireEvent.click(screen.getAllByTitle('Hidden files')[0]) // local pane
    expect(screen.getByText('.env')).toBeTruthy()
  })

  it('shows a retry screen when the connection fails, and retries', async () => {
    const connect = vi.fn().mockRejectedValueOnce(new Error('auth failed')).mockResolvedValue('sftp-1')
    setup({ sftp: { connect, list: vi.fn().mockResolvedValue(REMOTE_ENTRIES) } })
    await waitFor(() => expect(screen.getByText('auth failed')).toBeTruthy())
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(screen.getByText('alpha.txt')).toBeTruthy())
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('surfaces a remote listing error inside the pane', async () => {
    setup({
      sftp: {
        connect: vi.fn().mockResolvedValue('sftp-1'),
        list: vi.fn().mockRejectedValue(new Error('permission denied')),
      },
    })
    await waitFor(() => expect(screen.getByText('permission denied')).toBeTruthy())
  })
})

describe('SftpBrowser — sorting', () => {
  it('sorts by size ascending, then descending on second click', async () => {
    const { container } = setup()
    await ready()
    const sizeHeader = screen.getAllByText('Size')[1] // remote table
    fireEvent.click(sizeHeader)
    let names = paneNames(container, 1)
    expect(names.findIndex(n => n.includes('zeta.txt'))).toBeLessThan(names.findIndex(n => n.includes('alpha.txt')))
    // directories always sort first
    expect(names[0]).toContain('etc')
    fireEvent.click(sizeHeader)
    names = paneNames(container, 1)
    expect(names.findIndex(n => n.includes('alpha.txt'))).toBeLessThan(names.findIndex(n => n.includes('zeta.txt')))
  })

  it('sorts by modified time', async () => {
    const { container } = setup()
    await ready()
    fireEvent.click(screen.getAllByText('Modified')[1])
    const names = paneNames(container, 1)
    // zeta mtime 100 < alpha mtime 900
    expect(names.findIndex(n => n.includes('zeta.txt'))).toBeLessThan(names.findIndex(n => n.includes('alpha.txt')))
  })

  it('sorts by name descending after toggling the name column', async () => {
    const { container } = setup()
    await ready()
    fireEvent.click(screen.getAllByText('Name')[1]) // already name asc → flips to desc
    const names = paneNames(container, 1)
    expect(names.findIndex(n => n.includes('zeta.txt'))).toBeLessThan(names.findIndex(n => n.includes('alpha.txt')))
  })
})

describe('SftpBrowser — navigation', () => {
  it('descends into a directory on double click and back up via ..', async () => {
    const { api } = setup()
    await ready()
    fireEvent.doubleClick(screen.getByText('etc'))
    await waitFor(() => expect(api.sftp.list).toHaveBeenCalledWith('sftp-1', '/etc'))
    // ".." row appears once path is not root (local pane already shows one for /home/user)
    const ups = await screen.findAllByText('..')
    fireEvent.click(ups[ups.length - 1]) // remote pane is rendered last
    await waitFor(() => expect(api.sftp.list).toHaveBeenLastCalledWith('sftp-1', '/'))
  })

  it('navigates the local pane up from the home directory', async () => {
    const { api } = setup()
    await ready()
    fireEvent.click(screen.getAllByTitle('Up')[0]) // local pane, path /home/user
    await waitFor(() => expect(api.localfs.list).toHaveBeenCalledWith('/home'))
  })

  it('disables the Up button at the remote root', async () => {
    setup()
    await ready()
    const up = screen.getAllByTitle('Up')[1] as HTMLButtonElement
    expect(up.disabled).toBe(true)
  })
})

describe('SftpBrowser — selection and transfers', () => {
  it('downloads the selected remote file', async () => {
    const { api } = setup()
    await ready()
    fireEvent.click(screen.getByText('alpha.txt'))
    fireEvent.click(screen.getByText('Download'))
    await waitFor(() =>
      expect(api.sftp.download).toHaveBeenCalledWith('sftp-1', '/alpha.txt', '/home/user/alpha.txt'),
    )
  })

  it('extends the selection with meta-click and downloads both', async () => {
    const { api } = setup()
    await ready()
    fireEvent.click(screen.getByText('alpha.txt'))
    fireEvent.click(screen.getByText('zeta.txt'), { metaKey: true })
    fireEvent.click(screen.getByText('Download'))
    await waitFor(() => expect(api.sftp.download).toHaveBeenCalledTimes(2))
  })

  it('selects a range with shift-click', async () => {
    const { api } = setup()
    await ready()
    fireEvent.click(screen.getByText('alpha.txt'))
    fireEvent.click(screen.getByText('zeta.txt'), { shiftKey: true })
    fireEvent.click(screen.getByText('Download'))
    await waitFor(() => expect(api.sftp.download).toHaveBeenCalledTimes(2))
  })

  it('uploads a selected local file and shows the transfer in the queue', async () => {
    const { api } = setup()
    await ready()
    fireEvent.click(screen.getByText('notes.txt'))
    fireEvent.click(screen.getByText('Upload'))
    await waitFor(() =>
      expect(api.sftp.upload).toHaveBeenCalledWith('sftp-1', '/home/user/notes.txt', '/notes.txt'),
    )
    // transfer row rendered in the queue (name appears twice: table + queue)
    await waitFor(() => expect(screen.getAllByText('notes.txt').length).toBeGreaterThan(1))
  })

  it('marks a failed upload and shows the error', async () => {
    setup({
      sftp: {
        connect: vi.fn().mockResolvedValue('sftp-1'),
        list: vi.fn().mockResolvedValue(REMOTE_ENTRIES),
        upload: vi.fn().mockRejectedValue(new Error('disk full')),
      },
    })
    await ready()
    fireEvent.click(screen.getByText('notes.txt'))
    fireEvent.click(screen.getByText('Upload'))
    await waitFor(() => expect(screen.getByText('disk full')).toBeTruthy())
  })

  it('meta-click on a selected row deselects it', async () => {
    setup()
    await ready()
    fireEvent.click(screen.getByText('alpha.txt'))
    fireEvent.click(screen.getByText('alpha.txt'), { metaKey: true })
    const download = screen.getByText('Download').closest('button') as HTMLButtonElement
    expect(download.disabled).toBe(true)
  })
})

describe('SftpBrowser — quick look', () => {
  it('opens the remote quick look with Space and closes with Escape', async () => {
    const { api } = setup()
    await ready()
    fireEvent.click(screen.getByText('alpha.txt'))
    fireEvent.keyDown(document.body, { key: ' ' })
    await waitFor(() => expect(screen.getByText('remote file contents')).toBeTruthy())
    expect(api.sftp.readFile).toHaveBeenCalledWith('sftp-1', '/alpha.txt')
    expect(screen.getByText('Press Space to close · Esc to dismiss')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('remote file contents')).toBeNull())
  })

  it('reads local files for quick look when the local pane is focused', async () => {
    const { api, container } = setup()
    await ready()
    // focus local pane, then select a local file
    fireEvent.click(container.querySelectorAll('table')[0])
    fireEvent.click(screen.getByText('notes.txt'))
    fireEvent.keyDown(document.body, { key: ' ' })
    await waitFor(() => expect(screen.getByText('local file contents')).toBeTruthy())
    expect(api.localfs.readTextFile).toHaveBeenCalledWith('/home/user/notes.txt')
  })

  it('falls back to a placeholder for unreadable files', async () => {
    setup({
      sftp: {
        connect: vi.fn().mockResolvedValue('sftp-1'),
        list: vi.fn().mockResolvedValue(REMOTE_ENTRIES),
        readFile: vi.fn().mockRejectedValue(new Error('binary')),
      },
    })
    await ready()
    fireEvent.click(screen.getByText('alpha.txt'))
    fireEvent.keyDown(document.body, { key: ' ' })
    await waitFor(() => expect(screen.getByText('(binary or unreadable file)')).toBeTruthy())
  })

  it('pressing Space again on the same file closes the overlay', async () => {
    setup()
    await ready()
    fireEvent.click(screen.getByText('alpha.txt'))
    fireEvent.keyDown(document.body, { key: ' ' })
    await waitFor(() => expect(screen.getByText('remote file contents')).toBeTruthy())
    fireEvent.keyDown(document.body, { key: ' ' })
    await waitFor(() => expect(screen.queryByText('remote file contents')).toBeNull())
  })

  it('closes via the X button', async () => {
    setup()
    await ready()
    fireEvent.click(screen.getByText('alpha.txt'))
    fireEvent.keyDown(document.body, { key: ' ' })
    const pre = await screen.findByText('remote file contents')
    const overlayHeader = pre.previousElementSibling as HTMLElement
    fireEvent.click(overlayHeader.querySelector('button')!)
    await waitFor(() => expect(screen.queryByText('remote file contents')).toBeNull())
  })
})

describe('SftpBrowser — diff mode and file management', () => {
  it('toggles diff mode and shows the legend', async () => {
    // overlapping names so all diff states occur
    setup({
      localfs: {
        home: vi.fn().mockResolvedValue('/home/user'),
        list: vi.fn().mockResolvedValue([f('same.txt', 10, 1), f('changed.txt', 20, 1), f('onlylocal.txt', 5, 1)]),
      },
      sftp: {
        connect: vi.fn().mockResolvedValue('sftp-1'),
        list: vi.fn().mockResolvedValue([f('same.txt', 10, 1), f('changed.txt', 99, 1), f('onlyremote.txt', 7, 1)]),
      },
    })
    await waitFor(() => expect(screen.getByText('onlyremote.txt')).toBeTruthy())
    fireEvent.click(screen.getByText('Diff'))
    expect(screen.getByText('local only')).toBeTruthy()
    expect(screen.getByText('remote only')).toBeTruthy()
    expect(screen.getByText('different')).toBeTruthy()
  })

  it('creates a remote folder via prompt', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'newdir'))
    const { api } = setup()
    await ready()
    fireEvent.click(screen.getByTitle('New folder'))
    await waitFor(() => expect(api.sftp.mkdir).toHaveBeenCalledWith('sftp-1', '/newdir'))
    vi.unstubAllGlobals()
  })

  it('renames a remote file via the row action', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'renamed.txt'))
    const { api } = setup()
    await ready()
    fireEvent.click(screen.getAllByTitle('Rename')[1]) // row 0 is the etc dir; row 1 is alpha.txt
    await waitFor(() =>
      expect(api.sftp.rename).toHaveBeenCalledWith('sftp-1', '/alpha.txt', '/renamed.txt'),
    )
    vi.unstubAllGlobals()
  })

  it('deletes a remote file after confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const { api } = setup()
    await ready()
    fireEvent.click(screen.getAllByTitle('Delete')[1]) // row 0 is the etc dir; row 1 is alpha.txt
    await waitFor(() => expect(api.sftp.delete).toHaveBeenCalledWith('sftp-1', '/alpha.txt'))
    vi.unstubAllGlobals()
  })

  it('refreshes the remote pane via the refresh button', async () => {
    const { api } = setup()
    await ready()
    const before = api.sftp.list.mock.calls.length
    fireEvent.click(screen.getAllByTitle('Refresh')[1])
    await waitFor(() => expect(api.sftp.list.mock.calls.length).toBeGreaterThan(before))
  })
})
