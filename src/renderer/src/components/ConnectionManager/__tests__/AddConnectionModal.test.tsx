// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import AddConnectionModal from '../AddConnectionModal'
import { installWindowApi, makeSession, type WindowApiMock } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

const initialState = useAppStore.getState()

let api: WindowApiMock
let onClose: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  useAppStore.setState(initialState, true)
  api = installWindowApi()
  onClose = vi.fn<() => void>()
})

function renderModal() {
  return render(<AddConnectionModal onClose={onClose} />)
}

/** Pick a connection type on step 1 and advance to the config step. */
function goToConfig(typeLabel: string) {
  fireEvent.click(screen.getByText(typeLabel))
  fireEvent.click(screen.getByText('Next'))
}

function saveButton() {
  return screen.getByText('Save Connection')
}

describe('AddConnectionModal — type step', () => {
  it('renders all connection types including RDP on darwin', () => {
    renderModal()
    expect(screen.getByText('Add New Connection')).toBeTruthy()
    for (const label of ['SSH Server', 'SFTP Server', 'Database', 'Kubernetes', 'Redis', 'Remote Desktop']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('closes via Cancel, Escape and backdrop click', () => {
    const { unmount } = renderModal()
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()

    renderModal()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('navigates to config step and back', () => {
    renderModal()
    goToConfig('SSH Server')
    expect(screen.getByText('Step 2 — Enter connection details')).toBeTruthy()
    fireEvent.click(screen.getByText('Back'))
    expect(screen.getByText('Choose a connection type to get started')).toBeTruthy()
  })
})

describe('AddConnectionModal — SSH', () => {
  it('validates host, port, username and key path', async () => {
    renderModal()
    goToConfig('SSH Server')

    fireEvent.click(saveButton())
    expect(await screen.findByText('Host is required')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: '10.0.0.1' } })
    fireEvent.change(screen.getByPlaceholderText('22'), { target: { value: '99999' } })
    fireEvent.click(saveButton())
    expect(await screen.findByText('Port must be between 1 and 65535')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('22'), { target: { value: '22' } })
    fireEvent.click(saveButton())
    expect(await screen.findByText('Username is required')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'admin' } })
    fireEvent.click(screen.getByText('Private Key'))
    fireEvent.click(saveButton())
    expect(await screen.findByText('Private key path is required')).toBeTruthy()
    expect(api.sessions.create).not.toHaveBeenCalled()

    // Switching back to password auth clears the key requirement
    fireEvent.click(screen.getByText('Password'))
    expect(screen.getByPlaceholderText('Enter password')).toBeTruthy()
  })

  it('saves a password-auth connection with tags, group and jump host', async () => {
    useAppStore.setState({
      sessions: [makeSession({ id: 'jump-1', label: 'Bastion', type: 'ssh', group: 'Homelab' })],
    })
    renderModal()
    goToConfig('SSH Server')

    fireEvent.change(screen.getByPlaceholderText('e.g. web-server-01'), { target: { value: 'web-01' } })
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: '10.0.0.5' } })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'deploy' } })
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'secret' } })
    fireEvent.change(screen.getByPlaceholderText('production, web'), { target: { value: 'production, web, ' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. Homelab'), { target: { value: 'Homelab' } })

    // Jump host dropdown is rendered because another SSH session exists
    const jumpSelect = screen.getByDisplayValue('None — connect directly')
    fireEvent.change(jumpSelect, { target: { value: 'jump-1' } })

    fireEvent.click(saveButton())
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalledTimes(1))
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ssh',
      label: 'web-01',
      host: '10.0.0.5',
      port: 22,
      username: 'deploy',
      authType: 'password',
      password: 'secret',
      jumpHostId: 'jump-1',
      group: 'Homelab',
      tags: ['production', 'web'],
      pollingEnabled: false,
      connectOnStart: false,
    }))
    expect(onClose).toHaveBeenCalled()
    expect(useAppStore.getState().sessions.some(s => s.id === 's1')).toBe(true)
  })

  it('saves a key-auth connection and shows Saving… while pending', async () => {
    let resolveCreate!: (v: { id: string }) => void
    api.sessions.create.mockReturnValue(new Promise(res => { resolveCreate = res }))
    renderModal()
    goToConfig('SSH Server')

    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: 'srv' } })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'root' } })
    fireEvent.click(screen.getByText('Private Key'))
    fireEvent.change(screen.getByPlaceholderText('~/.ssh/id_ed25519'), { target: { value: '~/.ssh/key' } })

    fireEvent.click(saveButton())
    expect(await screen.findByText('Saving…')).toBeTruthy()
    resolveCreate({ id: 's1' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      authType: 'key',
      keyPath: '~/.ssh/key',
      password: undefined,
    }))
  })

  it('shows the save error when creation fails', async () => {
    api.sessions.create.mockRejectedValue(new Error('keychain locked'))
    renderModal()
    goToConfig('SSH Server')
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: 'srv' } })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'root' } })
    fireEvent.click(saveButton())
    expect(await screen.findByText('keychain locked')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('toggles the password visibility with the eye button', () => {
    renderModal()
    goToConfig('SSH Server')
    const input = screen.getByPlaceholderText('Enter password') as HTMLInputElement
    expect(input.type).toBe('password')
    const eyeButton = input.closest('.relative')!.querySelector('button')!
    fireEvent.mouseEnter(eyeButton)
    fireEvent.mouseLeave(eyeButton)
    fireEvent.click(eyeButton)
    expect((screen.getByPlaceholderText('Enter password') as HTMLInputElement).type).toBe('text')
    fireEvent.click(eyeButton)
    expect((screen.getByPlaceholderText('Enter password') as HTMLInputElement).type).toBe('password')
  })

  it('toggles polling and connect-on-start via the toggle buttons', async () => {
    renderModal()
    goToConfig('SSH Server')
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: 'srv' } })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'root' } })

    const toggleFor = (label: string) =>
      screen.getByText(label).parentElement!.parentElement!.querySelector('button')!
    expect(toggleFor('Enable Dashboard Polling').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggleFor('Enable Dashboard Polling'))
    expect(toggleFor('Enable Dashboard Polling').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggleFor('Connect on App Start'))
    // Toggle polling back off, then re-enable it
    fireEvent.click(toggleFor('Enable Dashboard Polling'))
    fireEvent.click(toggleFor('Enable Dashboard Polling'))

    fireEvent.click(saveButton())
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      pollingEnabled: true,
      connectOnStart: true,
      pollingIntervalSeconds: 60,
    }))
  })

  it('runs Test Connection through ssh connect/disconnect and reports success', async () => {
    renderModal()
    goToConfig('SSH Server')
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: 'srv' } })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'root' } })
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'pw' } })

    fireEvent.click(screen.getByText('Test Connection'))
    expect(await screen.findByText('Connection successful!')).toBeTruthy()
    expect(api.ssh.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: 'srv', port: 22, username: 'root', password: 'pw',
    }))
    expect(api.ssh.disconnect).toHaveBeenCalledWith('stream-1')
  })

  it('reports a test failure when the key file cannot be read', async () => {
    api.fs.readFile.mockRejectedValue(new Error('ENOENT'))
    renderModal()
    goToConfig('SSH Server')
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: 'srv' } })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'root' } })
    fireEvent.click(screen.getByText('Private Key'))
    fireEvent.change(screen.getByPlaceholderText('~/.ssh/id_ed25519'), { target: { value: '/nope/key' } })

    fireEvent.click(screen.getByText('Test Connection'))
    expect(await screen.findByText('Cannot read private key: /nope/key')).toBeTruthy()
    expect(screen.getByText('Connection failed. Check your credentials.')).toBeTruthy()
    expect(api.ssh.connect).not.toHaveBeenCalled()
  })

  it('surfaces the validation error instead of testing an invalid form', async () => {
    renderModal()
    goToConfig('SSH Server')
    fireEvent.click(screen.getByText('Test Connection'))
    expect(await screen.findByText('Host is required')).toBeTruthy()
    expect(api.ssh.connect).not.toHaveBeenCalled()
  })
})

