// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import DatabaseExplorer from '../DatabaseExplorer'
import { installWindowApi, seedStore, makeSession, makeTab, WindowApiMock } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

const usersResult = {
  columns: ['id', 'name', 'active', 'meta'],
  rows: [
    { id: 1, name: 'alice', active: true, meta: { role: 'admin' } },
    { id: 2, name: 'bob', active: false, meta: null },
  ],
  rowCount: 2,
  duration: 12,
}

const tableInfoResult = {
  columns: [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'name', type: 'varchar', nullable: true },
    { name: 'created', type: 'timestamp', nullable: true },
    { name: 'active', type: 'boolean', nullable: false },
    { name: 'meta', type: 'jsonb', nullable: true },
    { name: 'uid', type: 'uuid', nullable: true },
    { name: 'blob', type: 'bytea', nullable: true },
  ],
  primaryKey: ['id'],
}

// Browsing returns rows; writes report one affected row, like the drivers.
const writeOk = { columns: [], rows: [], rowCount: 1, duration: 1 }
const routedQuery = (rows = usersResult) =>
  vi.fn().mockImplementation((_id: string, q: string) =>
    Promise.resolve(/^(UPDATE|INSERT|DELETE)/.test(q) ? writeOk : rows))

function setup(sessionOverrides: Record<string, any> = {}, dbOverrides: Record<string, any> = {}) {
  const session = makeSession({
    type: 'database',
    dbType: 'postgresql',
    databaseName: 'appdb',
    host: 'db.example.com',
    port: 5432,
    username: 'admin',
    sslMode: 'disable',
    ...sessionOverrides,
  } as any)
  const tab = makeTab({ sessionId: session.id, view: 'database' as any, label: 'appdb' })
  const api = installWindowApi({
    database: {
      connect: vi.fn().mockResolvedValue('db-1'),
      disconnect: vi.fn().mockResolvedValue(undefined),
      query: routedQuery(),
      tables: vi.fn().mockResolvedValue(['users', 'orders', 'audit_log']),
      tableInfo: vi.fn().mockResolvedValue(tableInfoResult),
      ...dbOverrides,
    },
  })
  seedStore({ sessions: [session], tabs: [tab] } as any)
  return { session, tab, api }
}

async function renderConnected(sessionOverrides: Record<string, any> = {}, dbOverrides: Record<string, any> = {}) {
  const ctx = setup(sessionOverrides, dbOverrides)
  const utils = render(<DatabaseExplorer tab={ctx.tab} />)
  await screen.findByText('Tables (3)')
  return { ...ctx, ...utils }
}

const editor = () => screen.getByPlaceholderText('SELECT * FROM …') as HTMLTextAreaElement

async function runSql(api: WindowApiMock, sql: string) {
  fireEvent.change(editor(), { target: { value: sql } })
  fireEvent.click(screen.getByText('Run'))
  await waitFor(() => expect(api.database.query).toHaveBeenCalled())
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
  ;(URL as any).createObjectURL = vi.fn(() => 'blob:test')
  ;(URL as any).revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DatabaseExplorer — connect flow', () => {
  it('shows connecting state then the schema sidebar after connect', async () => {
    const { api, session } = setup()
    render(<DatabaseExplorer tab={useAppStore.getState().tabs[0]} />)
    expect(screen.getByText(/Connecting to appdb/)).toBeTruthy()
    await screen.findByText('Tables (3)')
    expect(api.sessions.getCredentials).toHaveBeenCalledWith(session.id)
    expect(api.database.connect).toHaveBeenCalledWith({
      dbType: 'postgresql',
      host: 'db.example.com',
      port: 5432,
      username: 'admin',
      password: 'pw',
      database: 'appdb',
      ssl: 'disable',
    })
    expect(screen.getByText('users')).toBeTruthy()
    expect(screen.getByText('orders')).toBeTruthy()
    expect(screen.getByText(/PostgreSQL · db.example.com:5432/)).toBeTruthy()
    expect(useAppStore.getState().tabs[0].status).toBe('connected')
  })

  it('shows the error screen when connect fails and retries on click', async () => {
    const { tab, api } = setup({}, {
      connect: vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue('db-2'),
    })
    render(<DatabaseExplorer tab={tab} />)
    await screen.findByText('ECONNREFUSED')
    expect(useAppStore.getState().tabs[0].status).toBe('error')
    fireEvent.click(screen.getByText('Retry'))
    await screen.findByText('Tables (3)')
    expect(api.database.connect).toHaveBeenCalledTimes(2)
  })

  it('maps a locked-vault credential error to a friendly message', async () => {
    const { tab } = setup()
    ;(window as any).api.sessions.getCredentials = vi.fn().mockRejectedValue(new Error('vault is locked'))
    render(<DatabaseExplorer tab={tab} />)
    expect(await screen.findByText('App is locked — unlock noxed to reconnect')).toBeTruthy()
  })

  it('disconnects on unmount and logs when disconnect fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { api, unmount } = await renderConnected()
    api.database.disconnect.mockRejectedValueOnce(new Error('gone'))
    unmount()
    await waitFor(() => expect(api.database.disconnect).toHaveBeenCalledWith('db-1'))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
  })
})

