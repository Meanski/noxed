// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import SplitHandle from '../SplitHandle'

function setup(over: Partial<React.ComponentProps<typeof SplitHandle>> = {}) {
  const onChange = vi.fn()
  render(
    <SplitHandle
      orientation="vertical"
      label="Resize thing"
      value={50}
      min={20}
      max={80}
      defaultValue={50}
      onChange={onChange}
      valueFromPointer={(x) => x / 10}
      {...over}
    />,
  )
  const input = screen.getByLabelText('Resize thing') as HTMLInputElement
  return { onChange, input, handle: input.parentElement as HTMLElement }
}

beforeEach(() => cleanup())

describe('SplitHandle', () => {
  it('follows the pointer only while dragging, clamped to range', () => {
    const { onChange, handle } = setup()
    fireEvent.pointerMove(handle, { clientX: 400 })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
    fireEvent.pointerMove(handle, { clientX: 400 })
    fireEvent.pointerMove(handle, { clientX: 1500 })
    fireEvent.pointerMove(handle, { clientX: 10 })
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([40, 80, 20])
    fireEvent.pointerCancel(handle)
    fireEvent.pointerMove(handle, { clientX: 300 })
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('ignores non-primary buttons', () => {
    const { onChange, handle } = setup()
    fireEvent.pointerDown(handle, { button: 2, clientX: 500 })
    fireEvent.pointerMove(handle, { clientX: 400 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('resets to the default on double-click', () => {
    const { onChange, handle } = setup({ value: 70, defaultValue: 40 })
    fireEvent.doubleClick(handle)
    expect(onChange).toHaveBeenCalledWith(40)
  })

  it('exposes a labelled range input for keyboard users', () => {
    const { onChange, input } = setup({ orientation: 'horizontal', step: 5 })
    expect(input.type).toBe('range')
    expect(input.getAttribute('aria-orientation')).toBe('horizontal')
    expect([input.min, input.max, input.step, input.value]).toEqual(['20', '80', '5', '50'])
    fireEvent.change(input, { target: { value: '65' } })
    expect(onChange).toHaveBeenCalledWith(65)
  })
})