describe('AddConnectionModal — SFTP', () => {
  it('tests connectivity through the sftp bridge', async () => {
    renderModal()
    goToConfig('SFTP Server')
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: 'files.example.com' } })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'ftp' } })
    fireEvent.click(screen.getByText('Test Connection'))
    expect(await screen.findByText('Connection successful!')).toBeTruthy()
    expect(api.sftp.connect).toHaveBeenCalled()
    expect(api.sftp.disconnect).toHaveBeenCalledWith('sftp-1')
  })
})

describe('AddConnectionModal — Database', () => {
  it('validates database-specific fields', async () => {
    renderModal()
    goToConfig('Database')
    fireEvent.change(screen.getByPlaceholderText('192.168.1.30'), { target: { value: 'db-host' } })
    fireEvent.click(saveButton())
    expect(await screen.findByText('Username is required')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('postgres'), { target: { value: 'app' } })
    fireEvent.click(saveButton())
    expect(await screen.findByText('Database name is required')).toBeTruthy()
  })

  it('saves a mysql connection with ssl mode', async () => {
    renderModal()
    goToConfig('Database')
    // Selecting the Database type reset the port to the postgres default
    expect((screen.getByPlaceholderText('22') as HTMLInputElement).value).toBe('5432')

    fireEvent.change(screen.getByDisplayValue('PostgreSQL'), { target: { value: 'mysql' } })
    fireEvent.change(screen.getByDisplayValue('Disable'), { target: { value: 'require' } })
    fireEvent.change(screen.getByPlaceholderText('192.168.1.30'), { target: { value: 'db-host' } })
    fireEvent.change(screen.getByPlaceholderText('mydb'), { target: { value: 'appdb' } })
    fireEvent.change(screen.getByPlaceholderText('postgres'), { target: { value: 'app' } })
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'dbpw' } })

    fireEvent.click(saveButton())
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'database',
      dbType: 'mysql',
      databaseName: 'appdb',
      sslMode: 'require',
      username: 'app',
      password: 'dbpw',
    }))
  })

  it('tests connectivity through the database bridge', async () => {
    renderModal()
    goToConfig('Database')
    fireEvent.change(screen.getByPlaceholderText('192.168.1.30'), { target: { value: 'db-host' } })
    fireEvent.change(screen.getByPlaceholderText('mydb'), { target: { value: 'appdb' } })
    fireEvent.change(screen.getByPlaceholderText('postgres'), { target: { value: 'app' } })
    fireEvent.click(screen.getByText('Test Connection'))
    expect(await screen.findByText('Connection successful!')).toBeTruthy()
    expect(api.database.connect).toHaveBeenCalledWith(expect.objectContaining({
      dbType: 'postgresql', host: 'db-host', database: 'appdb', username: 'app',
    }))
    expect(api.database.disconnect).toHaveBeenCalledWith('db-1')
  })
})