describe('DatabaseExplorer — sidebar and tables', () => {
  it('filters tables and clears the filter', async () => {
    await renderConnected()
    const filter = screen.getByPlaceholderText('Filter tables…')
    fireEvent.change(filter, { target: { value: 'ORD' } })
    expect(screen.getByText('orders')).toBeTruthy()
    expect(screen.queryByText('users')).toBeNull()
    const clearBtn = filter.parentElement!.querySelector('button')!
    fireEvent.click(clearBtn)
    expect(screen.getByText('users')).toBeTruthy()
  })

  it('refreshes tables and toasts when refresh fails', async () => {
    const { api } = await renderConnected()
    api.database.tables.mockResolvedValueOnce(['users', 'orders', 'audit_log', 'new_table'])
    const header = screen.getByText('appdb').parentElement!
    fireEvent.click(header.querySelector('button')!)
    await screen.findByText('Tables (4)')
    api.database.tables.mockRejectedValueOnce(new Error('schema read failed'))
    fireEvent.click(header.querySelector('button')!)
    expect(await screen.findByText('schema read failed')).toBeTruthy()
  })

  it('browses a table on click, loads columns with type badges, and collapses on second click', async () => {
    const { api } = await renderConnected()
    fireEvent.click(screen.getByText('users'))
    await waitFor(() =>
      expect(api.database.query).toHaveBeenCalledWith('db-1', 'SELECT * FROM "users" LIMIT 100')
    )
    expect(api.database.tableInfo).toHaveBeenCalledWith('db-1', 'users')
    await screen.findByText('integer')
    expect(screen.getByText('varchar')).toBeTruthy()
    expect(screen.getByText('timestamp')).toBeTruthy()
    expect(screen.getByText('boolean')).toBeTruthy()
    expect(screen.getByText('jsonb')).toBeTruthy()
    expect(screen.getByText('uuid')).toBeTruthy()
    expect(screen.getByText('bytea')).toBeTruthy()
    // Grid rendered
    await screen.findByText('alice')
    expect((editor() as HTMLTextAreaElement).value).toBe('SELECT * FROM "users" LIMIT 100')
    // Collapse
    fireEvent.click(screen.getByText('users'))
    expect(screen.queryByText('integer')).toBeNull()
  })

  it('toasts when loading table columns fails', async () => {
    await renderConnected({}, { tableInfo: vi.fn().mockRejectedValue(new Error('no perms')) })
    fireEvent.click(screen.getByText('orders'))
    expect(await screen.findByText('no perms')).toBeTruthy()
  })
})

