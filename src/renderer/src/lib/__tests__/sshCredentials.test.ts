// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { resolveSshCredentials, setAdhocPassword, clearAdhocPassword } from '../sshCredentials'
import { installWindowApi, makeSession } from '../../__tests__/harness'

beforeEach(() => clearAdhocPassword('adhoc-1'))

describe('resolveSshCredentials', () => {
  it('reads the private key for key sessions', async () => {
    const api = installWindowApi()
    api.fs.readFile.mockResolvedValueOnce('KEY')
    expect(await resolveSshCredentials(makeSession({ authType: 'key', keyPath: '~/.ssh/id' }))).toEqual({ privateKey: 'KEY' })
    expect(api.fs.readFile).toHaveBeenCalledWith('~/.ssh/id')
  })

  it('explains a missing or unreadable key', async () => {
    const api = installWindowApi()
    await expect(resolveSshCredentials(makeSession({ authType: 'key', keyPath: undefined }))).rejects.toThrow('no key file path')
    api.fs.readFile.mockRejectedValueOnce(new Error('denied'))
    await expect(resolveSshCredentials(makeSession({ authType: 'key', keyPath: '/k' }))).rejects.toThrow('Cannot read private key: /k')
  })

  it('uses the in-memory password for quick-connect sessions, never the keychain', async () => {
    const api = installWindowApi()
    const session = makeSession({ id: 'adhoc-1', adhoc: true })
    expect(await resolveSshCredentials(session)).toEqual({ password: undefined })
    setAdhocPassword('adhoc-1', 'pw')
    expect(await resolveSshCredentials(session, { requirePassword: true })).toEqual({ password: 'pw' })
    expect(api.sessions.getCredentials).not.toHaveBeenCalled()
  })

  it('hands agent sessions nothing, so main uses the agent and default keys', async () => {
    const api = installWindowApi()
    expect(await resolveSshCredentials(makeSession({ authType: 'agent' }), { requirePassword: true })).toEqual({})
    expect(api.sessions.getCredentials).not.toHaveBeenCalled()
  })

  it('reads saved passwords from the keychain', async () => {
    installWindowApi()
    expect(await resolveSshCredentials(makeSession())).toEqual({ password: 'pw' })
  })

  it('requires a stored password only when asked to', async () => {
    const api = installWindowApi()
    api.sessions.getCredentials.mockResolvedValue({})
    expect(await resolveSshCredentials(makeSession())).toEqual({ password: undefined })
    await expect(resolveSshCredentials(makeSession(), { requirePassword: true })).rejects.toThrow('No password found')
  })

  it('maps keychain failures to clear errors', async () => {
    const api = installWindowApi()
    api.sessions.getCredentials.mockRejectedValueOnce(new Error('App is locked'))
    await expect(resolveSshCredentials(makeSession())).rejects.toThrow('App is locked — unlock noxed to reconnect')
    api.sessions.getCredentials.mockRejectedValueOnce(new Error('keychain broke'))
    await expect(resolveSshCredentials(makeSession(), { requirePassword: true })).rejects.toThrow('keychain broke')
    api.sessions.getCredentials.mockRejectedValueOnce(new Error('keychain broke'))
    expect(await resolveSshCredentials(makeSession())).toEqual({ password: undefined })
  })
})
