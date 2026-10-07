// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { needsPasteConfirmation, usePasteGuard } from '../usePasteGuard'
import { DEFAULT_TERMINAL_BEHAVIOR, type TerminalBehavior } from '../terminalSettings'

function fakeTerm(bracketedPasteMode = false) {
  return {
    element: document.createElement('div'),
    modes: { bracketedPasteMode },
    paste: vi.fn(),
    focus: vi.fn(),
  }
}

function paste(el: HTMLElement, text: string): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
  el.dispatchEvent(event)
  return event
}

function setup(behavior: Partial<TerminalBehavior> = {}, bracketed = false) {
  const ref = { current: { ...DEFAULT_TERMINAL_BEHAVIOR, ...behavior } }
  const term = fakeTerm(bracketed)
  const hook = renderHook(() => usePasteGuard(ref))
  let detach = () => {}
  act(() => { detach = hook.result.current.attach(term as never) })
  return { term, hook, detach: () => detach() }
}

describe('needsPasteConfirmation', () => {
  it('flags line breaks unless the shell uses bracketed paste', () => {
    expect(needsPasteConfirmation('ls -la', false)).toBe(false)
    expect(needsPasteConfirmation('ls\nrm -rf x', false)).toBe(true)
    expect(needsPasteConfirmation('reboot\n', false)).toBe(true)
    expect(needsPasteConfirmation('a\r\nb', false)).toBe(true)
    expect(needsPasteConfirmation('a\nb', true)).toBe(false)
  })
})

describe('usePasteGuard', () => {
  it('lets single-line pastes through to xterm untouched', () => {
    const { term, hook } = setup()
    const event = paste(term.element, 'echo hi')
    expect(event.defaultPrevented).toBe(false)
    expect(hook.result.current.pending).toBeNull()
  })

  it('holds a multi-line paste and replays it once on confirm', () => {
    const { term, hook } = setup()
    let event!: Event
    act(() => { event = paste(term.element, 'one\ntwo') })
    expect(event.defaultPrevented).toBe(true)
    expect(hook.result.current.pending?.text).toBe('one\ntwo')
    act(() => {
      hook.result.current.confirm()
      hook.result.current.confirm()
    })
    expect(term.paste).toHaveBeenCalledTimes(1)
    expect(term.paste).toHaveBeenCalledWith('one\ntwo')
    expect(term.focus).toHaveBeenCalled()
    expect(hook.result.current.pending).toBeNull()
  })

  it('drops the paste on cancel and refocuses the terminal', () => {
    const { term, hook } = setup()
    act(() => { paste(term.element, 'one\ntwo') })
    act(() => hook.result.current.cancel())
    expect(term.paste).not.toHaveBeenCalled()
    expect(term.focus).toHaveBeenCalled()
    expect(hook.result.current.pending).toBeNull()
  })

  it('stays out of the way when disabled or the shell brackets pastes', () => {
    const disabled = setup({ confirmMultilinePaste: false })
    expect(paste(disabled.term.element, 'a\nb').defaultPrevented).toBe(false)
    const bracketed = setup({}, true)
    expect(paste(bracketed.term.element, 'a\nb').defaultPrevented).toBe(false)
  })

  it('detaches its listener and tolerates an unopened terminal', () => {
    const { term, detach } = setup()
    detach()
    expect(paste(term.element, 'a\nb').defaultPrevented).toBe(false)
    const ref = { current: DEFAULT_TERMINAL_BEHAVIOR }
    const { result } = renderHook(() => usePasteGuard(ref))
    expect(() => result.current.attach({ element: undefined } as never)()).not.toThrow()
  })
})