describe('DatabaseExplorer — toolbar and query running', () => {
  it('disables Run without SQL, runs a query, and records history', async () => {
    const { api } = await renderConnected()
    const runBtn = screen.getByText('Run').closest('button')!
    expect(runBtn.hasAttribute('disabled')).toBe(true)
    await runSql(api, 'SELECT * FROM users')
    await screen.findByText('alice')
    expect(screen.getByText(/4 cols · 12ms/)).toBeTruthy()
    // history entry
    fireEvent.click(screen.getByText('History'))
    // the textarea still holds the same SQL, so target the history <pre> entry
    const historyEntry = screen.getAllByText('SELECT * FROM users').find(el => el.tagName === 'PRE')!
    expect(historyEntry).toBeTruthy()
    expect(screen.getByText('12ms')).toBeTruthy()
    expect(screen.getByText('2 rows')).toBeTruthy()
    // picking a history entry restores the SQL and returns to results
    fireEvent.click(historyEntry)
    expect(editor().value).toBe('SELECT * FROM users')
    await screen.findByText('alice')
  })

  it('runs the query on Ctrl+Enter', async () => {
    const { api } = await renderConnected()
    fireEvent.change(editor(), { target: { value: 'SELECT 1' } })
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(api.database.query).toHaveBeenCalledWith('db-1', 'SELECT 1'))
  })

  it('shows the query error panel when a query fails', async () => {
    const { api } = await renderConnected({}, {
      query: vi.fn().mockRejectedValue(new Error('syntax error at or near "FRM"')),
    })
    await runSql(api, 'SELECT * FRM users')
    await screen.findByText('syntax error at or near "FRM"')
  })

  it('shows No rows for an empty result', async () => {
    const { api } = await renderConnected({}, {
      query: vi.fn().mockResolvedValue({ columns: ['id'], rows: [], rowCount: 0, duration: 3 }),
    })
    await runSql(api, 'SELECT * FROM empty')
    await screen.findByText('No rows')
  })

  it('saves a query via prompt and lists it in the Saved panel', async () => {
    const { api } = await renderConnected()
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('All users')
    await runSql(api, 'SELECT * FROM users')
    fireEvent.click(screen.getByText('Save'))
    await screen.findByText('Query saved')
    // cancelled prompt saves nothing
    promptSpy.mockReturnValueOnce(null)
    fireEvent.click(screen.getByText('Save'))
    fireEvent.click(screen.getByText('Saved'))
    expect(screen.getByText('All users')).toBeTruthy()
    // picking a saved query restores its SQL
    fireEvent.click(screen.getByText('All users'))
    expect(editor().value).toBe('SELECT * FROM users')
  })

  it('shows the empty Saved panel hint', async () => {
    await renderConnected()
    fireEvent.click(screen.getByText('Saved'))
    expect(screen.getByText('Save queries with the Pin button')).toBeTruthy()
    fireEvent.click(screen.getByText('History'))
    expect(screen.getByText('No history')).toBeTruthy()
  })

  it('clears editor and results with Clear', async () => {
    const { api } = await renderConnected()
    await runSql(api, 'SELECT * FROM users')
    await screen.findByText('alice')
    fireEvent.click(screen.getByText('Clear'))
    expect(editor().value).toBe('')
    expect(screen.queryByText('alice')).toBeNull()
    expect(screen.getByText('Click a table to browse, or write a query')).toBeTruthy()
  })

  it('truncates long SQL in the history panel', async () => {
    const { api } = await renderConnected()
    const longSql = 'SELECT ' + 'x'.repeat(250)
    await runSql(api, longSql)
    fireEvent.click(screen.getByText('History'))
    expect(screen.getByText((t) => t.endsWith('…') && t.startsWith('SELECT '))).toBeTruthy()
  })
})

