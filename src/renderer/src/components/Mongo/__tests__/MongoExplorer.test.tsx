// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import MongoExplorer from '../MongoExplorer'
import { installWindowApi, seedStore, makeSession, makeTab, type WindowApiMock } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

let api: WindowApiMock
const order = (n: number) => JSON.stringify({ _id: { $oid: `65a00000000000000000000${n}` }, qty: n })

function setup() {
  api = installWindowApi()
  api.mongo.find.mockResolvedValue({ documents: [order(1), order(2)], total: 3 })
  const session = makeSession({ id: 'm1', type: 'database', dbType: 'mongodb', host: 'db.lan', port: 27017, username: 'app', authType: 'password', authSource: 'admin', sslMode: 'require' })
  const tab = makeTab({ id: 't1', sessionId: 'm1', view: 'mongo', status: 'idle' })
  seedStore({ sessions: [session], tabs: [tab], activeTabId: 't1', notifications: [] })
  return render(<MongoExplorer tab={tab} />)
}

async function openOrders() {
  fireEvent.click(await screen.findByText('shop'))
  fireEvent.click(await screen.findByText('orders'))
  await screen.findByText(/"qty": 1/)
}

beforeEach(() => cleanup())

describe('MongoExplorer', () => {
  it('connects with the saved settings and lists databases', async () => {
    setup()
    expect(await screen.findByText('shop')).toBeTruthy()
    expect(api.mongo.connect).toHaveBeenCalledWith({ host: 'db.lan', port: 27017, username: 'app', password: 'pw', authSource: 'admin', srv: false, tls: true })
    expect(useAppStore.getState().tabs[0].status).toBe('connected')
  })

  it('browses a collection with a filter, sort and pages', async () => {
    setup()
    await openOrders()
    expect(api.mongo.find).toHaveBeenLastCalledWith('mongo-1', 'shop', 'orders', { filter: '{}', sort: '{}', limit: 50, skip: 0 })
    expect(screen.getByText('1–2 of 3')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: '{"qty": {"$gt": 1}}' } })
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: '{"qty": -1}' } })
    fireEvent.change(screen.getByLabelText('Page size'), { target: { value: '20' } })
    fireEvent.click(screen.getByText('Find'))
    await waitFor(() => expect(api.mongo.find).toHaveBeenLastCalledWith('mongo-1', 'shop', 'orders', { filter: '{"qty": {"$gt": 1}}', sort: '{"qty": -1}', limit: 20, skip: 0 }))
    fireEvent.click(screen.getByLabelText('Next page'))
    await waitFor(() => expect(api.mongo.find).toHaveBeenLastCalledWith('mongo-1', 'shop', 'orders', expect.objectContaining({ skip: 20 })))
    fireEvent.click(screen.getByLabelText('Previous page'))
    await waitFor(() => expect(api.mongo.find).toHaveBeenLastCalledWith('mongo-1', 'shop', 'orders', expect.objectContaining({ skip: 0 })))
  })

  it('inserts and edits documents as JSON', async () => {
    setup()
    await openOrders()
    fireEvent.click(screen.getByText('Insert'))
    fireEvent.change(screen.getByLabelText('Document JSON'), { target: { value: '{ nope' } })
    fireEvent.click(screen.getByText('Save'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not valid JSON/)
    fireEvent.change(screen.getByLabelText('Document JSON'), { target: { value: '{"qty": 9}' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.mongo.insert).toHaveBeenCalledWith('mongo-1', 'shop', 'orders', '{"qty": 9}'))
    fireEvent.click(screen.getAllByLabelText('Edit document')[0])
    expect((screen.getByLabelText('Document JSON') as HTMLTextAreaElement).value).toContain('"qty": 1')
    fireEvent.change(screen.getByLabelText('Document JSON'), { target: { value: '{"qty": 10}' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.mongo.replace).toHaveBeenCalledWith('mongo-1', 'shop', 'orders', '{"_id":{"$oid":"65a000000000000000000001"}}', '{"qty": 10}'))
  })

  it('keeps the editor open when saving fails', async () => {
    setup()
    await openOrders()
    api.mongo.insert.mockRejectedValueOnce(new Error('E11000 duplicate key'))
    fireEvent.click(screen.getByText('Insert'))
    fireEvent.change(screen.getByLabelText('Document JSON'), { target: { value: '{}' } })
    fireEvent.click(screen.getByText('Save'))
    expect((await screen.findByRole('alert')).textContent).toBe('E11000 duplicate key')
  })

  it('deletes after confirming, and reports a failed delete', async () => {
    setup()
    await openOrders()
    fireEvent.click(screen.getAllByLabelText('Delete document')[1])
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.mongo.delete).toHaveBeenCalledWith('mongo-1', 'shop', 'orders', '{"_id":{"$oid":"65a000000000000000000002"}}'))
    api.mongo.delete.mockRejectedValueOnce(new Error('not authorized'))
    fireEvent.click(screen.getAllByLabelText('Delete document')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(useAppStore.getState().notifications.map((n) => n.message)).toContain('not authorized'))
  })

  it('shows query errors and empty results', async () => {
    setup()
    await openOrders()
    api.mongo.find.mockRejectedValueOnce(new Error('Filter is not valid JSON'))
    fireEvent.click(screen.getByText('Find'))
    expect((await screen.findByRole('alert')).textContent).toBe('Filter is not valid JSON')
    api.mongo.find.mockResolvedValueOnce({ documents: [], total: 0 })
    fireEvent.click(screen.getByText('Find'))
    expect(await screen.findByText('No documents match.')).toBeTruthy()
  })

  it('offers a retry when it cannot connect, and lists collection errors', async () => {
    setup()
    await screen.findByText('shop')
    api.mongo.collections.mockRejectedValueOnce(new Error('not authorized on shop'))
    fireEvent.click(screen.getByText('shop'))
    expect((await screen.findByRole('alert')).textContent).toBe('not authorized on shop')
    cleanup()
    api = installWindowApi()
    api.mongo.connect.mockRejectedValueOnce(new Error('Could not connect to MongoDB: timeout'))
    const tab = makeTab({ id: 't1', sessionId: 'm1', view: 'mongo', status: 'idle' })
    seedStore({ sessions: [makeSession({ id: 'm1', type: 'database', dbType: 'mongodb', authType: 'password' })], tabs: [tab], activeTabId: 't1' })
    render(<MongoExplorer tab={tab} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Could not connect to MongoDB: timeout')
    fireEvent.click(screen.getByText('Retry'))
    expect(await screen.findByText('shop')).toBeTruthy()
  })

  it('closes a connection that finishes after the tab closed', async () => {
    let finish: (id: string) => void = () => undefined
    api = installWindowApi()
    api.mongo.connect.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve }))
    const tab = makeTab({ id: 't1', sessionId: 'm1', view: 'mongo', status: 'idle' })
    seedStore({ sessions: [makeSession({ id: 'm1', type: 'database', dbType: 'mongodb', authType: 'password' })], tabs: [tab], activeTabId: 't1' })
    const { unmount } = render(<MongoExplorer tab={tab} />)
    await waitFor(() => expect(api.mongo.connect).toHaveBeenCalled())
    unmount()
    finish('late-client')
    await waitFor(() => expect(api.mongo.disconnect).toHaveBeenCalledWith('late-client'))
    expect(api.mongo.databases).not.toHaveBeenCalled()
  })

  it('shows only the latest query when collections are switched quickly', async () => {
    setup()
    api.mongo.collections.mockResolvedValueOnce(['orders', 'users'])
    fireEvent.click(await screen.findByText('shop'))
    await screen.findByText('users')
    let finishSlow: (r: { documents: string[]; total: number }) => void = () => undefined
    api.mongo.find
      .mockReturnValueOnce(new Promise((resolve) => { finishSlow = resolve }))
      .mockResolvedValueOnce({ documents: [order(2)], total: 1 })
    fireEvent.click(screen.getByText('orders'))
    fireEvent.click(screen.getByText('users'))
    await screen.findByText(/"qty": 2/)
    finishSlow({ documents: [order(1)], total: 1 })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText(/"qty": 1/)).toBeNull()
  })
})
