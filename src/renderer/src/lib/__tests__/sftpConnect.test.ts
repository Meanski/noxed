// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { connectSftp } from '../sftpConnect'
import { installWindowApi, makeSession } from '../../__tests__/harness'
import type { WindowApiMock } from '../../__tests__/harness'

describe('connectSftp', () => {
  let api: WindowApiMock

  beforeEach(() => {
    api = installWindowApi()
  })

  it('piggybacks on a live stream without any credential lookup', async () => {
    const session = makeSession({ jumpHostId: 'jump-1' })
    const id = await connectSftp(session, 'stream-9')
    expect(id).toBe('sftp-1')
    expect(api.sessions.getCredentials).not.toHaveBeenCalled()
    expect(api.fs.readFile).not.toHaveBeenCalled()
    expect(api.sftp.connect).toHaveBeenCalledWith({
      host: session.host,
      port: session.port,
      username: session.username,
      password: undefined,
      privateKey: undefined,
      streamId: 'stream-9',
      jumpHostId: 'jump-1',
    })
  })

  it('looks up the stored password for password auth', async () => {
    const session = makeSession({ authType: 'password' })
    await connectSftp(session)
    expect(api.sessions.getCredentials).toHaveBeenCalledWith(session.id)
    expect(api.sftp.connect).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'pw', privateKey: undefined, streamId: undefined })
    )
  })

  it('continues without a password when the credential lookup fails benignly', async () => {
    api.sessions.getCredentials.mockRejectedValue(new Error('no keychain entry'))
    await connectSftp(makeSession({ authType: 'password' }))
    expect(api.sftp.connect).toHaveBeenCalledWith(
      expect.objectContaining({ password: undefined })
    )
  })

  it('surfaces a friendly error when the app is locked', async () => {
    api.sessions.getCredentials.mockRejectedValue(new Error('credential store is locked'))
    await expect(connectSftp(makeSession({ authType: 'password' }))).rejects.toThrow(
      'App is locked — unlock noxed to reconnect'
    )
    expect(api.sftp.connect).not.toHaveBeenCalled()
  })

  it('rejects key auth when no key path is configured', async () => {
    await expect(connectSftp(makeSession({ authType: 'key' }))).rejects.toThrow(
      'Key authentication selected but no key file path is configured'
    )
    expect(api.sftp.connect).not.toHaveBeenCalled()
  })

  it('reads the private key from disk for key auth', async () => {
    api.fs.readFile.mockResolvedValue('PRIVATE KEY DATA')
    const session = makeSession({ authType: 'key', keyPath: '/home/user/.ssh/id_ed25519' })
    await connectSftp(session)
    expect(api.fs.readFile).toHaveBeenCalledWith('/home/user/.ssh/id_ed25519')
    expect(api.sessions.getCredentials).not.toHaveBeenCalled()
    expect(api.sftp.connect).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: 'PRIVATE KEY DATA', password: undefined })
    )
  })

  it('rejects when the key file cannot be read', async () => {
    api.fs.readFile.mockRejectedValue(new Error('ENOENT'))
    const session = makeSession({ authType: 'key', keyPath: '/missing/key' })
    await expect(connectSftp(session)).rejects.toThrow('Cannot read private key: /missing/key')
    expect(api.sftp.connect).not.toHaveBeenCalled()
  })

  it('rejects when the key file reads back empty', async () => {
    api.fs.readFile.mockResolvedValue('')
    const session = makeSession({ authType: 'key', keyPath: '/empty/key' })
    await expect(connectSftp(session)).rejects.toThrow('Cannot read private key: /empty/key')
  })
})