describe('AddConnectionModal — Redis', () => {
  it('rejects an out-of-range db index and saves a valid one', async () => {
    renderModal()
    goToConfig('Redis')
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: 'cache' } })
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '42' } })
    fireEvent.click(saveButton())
    expect(await screen.findByText('DB index must be 0–15')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '3' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'redis', host: 'cache', port: 6379, redisDb: 3,
    }))
  })

  it('tests connectivity through the redis bridge and surfaces failures', async () => {
    api.redis.connect.mockRejectedValue(new Error("Error invoking remote method 'redis:connect': Error: NOAUTH"))
    renderModal()
    goToConfig('Redis')
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: 'cache' } })
    fireEvent.click(screen.getByText('Test Connection'))
    expect(await screen.findByText('NOAUTH')).toBeTruthy()
    expect(api.redis.connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'cache', port: 6379, db: 0 }))
  })
})

describe('AddConnectionModal — RDP', () => {
  it('requires a username, hides Test Connection and saves', async () => {
    renderModal()
    goToConfig('Remote Desktop')
    expect(screen.queryByText('Test Connection')).toBeNull()
    expect((screen.getByPlaceholderText('22') as HTMLInputElement).value).toBe('3389')

    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: 'win-box' } })
    fireEvent.click(saveButton())
    expect(await screen.findByText('Username is required')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(/Administrator/), { target: { value: 'Administrator' } })
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'winpw' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'rdp', host: 'win-box', port: 3389, username: 'Administrator', password: 'winpw',
    }))
  })
})