describe('DatabaseExplorer — results grid', () => {
  const sortResult = {
    columns: ['id', 'name'],
    rows: [
      { id: 2, name: 'bob' },
      { id: 1, name: 'alice' },
      { id: 3, name: null },
    ],
    rowCount: 3,
    duration: 5,
  }

  function orderOf(container: HTMLElement, a: string, b: string) {
    const t = container.textContent!
    return t.indexOf(a) < t.indexOf(b)
  }

  it('sorts by column ascending, descending, and numerically', async () => {
    const { api, container } = await renderConnected({}, {
      query: vi.fn().mockResolvedValue(sortResult),
    })
    await runSql(api, 'SELECT * FROM t')
    await screen.findByText('alice')
    // unsorted: bob first
    expect(orderOf(container, 'bob', 'alice')).toBe(true)
    // sort by name asc
    fireEvent.click(screen.getByText('name'))
    expect(orderOf(container, 'alice', 'bob')).toBe(true)
    // sort by name desc
    fireEvent.click(screen.getByText('name'))
    expect(orderOf(container, 'bob', 'alice')).toBe(true)
    // numeric sort by id asc
    fireEvent.click(screen.getByText('id'))
    expect(orderOf(container, 'alice', 'bob')).toBe(true)
  })

  it('keeps the selection on the same row when the grid is re-sorted', async () => {
    const { api } = await renderConnected({}, { query: vi.fn().mockResolvedValue(sortResult) })
    await runSql(api, 'SELECT * FROM t')
    fireEvent.click((await screen.findByText('bob')).closest('tr')!)
    fireEvent.click(screen.getByTitle('Row detail'))
    expect(screen.getByText('Row 1')).toBeTruthy()
    fireEvent.click(screen.getAllByText('name')[0])
    // bob is now second; the detail panel still shows bob, numbered by position.
    const detail = screen.getByText('Row 2').parentElement!.parentElement as HTMLElement
    expect(within(detail).getByText('bob')).toBeTruthy()
  })

  it('selects rows via click and Enter/Space keydown and shows the detail panel', async () => {
    const { api } = await renderConnected()
    await runSql(api, 'SELECT * FROM users')
    const aliceRow = (await screen.findByText('alice')).closest('tr') as HTMLElement
    fireEvent.click(aliceRow)
    fireEvent.click(screen.getByTitle('Row detail'))
    const detail = screen.getByText('Row 1').parentElement!.parentElement as HTMLElement
    // objects render as one JSON.stringify'd <pre> text node
    expect(within(detail).getByText(/"role": "admin"/)).toBeTruthy()
    // deselect via click hides the panel content (getDetailRow returns null)
    fireEvent.click(aliceRow)
    expect(screen.queryByText('Row 1')).toBeNull()
    // select bob via Enter key: NULL meta shown in detail
    const bobRow = screen.getByText('bob').closest('tr') as HTMLElement
    fireEvent.keyDown(bobRow, { key: 'Enter' })
    await screen.findByText('Row 2')
    // deselect via Space key
    fireEvent.keyDown(bobRow, { key: ' ' })
    expect(screen.queryByText('Row 2')).toBeNull()
    // close button
    fireEvent.keyDown(aliceRow, { key: 'Enter' })
    const panel = await screen.findByText('Row 1')
    fireEvent.click(panel.parentElement!.querySelector('button')!)
    expect(screen.queryByText('Row 1')).toBeNull()
  })

  it('renders smart cells: URL, hex color, ISO date, boolean, JSON string and expandable object', async () => {
    const rich = {
      columns: ['id', 'site', 'color', 'created', 'active', 'meta', 'note', 'empty'],
      rows: [{
        id: 1,
        site: 'https://example.com/page',
        color: '#ff0000',
        created: '2024-03-05T10:00:00Z',
        active: true,
        meta: { role: 'admin' },
        note: '[1,2]',
        empty: null,
      }],
      rowCount: 1,
      duration: 2,
    }
    const { api } = await renderConnected({}, { query: vi.fn().mockResolvedValue(rich) })
    await runSql(api, 'SELECT * FROM rich')
    // URL link
    const link = await screen.findByText('https://example.com/page')
    expect(link.getAttribute('href')).toBe('https://example.com/page')
    // hex color swatch
    expect(screen.getByText('#ff0000')).toBeTruthy()
    // boolean
    expect(screen.getByText('true')).toBeTruthy()
    // NULL cell
    expect(screen.getByText('NULL')).toBeTruthy()
    // ISO date renders relative time
    expect(screen.getByText(/\(.*ago\)/)).toBeTruthy()
    // JSON object cell: badge with key count, expand and collapse
    const objBadge = screen.getByText('{1}').closest('button')!
    fireEvent.click(objBadge)
    expect(screen.getByText(/"role": "admin"/)).toBeTruthy()
    fireEvent.click(objBadge)
    expect(screen.queryByText(/"role": "admin"/)).toBeNull()
    // JSON string cell: array badge
    expect(screen.getByText('[2]')).toBeTruthy()
  })

  it('copies results as TSV and exports CSV with escaping', async () => {
    const res = {
      columns: ['id', 'name'],
      rows: [
        { id: 1, name: 'has,comma' },
        { id: 2, name: null },
        { id: 3, name: 'has"quote' },
      ],
      rowCount: 3,
      duration: 1,
    }
    const { api } = await renderConnected({}, { query: vi.fn().mockResolvedValue(res) })
    await runSql(api, 'SELECT * FROM t')
    await screen.findByText('has,comma')
    fireEvent.click(screen.getByTitle('Copy'))
    expect((navigator.clipboard.writeText as any)).toHaveBeenCalledWith(
      'id\tname\n1\thas,comma\n2\t\n3\thas"quote'
    )
    await screen.findByText('Copied')
    fireEvent.click(screen.getByTitle('CSV'))
    expect((URL as any).createObjectURL).toHaveBeenCalled()
    const blob: Blob = (URL as any).createObjectURL.mock.calls[0][0]
    const text = await blob.text()
    expect(text).toBe('id,name\n1,"has,comma"\n2,\n3,"has""quote"')
    await screen.findByText('Exported')
  })

  it('resizes the editor with the drag handle', async () => {
    const { container } = await renderConnected()
    const handle = container.querySelector('.cursor-row-resize') as HTMLElement
    const editorWrap = editor().parentElement as HTMLElement
    expect(editorWrap.style.height).toBe('120px')
    // jsdom lays the editor out at top 0, so pointer y is the new height.
    fireEvent.pointerDown(handle, { button: 0, clientY: 120 })
    fireEvent.pointerMove(handle, { clientY: 200 })
    expect(editorWrap.style.height).toBe('200px')
    fireEvent.pointerUp(handle)
    fireEvent.pointerMove(handle, { clientY: 300 })
    expect(editorWrap.style.height).toBe('200px')
    // Keyboard users resize through the handle's range input.
    fireEvent.change(screen.getByLabelText('Resize query editor'), { target: { value: '90' } })
    expect(editorWrap.style.height).toBe('90px')
  })
})

