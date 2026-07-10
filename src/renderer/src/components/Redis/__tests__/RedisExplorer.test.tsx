// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import RedisExplorer from '../RedisExplorer'
import { installWindowApi, seedStore, makeSession, makeTab } from '../../../__tests__/harness'

const KEY_VALUES: Record<string, { type: string; value: any; ttl: number }> = {
  'user:1': { type: 'string', value: 'hello world', ttl: -1 },
  'user:profile': { type: 'hash', value: { name: 'sean', role: 'admin' }, ttl: 3600 },
  'queue:jobs': { type: 'list', value: ['job-a', 'job-b'], ttl: -1 },
  'scores': { type: 'zset', value: [{ member: 'a', score: 1 }], ttl: -1 },
}

function setup(overrides: Record<string, any> = {}) {
  const session = makeSession({ label: 'Cache', type: 'redis', port: 6379, redisDb: 2 })
  const tab = makeTab({ view: 'redis', sessionId: session.id })
  seedStore({ sessions: [session], tabs: [tab], activeTabId: tab.id })
  const api = installWindowApi({
    redis: {
      connect: vi.fn().mockResolvedValue('redis-1'),
      keys: vi.fn().mockResolvedValue(Object.keys(KEY_VALUES)),
      get: vi.fn().mockImplementation(async (_id: string, key: string) => KEY_VALUES[key]),
      del: vi.fn().mockResolvedValue(undefined),
      command: vi.fn().mockResolvedValue(42),
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  })
  const utils = render(<RedisExplorer tab={tab} />)
  return { session, tab, api, ...utils }
}

describe('RedisExplorer', () => {
  beforeEach(() => {
    seedStore({ sessions: [], tabs: [], activeTabId: null })
  })

  it('connects with stored credentials and lists sorted keys', async () => {
    const { api, session, tab } = setup()
    expect(await screen.findByText('4 keys')).toBeTruthy()
    expect(api.sessions.getCredentials).toHaveBeenCalledWith(tab.sessionId)
    expect(api.redis.connect).toHaveBeenCalledWith({
      host: session.host,
      port: 6379,
      password: 'pw',
      db: 2,
    })
    expect(screen.getByText('Redis · DB 2')).toBeTruthy()
    expect(screen.getByText('Cache')).toBeTruthy()
    expect(screen.getByText('user:1')).toBeTruthy()
    expect(screen.getByText('Select a key to view its value')).toBeTruthy()
  })

  it('selects a string key on click and shows type, TTL and value', async () => {
    const { api } = setup()
    fireEvent.click(await screen.findByText('user:1'))
    expect(await screen.findByText('hello world')).toBeTruthy()
    expect(api.redis.get).toHaveBeenCalledWith('redis-1', 'user:1')
    expect(screen.getByText('string')).toBeTruthy()
    expect(screen.getByText('TTL: No expiry')).toBeTruthy()
    // Close the value pane
    const header = screen.getAllByText('user:1').find(el => el.classList.contains('font-medium'))!
    fireEvent.click(header.closest('div')!.parentElement!.querySelector('button:last-of-type') as HTMLElement)
    expect(await screen.findByText('Select a key to view its value')).toBeTruthy()
  })

  it('selects hash and list keys through the key row buttons', async () => {
    const { api } = setup()
    const row = (await screen.findByText('user:profile')).closest('button') as HTMLElement
    fireEvent.click(row)
    expect(await screen.findByText('sean')).toBeTruthy()
    expect(screen.getByText('TTL: 3600s')).toBeTruthy()
    expect(screen.getByText('name')).toBeTruthy()

    const listRow = screen.getByText('queue:jobs').closest('button') as HTMLElement
    fireEvent.click(listRow)
    expect(await screen.findByText('job-a')).toBeTruthy()
    expect(screen.getByText('job-b')).toBeTruthy()
    expect(api.redis.get).toHaveBeenCalledTimes(2)
  })

  it('renders unknown types as JSON', async () => {
    setup()
    fireEvent.click(await screen.findByText('scores'))
    expect(await screen.findByText('zset')).toBeTruthy()
    expect(screen.getByText(/"member": "a"/)).toBeTruthy()
  })

  it('deletes a key and clears the value pane if it was selected', async () => {
    const { api } = setup()
    fireEvent.click(await screen.findByText('user:1'))
    await screen.findByText('hello world')
    // The key button and its sibling delete button live in the same row container
    const keyButton = screen.getAllByText('user:1')[0].closest('button') as HTMLElement
    fireEvent.click(keyButton.nextElementSibling as HTMLElement)
    await waitFor(() => expect(api.redis.del).toHaveBeenCalledWith('redis-1', 'user:1'))
    expect(screen.queryByText('hello world')).toBeNull()
    expect(await screen.findByText('3 keys')).toBeTruthy()
  })

  it('re-queries keys with the search pattern on Enter', async () => {
    const { api } = setup()
    const input = await screen.findByPlaceholderText('Pattern (e.g. user:*)')
    api.redis.keys.mockResolvedValueOnce(['user:1', 'user:profile'])
    fireEvent.change(input, { target: { value: 'user:*' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.redis.keys).toHaveBeenLastCalledWith('redis-1', 'user:*'))
    expect(await screen.findByText('2 keys')).toBeTruthy()
    expect(screen.queryByText('queue:jobs')).toBeNull()
  })

  it('runs CLI commands and records results and errors', async () => {
    const { api } = setup()
    await screen.findByText('4 keys')
    fireEvent.click(screen.getByText('CLI'))
    expect(screen.getByText(/Type a Redis command below/)).toBeTruthy()

    const input = screen.getByPlaceholderText('Enter command…')
    fireEvent.change(input, { target: { value: 'DBSIZE' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('DBSIZE')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
    expect(api.redis.command).toHaveBeenCalledWith('redis-1', 'DBSIZE')

    api.redis.command.mockRejectedValueOnce(new Error('unknown command'))
    fireEvent.change(input, { target: { value: 'BOGUS' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('ERR: unknown command')).toBeTruthy()

    // Back to the browser tab
    fireEvent.click(screen.getByText('Key Browser'))
    expect(screen.getByText('user:1')).toBeTruthy()
  })

  it('renders the retry screen when the initial connection fails, then recovers', async () => {
    const session = makeSession({ label: 'Broken', type: 'redis' })
    const tab = makeTab({ view: 'redis', sessionId: session.id })
    seedStore({ sessions: [session], tabs: [tab], activeTabId: tab.id })
    const api = installWindowApi({
      redis: {
        connect: vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue('redis-2'),
        keys: vi.fn().mockResolvedValue(['a']),
        get: vi.fn().mockResolvedValue({ type: 'string', value: 'x', ttl: -1 }),
      },
    })
    render(<RedisExplorer tab={tab} />)
    expect(await screen.findByText('ECONNREFUSED')).toBeTruthy()
    fireEvent.click(screen.getByText('Retry'))
    expect(await screen.findByText('1 keys')).toBeTruthy()
    expect(api.redis.connect).toHaveBeenCalledTimes(2)
  })

  it('maps locked-keychain credential errors to a friendly message', async () => {
    const session = makeSession({ type: 'redis' })
    const tab = makeTab({ view: 'redis', sessionId: session.id })
    seedStore({ sessions: [session], tabs: [tab], activeTabId: tab.id })
    installWindowApi({
      sessions: {
        getCredentials: vi.fn().mockRejectedValue(new Error('credential store is locked')),
      },
    })
    render(<RedisExplorer tab={tab} />)
    expect(await screen.findByText('App is locked — unlock noxed to reconnect')).toBeTruthy()
  })

  it('disconnects the client on unmount', async () => {
    const { api, unmount } = setup()
    await screen.findByText('4 keys')
    unmount()
    await waitFor(() => expect(api.redis.disconnect).toHaveBeenCalledWith('redis-1'))
  })
})
