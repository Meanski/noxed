// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FilesDrawer from '../FilesDrawer'
import { installWindowApi, seedStore, makeSession, makeTab, WindowApiMock } from '../../../__tests__/harness'

const entries = [
  { name: 'zeta.txt', size: 2048, mtime: 0, isDirectory: false },
  { name: 'etc', size: 0, mtime: 0, isDirectory: true },
  { name: 'alpha.txt', size: 10, mtime: 0, isDirectory: false },
]

let api: WindowApiMock

describe('FilesDrawer', () => {
  beforeEach(() => {
    api = installWindowApi({ sftp: { list: vi.fn().mockResolvedValue(entries) } })
    seedStore({
      sessions: [makeSession({ id: 's1', host: 'files.example.com' })],
      tabs: [], notifications: [],
    })
  })

  function renderDrawer() {
    const tab = makeTab({ sessionId: 's1', streamId: 'stream-1' })
    return render(<FilesDrawer tab={tab} onClose={vi.fn()} />)
  }

  it('lists directory entries with directories first, then files alphabetically', async () => {
    const { container } = renderDrawer()
    await waitFor(() => expect(screen.getByText('alpha.txt')).toBeTruthy())

    const text = container.textContent ?? ''
    const dir = text.indexOf('etc')
    const a = text.indexOf('alpha.txt')
    const z = text.indexOf('zeta.txt')
    expect(dir).toBeLessThan(a)
    expect(a).toBeLessThan(z)

    // Footer shows the entry count
    expect(screen.getByText('3 items')).toBeTruthy()
  })

  it('navigates into directories', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByText('etc')).toBeTruthy())

    fireEvent.click(screen.getByTitle('Open'))
    await waitFor(() => expect(api.sftp.list).toHaveBeenCalledWith('sftp-1', '/etc'))
  })

  it('shows the connection error state when SFTP fails', async () => {
    api.sftp.connect.mockRejectedValueOnce(new Error('auth failed'))
    renderDrawer()
    await waitFor(() => expect(screen.getByText('auth failed')).toBeTruthy())
  })
})