describe('DatabaseExplorer — row editing', () => {
  async function browseUsers(dbOverrides: Record<string, any> = {}) {
    const ctx = await renderConnected({}, dbOverrides)
    fireEvent.click(screen.getByText('users'))
    await screen.findByText('alice')
    return ctx
  }

  async function editCell(text: string, value: string) {
    fireEvent.doubleClick(screen.getByText(text))
    const input = await screen.findByDisplayValue(text)
    fireEvent.change(input, { target: { value } })
    fireEvent.keyDown(input, { key: 'Enter' })
  }

  it('edits a cell (object value uses JSON.stringify) and issues an UPDATE keyed on the primary key', async () => {
    const { api } = await browseUsers()
    const metaBadge = screen.getByText('{1}').closest('td')!
    fireEvent.doubleClick(metaBadge)
    const input = await screen.findByDisplayValue('{"role":"admin"}')
    fireEvent.change(input, { target: { value: '{"role":"user"}' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(api.database.query).toHaveBeenCalledWith(
        'db-1',
        'UPDATE "users" SET "meta" = $1 WHERE "id" = $2',
        ['{"role":"user"}', 1],
      )
    )
    await screen.findByText('Updated')
  })

  it('sets NULL when emptied and identifies rows by a composite key', async () => {
    const res = { columns: ['org', 'code', 'label'], rows: [{ org: 7, code: "o'k", label: 'old' }], rowCount: 1, duration: 1 }
    const { api } = await renderConnected({}, {
      query: routedQuery(res as any),
      tableInfo: vi.fn().mockResolvedValue({ columns: [], primaryKey: ['org', 'code'] }),
    })
    fireEvent.click(screen.getByText('users'))
    await screen.findByText('old')
    await editCell('old', '')
    await waitFor(() =>
      expect(api.database.query).toHaveBeenCalledWith(
        'db-1',
        'UPDATE "users" SET "label" = $1 WHERE "org" = $2 AND "code" = $3',
        [null, 7, "o'k"],
      )
    )
    await screen.findByText('NULL')
  })

  it('uses MySQL quoting and placeholders for browsing and edits', async () => {
    const { api } = await renderConnected({ dbType: 'mysql' })
    fireEvent.click(screen.getByText('users'))
    await screen.findByText('alice')
    expect(api.database.query).toHaveBeenCalledWith('db-1', 'SELECT * FROM `users` LIMIT 100')
    await editCell('alice', 'alicia')
    await waitFor(() =>
      expect(api.database.query).toHaveBeenCalledWith('db-1', 'UPDATE `users` SET `name` = ? WHERE `id` = ?', ['alicia', 1])
    )
  })

  it('edits the row that is shown, even when the grid is sorted', async () => {
    const { api } = await browseUsers()
    // Sort descending by name so bob is shown first.
    const header = within(screen.getByRole('table')).getAllByRole('button').find((b) => b.textContent?.startsWith('name'))!
    fireEvent.click(header)
    fireEvent.click(header)
    await editCell('bob', 'robert')
    await waitFor(() =>
      expect(api.database.query).toHaveBeenCalledWith('db-1', 'UPDATE "users" SET "name" = $1 WHERE "id" = $2', ['robert', 2])
    )
  })

  it('skips the UPDATE when the value is unchanged and cancels on Escape', async () => {
    const { api } = await browseUsers()
    const callsBefore = api.database.query.mock.calls.length
    fireEvent.doubleClick(screen.getByText('alice'))
    const input = await screen.findByDisplayValue('alice')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.database.query.mock.calls).toHaveLength(callsBefore)
    fireEvent.doubleClick(screen.getByText('bob'))
    const input2 = await screen.findByDisplayValue('bob')
    fireEvent.keyDown(input2, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByDisplayValue('bob')).toBeNull())
    expect(api.database.query.mock.calls).toHaveLength(callsBefore)
  })

  it('never edits free-form query results, even right after browsing a table', async () => {
    const { api } = await browseUsers()
    await runSql(api, 'SELECT * FROM users WHERE id > 0')
    await screen.findByText('alice')
    fireEvent.doubleClick(screen.getByText('alice'))
    expect(screen.queryByDisplayValue('alice')).toBeNull()
    expect(api.database.query).not.toHaveBeenCalledWith('db-1', expect.stringMatching(/^UPDATE/), expect.anything())
  })

  it('shows only the latest table when an earlier query answers late', async () => {
    let finishUsers: (r: unknown) => void = () => undefined
    const orders = { columns: ['id', 'total'], rows: [{ id: 9, total: 'ninety-nine' }], rowCount: 1, duration: 1 }
    await renderConnected({}, {
      query: vi.fn().mockImplementation((_id: string, q: string) =>
        q.includes('"users"') ? new Promise((r) => { finishUsers = r }) : Promise.resolve(orders)),
    })
    fireEvent.click(screen.getByText('users'))
    fireEvent.click(screen.getByText('orders'))
    await screen.findByText('ninety-nine')
    await act(async () => { finishUsers(usersResult) })
    expect(screen.getByText('ninety-nine')).toBeTruthy()
    expect(screen.queryByText('alice')).toBeNull()
  })

  it('keeps tables without a primary key read-only', async () => {
    await browseUsers({ tableInfo: vi.fn().mockResolvedValue({ ...tableInfoResult, primaryKey: [] }) })
    fireEvent.doubleClick(screen.getByText('alice'))
    expect(await screen.findByText('users has no primary key, so its rows are read-only')).toBeTruthy()
    expect(screen.queryByDisplayValue('alice')).toBeNull()
    expect(screen.queryByTitle('Add row')).toBeNull()
  })

  it('does not apply an update that matched other than one row', async () => {
    const query = vi.fn().mockImplementation((_id: string, q: string) =>
      Promise.resolve(q.startsWith('UPDATE') ? { ...writeOk, rowCount: 0 } : usersResult))
    await browseUsers({ query })
    await editCell('alice', 'alicia')
    expect(await screen.findByText('Update matched 0 rows; reload to see the current data')).toBeTruthy()
    expect(screen.getByText('alice')).toBeTruthy()
  })

  it('toasts when the UPDATE fails', async () => {
    const query = vi.fn().mockImplementation((_id: string, q: string) =>
      q.startsWith('UPDATE') ? Promise.reject(new Error('permission denied')) : Promise.resolve(usersResult))
    await browseUsers({ query })
    await editCell('alice', 'alicia')
    expect(await screen.findByText('Update failed: permission denied')).toBeTruthy()
  })

  it('does not open the editor when results did not come from browsing a table', async () => {
    const { api } = await renderConnected()
    await runSql(api, 'SELECT * FROM users')
    fireEvent.doubleClick(await screen.findByText('alice'))
    expect(screen.queryByDisplayValue('alice')).toBeNull()
  })

  it('adds a row, leaving blank fields to their defaults, then reloads', async () => {
    const { api } = await browseUsers()
    fireEvent.click(screen.getByTitle('Add row'))
    const dialog = await screen.findByRole('dialog', { name: 'Add row to users' })
    fireEvent.change(within(dialog).getByLabelText(/^name/), { target: { value: 'carol' } })
    fireEvent.change(within(dialog).getByLabelText(/^active/), { target: { value: 'true' } })
    fireEvent.click(within(dialog).getByText('Add row'))
    await waitFor(() =>
      expect(api.database.query).toHaveBeenCalledWith('db-1', 'INSERT INTO "users" ("name", "active") VALUES ($1, $2)', ['carol', true])
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.database.query).toHaveBeenLastCalledWith('db-1', 'SELECT * FROM "users" LIMIT 100')
  })

  it('keeps the insert form open when the INSERT fails', async () => {
    const query = vi.fn().mockImplementation((_id: string, q: string) =>
      q.startsWith('INSERT') ? Promise.reject(new Error('null value in column "id"')) : Promise.resolve(usersResult))
    await browseUsers({ query })
    fireEvent.click(screen.getByTitle('Add row'))
    const dialog = await screen.findByRole('dialog', { name: 'Add row to users' })
    fireEvent.click(within(dialog).getByText('Add row'))
    expect(await screen.findByText('Insert failed: null value in column "id"')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Add row to users' })).toBeTruthy()
    fireEvent.click(within(dialog).getByText('Cancel'))
  })

  it('deletes the selected row after confirming its key', async () => {
    const { api } = await browseUsers()
    expect(screen.queryByTitle('Delete selected row')).toBeNull()
    fireEvent.click(screen.getByTitle('Select row 2'))
    fireEvent.click(screen.getByTitle('Delete selected row'))
    const dialog = await screen.findByRole('dialog', { name: 'Delete row from users?' })
    expect(within(dialog).getByText('id = 2')).toBeTruthy()
    fireEvent.click(within(dialog).getByText('Delete row'))
    await waitFor(() => expect(api.database.query).toHaveBeenCalledWith('db-1', 'DELETE FROM "users" WHERE "id" = $1', [2]))
    expect(await screen.findByText('Row deleted')).toBeTruthy()
  })

  it('cancels a delete, and reports a failed one', async () => {
    const query = vi.fn().mockImplementation((_id: string, q: string) =>
      q.startsWith('DELETE') ? Promise.reject(new Error('foreign key violation')) : Promise.resolve(usersResult))
    const { api } = await browseUsers({ query })
    fireEvent.click(screen.getByTitle('Select row 1'))
    fireEvent.click(screen.getByTitle('Delete selected row'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Cancel'))
    expect(api.database.query.mock.calls.some((c: unknown[]) => String(c[1]).startsWith('DELETE'))).toBe(false)
    fireEvent.click(screen.getByTitle('Delete selected row'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Delete row'))
    expect(await screen.findByText('Delete failed: foreign key violation')).toBeTruthy()
  })
})

describe('DatabaseExplorer — explain', () => {
  const pgPlan = {
    'Node Type': 'Seq Scan',
    'Relation Name': 'users',
    'Total Cost': 100,
    'Plan Rows': 50,
    'Plan Width': 8,
    'Actual Total Time': 1.23,
    'Actual Rows': 48,
    Plans: [
      { 'Node Type': 'Index Scan', 'Total Cost': 30, 'Plan Rows': 10 },
      { 'Node Type': 'Sort', 'Total Cost': 80, 'Plan Rows': 20 },
    ],
  }

  it('shows the empty explain panel hint', async () => {
    await renderConnected()
    fireEvent.click(screen.getAllByText('Explain')[1])
    expect(screen.getByText(/to visualize the execution plan/)).toBeTruthy()
  })

  it('runs EXPLAIN for postgres and renders the plan tree', async () => {
    const query = vi.fn().mockImplementation((_id: string, q: string) =>
      q.startsWith('EXPLAIN')
        ? Promise.resolve({ columns: ['QUERY PLAN'], rows: [{ 'QUERY PLAN': [{ Plan: pgPlan }] }], rowCount: 1, duration: 4 })
        : Promise.resolve(usersResult)
    )
    const { api } = await renderConnected({}, { query })
    fireEvent.change(editor(), { target: { value: 'SELECT * FROM users' } })
    fireEvent.click(screen.getByTitle('Visualize query execution plan'))
    await screen.findByText('Seq Scan')
    expect(api.database.query).toHaveBeenCalledWith(
      'db-1',
      'EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) SELECT * FROM users'
    )
    expect(screen.getByText('on users')).toBeTruthy()
    expect(screen.getByText('cost 100.0')).toBeTruthy()
    expect(screen.getByText('est. 50 rows')).toBeTruthy()
    expect(screen.getByText('width 8')).toBeTruthy()
    expect(screen.getByText('actual 1.23ms')).toBeTruthy()
    expect(screen.getByText('actual 48 rows')).toBeTruthy()
    expect(screen.getByText('Index Scan')).toBeTruthy()
    expect(screen.getByText('Sort')).toBeTruthy()
    // collapse root node hides children
    const rootRow = screen.getByText('Seq Scan').closest('.group') as HTMLElement
    fireEvent.click(rootRow.querySelector('button')!)
    expect(screen.queryByText('Index Scan')).toBeNull()
  })

  it('runs EXPLAIN FORMAT=JSON for mysql sessions', async () => {
    const mysqlPlan = { nodeType: 'table_scan', totalCost: 5, planRows: 3 }
    const query = vi.fn().mockImplementation((_id: string, q: string) =>
      q.startsWith('EXPLAIN')
        ? Promise.resolve({ columns: ['EXPLAIN'], rows: [{ EXPLAIN: JSON.stringify(mysqlPlan) }], rowCount: 1, duration: 2 })
        : Promise.resolve(usersResult)
    )
    const { api } = await renderConnected({ dbType: 'mysql' }, { query })
    expect(screen.getByText(/MySQL ·/)).toBeTruthy()
    fireEvent.change(editor(), { target: { value: 'SELECT 1' } })
    fireEvent.click(screen.getByTitle('Visualize query execution plan'))
    await screen.findByText('table_scan')
    expect(api.database.query).toHaveBeenCalledWith('db-1', 'EXPLAIN FORMAT=JSON SELECT 1')
    expect(screen.getByText('cost 5.0')).toBeTruthy()
  })

  it('toasts when explain fails', async () => {
    const query = vi.fn().mockRejectedValue(new Error('cannot explain'))
    await renderConnected({}, { query })
    fireEvent.change(editor(), { target: { value: 'SELECT 1' } })
    fireEvent.click(screen.getByTitle('Visualize query execution plan'))
    expect(await screen.findByText('Explain failed: cannot explain')).toBeTruthy()
  })
})

describe('DatabaseExplorer — watch mode', () => {
  it('polls the query on an interval, highlights changed and added cells, then clears', async () => {
    let call = 0
    const base = { columns: ['id', 'name'], rowCount: 1, duration: 1 }
    const query = vi.fn().mockImplementation(() => {
      call += 1
      if (call <= 1) return Promise.resolve({ ...base, rows: [{ id: 1, name: 'alice' }] })
      if (call === 2) return Promise.resolve({ ...base, rows: [{ id: 1, name: 'alicia' }] })
      return Promise.resolve({ ...base, rows: [{ id: 1, name: 'alicia' }, { id: 2, name: 'bob' }], rowCount: 2 })
    })
    const { api } = await renderConnected({}, { query })
    await runSql(api, 'SELECT * FROM users')
    await screen.findByText('alice')

    vi.useFakeTimers()
    // pick a 2s interval
    fireEvent.change(screen.getByDisplayValue('5s'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('Watch'))
    expect(screen.getByText('2s')).toBeTruthy()

    // countdown ticks down
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('1s')).toBeTruthy()

    // first tick: changed cell highlighted
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    const changed = screen.getByText('alicia').closest('td') as HTMLElement
    expect(changed.style.background).toContain('245')

    // highlight clears after 3s (next tick at 4s adds a row first)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    // findBy* hangs under fake timers — the advance above already flushed the tick
    const added = screen.getByText('bob').closest('td') as HTMLElement
    expect(added.style.background).toContain('245')

    // stop watching
    fireEvent.click(screen.getByText('Stop'))
    expect(screen.getByText('Watch')).toBeTruthy()
    const callsAfterStop = api.database.query.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(api.database.query.mock.calls).toHaveLength(callsAfterStop)
    expect((screen.getByText('bob').closest('td') as HTMLElement).style.background).not.toContain('245')
  })

  it('stops watching when another query runs, so stale results never replace the grid', async () => {
    const orders = { columns: ['id', 'total'], rows: [{ id: 9, total: 'ninety-nine' }], rowCount: 1, duration: 1 }
    const query = vi.fn().mockImplementation((_id: string, q: string) => Promise.resolve(q.includes('orders') ? orders : usersResult))
    const { api } = await renderConnected({}, { query })
    await runSql(api, 'SELECT * FROM users')
    await screen.findByText('alice')
    vi.useFakeTimers()
    fireEvent.click(screen.getByText('Watch'))
    fireEvent.click(screen.getByText('orders'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('ninety-nine')).toBeTruthy()
    expect(screen.getByText('Watch')).toBeTruthy()
    const calls = api.database.query.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.database.query.mock.calls).toHaveLength(calls)
    expect(screen.queryByText('alice')).toBeNull()
  })

  it('keeps polling silently through query errors and clears timers on unmount', async () => {
    let calls = 0
    const query = vi.fn().mockImplementation(() => {
      calls += 1
      return calls === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(usersResult)
    })
    const { api, unmount } = await renderConnected({}, { query })
    await runSql(api, 'SELECT * FROM users')
    await screen.findByText('alice')

    vi.useFakeTimers()
    fireEvent.click(screen.getByText('Watch'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    // errored tick is silent — results still shown
    expect(screen.getByText('alice')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api.database.query.mock.calls.length).toBeGreaterThanOrEqual(3)
    // unmount while watch is active clears intervals
    unmount()
    const after = api.database.query.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(api.database.query.mock.calls).toHaveLength(after)
  })
})
