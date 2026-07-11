// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import K8sIcon from '../K8sIcon'

describe('K8sIcon', () => {
  it('renders the brand-colored wheel by default', () => {
    const { container } = render(<K8sIcon />)
    const svg = container.querySelector('svg') as SVGSVGElement
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    const circles = Array.from(svg.querySelectorAll('circle'))
    // Background disc + hub (2) + hub dot + 7 spoke tips
    expect(circles).toHaveLength(10)
    expect(circles[0].getAttribute('fill')).toBe('#326CE5')
    const lines = svg.querySelectorAll('line')
    expect(lines).toHaveLength(7)
    lines.forEach(l => expect(l.getAttribute('stroke')).toBe('white'))
  })

  it('honors size and className props', () => {
    const { container } = render(<K8sIcon size={32} className="shrink-0" />)
    const svg = container.querySelector('svg') as SVGSVGElement
    expect(svg.getAttribute('width')).toBe('32')
    expect(svg.getAttribute('class')).toBe('shrink-0')
  })

  it('renders a monochrome outline when a color is given', () => {
    const { container } = render(<K8sIcon color="#ABCDEF" />)
    const svg = container.querySelector('svg') as SVGSVGElement
    const circles = Array.from(svg.querySelectorAll('circle'))
    // Outline ring + hub only; no spoke tip dots in monochrome mode
    expect(circles).toHaveLength(2)
    expect(circles[0].getAttribute('stroke')).toBe('#ABCDEF')
    expect(circles[0].getAttribute('fill')).toBe('none')
    expect(circles[1].getAttribute('fill')).toBe('#ABCDEF')
    const lines = svg.querySelectorAll('line')
    expect(lines).toHaveLength(7)
    lines.forEach(l => expect(l.getAttribute('stroke')).toBe('#ABCDEF'))
  })
})
