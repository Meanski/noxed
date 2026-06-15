import { describe, it, expect, beforeEach } from 'vitest'
import { checkResourceAlerts, resetResourceAlerts } from '../metricsAlerts'
import type { LiveMetrics } from '../sshDispatch'

function metrics(overrides: Partial<LiveMetrics> = {}): LiveMetrics {
  return {
    cpu: 10,
    memUsed: 1024,
    memTotal: 4096,
    diskUsed: 10_000,
    diskTotal: 100_000,
    available: true,
    ...overrides,
  }
}

describe('checkResourceAlerts', () => {
  const id = 'session-1'
  let alerts: string[]

  beforeEach(() => {
    resetResourceAlerts(id)
    alerts = []
  })

  const notify = (message: string) => alerts.push(message)

  it('requires sustained high CPU before alerting', () => {
    checkResourceAlerts(id, 'web', metrics({ cpu: 95 }), notify)
    checkResourceAlerts(id, 'web', metrics({ cpu: 96 }), notify)
    expect(alerts).toHaveLength(0)
    checkResourceAlerts(id, 'web', metrics({ cpu: 97 }), notify)
    expect(alerts).toEqual(['web: CPU pinned at 97%'])
  })

  it('alerts only once until CPU recovers', () => {
    for (let i = 0; i < 6; i++) checkResourceAlerts(id, 'web', metrics({ cpu: 95 }), notify)
    expect(alerts).toHaveLength(1)

    checkResourceAlerts(id, 'web', metrics({ cpu: 20 }), notify)
    for (let i = 0; i < 3; i++) checkResourceAlerts(id, 'web', metrics({ cpu: 95 }), notify)
    expect(alerts).toHaveLength(2)
  })

  it('a brief spike does not alert', () => {
    checkResourceAlerts(id, 'web', metrics({ cpu: 95 }), notify)
    checkResourceAlerts(id, 'web', metrics({ cpu: 30 }), notify)
    checkResourceAlerts(id, 'web', metrics({ cpu: 95 }), notify)
    checkResourceAlerts(id, 'web', metrics({ cpu: 30 }), notify)
    expect(alerts).toHaveLength(0)
  })

  it('alerts once when the disk crosses 90%', () => {
    checkResourceAlerts(id, 'db', metrics({ diskUsed: 95_000 }), notify)
    checkResourceAlerts(id, 'db', metrics({ diskUsed: 96_000 }), notify)
    expect(alerts).toEqual(['db: root disk 95% full'])
  })

  it('ignores unavailable metrics and missing disk data', () => {
    checkResourceAlerts(id, 'web', metrics({ cpu: 99, available: false }), notify)
    checkResourceAlerts(id, 'web', metrics({ cpu: 99, diskUsed: undefined, diskTotal: undefined }), notify)
    expect(alerts).toHaveLength(0)
  })
})