describe('AddConnectionModal — Kubernetes', () => {
  const ctx = { name: 'prod-cluster', server: 'https://1.2.3.4:6443' }

  it('shows the loading state while contexts are read', async () => {
    api.k8s.contextsDetailed.mockReturnValue(new Promise(() => {}))
    renderModal()
    goToConfig('Kubernetes')
    expect(await screen.findByText('Reading kubeconfig…')).toBeTruthy()
  })

  it('shows the empty state and highlights the drop zone on drag-over', async () => {
    renderModal()
    goToConfig('Kubernetes')
    expect(await screen.findByText('No contexts found')).toBeTruthy()

    const zone = screen.getByText('Select a context').closest('.px-6')!
    fireEvent.dragOver(zone)
    expect(await screen.findByText('Drop to import')).toBeTruthy()
  })

  it('requires a selected context before saving', async () => {
    renderModal()
    goToConfig('Kubernetes')
    fireEvent.click(saveButton())
    expect(await screen.findByText('Select a context to continue')).toBeTruthy()
    expect(api.sessions.create).not.toHaveBeenCalled()
  })

  it('lists default contexts, selects one and saves the connection', async () => {
    api.k8s.contextsDetailed.mockResolvedValue([ctx])
    renderModal()
    goToConfig('Kubernetes')

    expect(await screen.findByText('Default (~/.kube/config)')).toBeTruthy()
    fireEvent.click(await screen.findByText('prod-cluster'))
    // Selecting reveals the display-name and color pickers
    const nameInput = await screen.findByPlaceholderText('prod-cluster')
    fireEvent.change(nameInput, { target: { value: 'Prod' } })

    fireEvent.click(saveButton())
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'kubernetes',
      label: 'Prod',
      host: 'https://1.2.3.4:6443',
      contextName: 'prod-cluster',
      kubeconfigPath: undefined,
    }))
  })

  it('imports a kubeconfig file via the picker and groups its contexts', async () => {
    api.k8s.showFilePicker.mockResolvedValue('/Users/me/Downloads/kc.yaml')
    api.k8s.importKubeconfig.mockResolvedValue({
      path: '/managed/kc.yaml',
      contexts: [{ name: 'staging-ctx', server: 'https://9.9.9.9' }],
    })
    renderModal()
    goToConfig('Kubernetes')
    await screen.findByText('No contexts found')

    fireEvent.click(screen.getByText('Import file'))
    expect(await screen.findByText('staging-ctx')).toBeTruthy()
    expect(screen.getByText('kc.yaml')).toBeTruthy()
    expect(api.k8s.importKubeconfig).toHaveBeenCalledWith('/Users/me/Downloads/kc.yaml')

    // Selecting an imported context persists its kubeconfig path
    fireEvent.click(screen.getByText('staging-ctx'))
    fireEvent.click(saveButton())
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      contextName: 'staging-ctx',
      kubeconfigPath: '/managed/kc.yaml',
    }))
  })

  it('imports a dropped kubeconfig file and reports import failures', async () => {
    api.k8s.importKubeconfig.mockRejectedValue(new Error('not a kubeconfig'))
    renderModal()
    goToConfig('Kubernetes')
    await screen.findByText('No contexts found')

    const zone = screen.getByText('Select a context').closest('.px-6')!
    fireEvent.drop(zone, { dataTransfer: { files: [{ path: '/tmp/kc.yaml' }] } })
    expect(await screen.findByText('not a kubeconfig')).toBeTruthy()
    expect(api.k8s.importKubeconfig).toHaveBeenCalledWith('/tmp/kc.yaml')
  })

  it('refreshes default contexts on demand', async () => {
    renderModal()
    goToConfig('Kubernetes')
    await screen.findByText('No contexts found')
    api.k8s.contextsDetailed.mockResolvedValue([ctx])
    fireEvent.click(screen.getByTitle('Refresh'))
    expect(await screen.findByText('prod-cluster')).toBeTruthy()
    expect(api.k8s.contextsDetailed).toHaveBeenCalledTimes(2)
  })
})

