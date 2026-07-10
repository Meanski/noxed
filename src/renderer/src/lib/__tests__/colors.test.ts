import { describe, it, expect } from 'vitest'
import { metricColor, metricColorMuted, groupColor, podStatusColor } from '../colors'

describe('metricColor', () => {
  it('is red at or above 80', () => {
    expect(metricColor(80)).toBe('#EF4444')
    expect(metricColor(95)).toBe('#EF4444')
  })

  it('is amber between 60 and 79', () => {
    expect(metricColor(60)).toBe('#F59E0B')
    expect(metricColor(79)).toBe('#F59E0B')
  })

  it('is green below 60', () => {
    expect(metricColor(10)).toBe('#10B981')
  })
})

describe('metricColorMuted', () => {
  it('mirrors the same thresholds with muted colors', () => {
    expect(metricColorMuted(85)).toBe('#ef4444')
    expect(metricColorMuted(65)).toBe('#f59e0b')
    expect(metricColorMuted(10)).toBe('rgba(255,255,255,0.55)')
  })
})

describe('groupColor', () => {
  const palette = ['#6366f1', '#22c55e', '#f59e0b', '#f87171', '#a78bfa', '#06b6d4', '#fb923c', '#e879f9', '#34d399']

  it('prefers a user override', () => {
    expect(groupColor('prod', { prod: '#123456' })).toBe('#123456')
  })

  it('hashes the name to a stable palette color', () => {
    const c = groupColor('production')
    expect(palette).toContain(c)
    expect(groupColor('production')).toBe(c)
  })

  it('handles multi-byte characters without throwing', () => {
    expect(palette).toContain(groupColor('日本サーバ🚀'))
  })

  it('ignores overrides for other groups', () => {
    expect(palette).toContain(groupColor('staging', { prod: '#123456' }))
  })
})

describe('podStatusColor', () => {
  it('maps common phases', () => {
    expect(podStatusColor('Running')).toBe('#10B981')
    expect(podStatusColor('Succeeded')).toBe('#3B82F6')
    expect(podStatusColor('Pending')).toBe('#F59E0B')
    expect(podStatusColor('CrashLoopBackOff')).toBe('#EF4444')
    expect(podStatusColor('Unknown')).toBe('#6B7280')
  })
})
