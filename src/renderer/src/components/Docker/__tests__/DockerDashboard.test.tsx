// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import DockerDashboard from '../DockerDashboard'
import { installWindowApi, seedStore, makeSession, makeTab, WindowApiMock } from '../../../__tests__/harness'

const containers = [
  { ID: 'c1', Names: 'web', Image: 'nginx:latest', State: 'running', Status: 'Up 2 hours', Ports: '80/tcp' },
  { ID: 'c2', Names: 'worker', Image: 'app:1', State: 'exited', Status: 'Exited (0)', Ports: '' },
  { ID: 'c3', Names: 'flaky', Image: 'app:2', State: 'restarting', Status: 'Restarting', Ports: '' },
]

const stats = [{ Name: 'web', CPUPerc: '3.14%', MemUsage: '120MiB / 1GiB' }]

let api: WindowApiMock

describe('DockerDashboard', () => {
  beforeEach(() => {
    api = installWindowApi({
      docker: {
        containers: vi.fn().mockResolvedValue(containers),
        stats: vi.fn().mockResolvedValue(stats),
        images: vi.fn().mockResolvedValue([]),
      },
    })
    const session = makeSession({ id: 'ssh-1', label: 'Host', host: 'h1.example.com' })
    seedStore({ sessions: [session], tabs: [], notifications: [] })
  })

  function renderDashboard() {
    const tab = makeTab({ view: 'docker', sessionId: 'ssh-1', status: 'connected' })
    return render(<DockerDashboard tab={tab} />)
  }

  it('lists containers with per-state coloring once connected', async () => {
    renderDashboard()
    expect(screen.getByText('Connecting over SSH…')).toBeTruthy()

    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    expect(screen.getByText('worker')).toBeTruthy()
    expect(screen.getByText('flaky')).toBeTruthy()

    // running → green, exited → muted, anything else → amber
    expect((screen.getByText('Up 2 hours') as HTMLElement).style.color).toBe('rgb(16, 185, 129)')
    expect((screen.getByText('Exited (0)') as HTMLElement).style.color).toBe('var(--nox-text-3)')
    expect((screen.getByText('Restarting') as HTMLElement).style.color).toBe('rgb(245, 158, 11)')

    // Running container shows stats
    expect(screen.getByText('3.14%')).toBeTruthy()
    expect(screen.getByText('1 running / 3 containers', { exact: false })).toBeTruthy()
  })

  it('starts a stopped container through the row action', async () => {
    renderDashboard()
    await waitFor(() => expect(screen.getByText('worker')).toBeTruthy())

    fireEvent.click(screen.getAllByTitle('Start')[0])
    await waitFor(() => expect(api.docker.action).toHaveBeenCalledWith('docker-1', 'c2', 'start'))
  })

  it('surfaces connection failures', async () => {
    api.docker.connect.mockRejectedValueOnce(new Error('no docker daemon'))
    renderDashboard()
    await waitFor(() => expect(screen.getByText('Docker unavailable')).toBeTruthy())
    expect(screen.getByText('no docker daemon')).toBeTruthy()
  })
})