describe('AddConnectionModal — editing', () => {
  const existing = makeSession({
    id: 'edit-1',
    label: 'Old Server',
    host: 'old.example.com',
    port: 2222,
    username: 'olduser',
    authType: 'password',
    type: 'ssh',
    hasPassword: true,
    tags: ['legacy'],
  })

  beforeEach(() => {
    useAppStore.setState({ sessions: [existing], editingConnectionId: 'edit-1' })
  })

  it('opens directly on the config step with prefilled values and stored-password placeholder', () => {
    renderModal()
    expect(screen.getByText('Edit Connection')).toBeTruthy()
    expect((screen.getByPlaceholderText('e.g. web-server-01') as HTMLInputElement).value).toBe('Old Server')
    expect((screen.getByPlaceholderText('192.168.1.10') as HTMLInputElement).value).toBe('old.example.com')
    expect(screen.getByPlaceholderText(/leave blank to keep/)).toBeTruthy()
    expect(screen.getByText('Save Changes')).toBeTruthy()
  })

  it('tests with the stored credential when the password was not retyped', async () => {
    renderModal()
    fireEvent.click(screen.getByText('Test Connection'))
    expect(await screen.findByText('Connection successful!')).toBeTruthy()
    expect(api.sessions.getCredentials).toHaveBeenCalledWith('edit-1')
    expect(api.ssh.connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw' }))
  })

  it('updates the session without resending an untouched password', async () => {
    api.sessions.update.mockResolvedValue({ ...existing, label: 'Renamed' })
    renderModal()
    fireEvent.change(screen.getByPlaceholderText('e.g. web-server-01'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByText('Save Changes'))
    await waitFor(() => expect(api.sessions.update).toHaveBeenCalledTimes(1))
    const [id, data] = api.sessions.update.mock.calls[0]
    expect(id).toBe('edit-1')
    expect(data).toEqual(expect.objectContaining({ label: 'Renamed', host: 'old.example.com', port: 2222 }))
    expect(data.password).toBeUndefined()
    expect(onClose).toHaveBeenCalled()
    expect(useAppStore.getState().editingConnectionId).toBeNull()
    expect(useAppStore.getState().sessions[0].label).toBe('Renamed')
  })

  it('sends a retyped password on save', async () => {
    api.sessions.update.mockResolvedValue({ ...existing })
    renderModal()
    fireEvent.change(screen.getByPlaceholderText(/leave blank to keep/), { target: { value: 'newpw' } })
    fireEvent.click(screen.getByText('Save Changes'))
    await waitFor(() => expect(api.sessions.update).toHaveBeenCalled())
    expect(api.sessions.update.mock.calls[0][1]).toEqual(expect.objectContaining({ password: 'newpw' }))
  })
})

describe('AddConnectionModal — color picker', () => {
  it('marks the picked color as selected in the save payload', async () => {
    renderModal()
    goToConfig('SSH Server')
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), { target: { value: 'srv' } })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'root' } })

    const colorField = screen.getByText('Color').parentElement!
    const swatches = within(colorField as HTMLElement).getAllByRole('button')
    fireEvent.click(swatches[2]) // #10B981

    fireEvent.click(saveButton())
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ color: '#10B981' }))
  })
})
