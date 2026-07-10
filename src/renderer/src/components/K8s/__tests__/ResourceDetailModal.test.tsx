// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import ResourceDetailModal from '../ResourceDetailModal'
import { installWindowApi } from '../../../__tests__/harness'

/** Render the modal with the k8s IPC returning `raw`, and return the <pre> innerHTML. */
async function renderColorized(raw: string) {
  installWindowApi({ k8s: { resourceDetail: vi.fn().mockResolvedValue(raw) } })
  const { container } = render(
    <ResourceDetailModal context="ctx" namespace="default" kind="pod" name="my-pod" onClose={vi.fn()} />,
  )
  await waitFor(() => expect(container.querySelector('pre')).toBeTruthy())
  return container.querySelector('pre')!.innerHTML
}

beforeEach(() => {
  cleanup()
})

describe('ResourceDetailModal — colorize tokenizer', () => {
  it('colors object keys (string followed by colon) purple, including the colon', async () => {
    const html = await renderColorized('{"name": "web"}')
    expect(html).toContain('<span style="color:#9d6ff8">"name":</span>')
  })

  it('colors plain string values green', async () => {
    const html = await renderColorized('{"kind": "Pod"}')
    expect(html).toContain('<span style="color:#10b981">"Pod"</span>')
  })

  it('handles escaped quotes inside strings as a single token', async () => {
    const html = await renderColorized('{"msg": "say \\"hi\\" now"}')
    expect(html).toContain('<span style="color:#10b981">"say \\"hi\\" now"</span>')
  })

  it('treats a string with escapes followed by a colon as a key', async () => {
    const html = await renderColorized('{"a\\"b": 1}')
    expect(html).toContain('<span style="color:#9d6ff8">"a\\"b":</span>')
  })

  it('colors integer, negative, decimal and exponent numbers amber', async () => {
    const html = await renderColorized('[42, -3.14, 1e5, 2.5E-3, -7e+2]')
    for (const n of ['42', '-3.14', '1e5', '2.5E-3', '-7e+2']) {
      expect(html).toContain(`<span style="color:#f59e0b">${n}</span>`)
    }
  })

  it('colors true/false cyan and null red', async () => {
    const html = await renderColorized('{"a": true, "b": false, "c": null}')
    expect(html).toContain('<span style="color:#06b6d4">true</span>')
    expect(html).toContain('<span style="color:#06b6d4">false</span>')
    expect(html).toContain('<span style="color:#EF4444">null</span>')
  })

  it('does not colorize keywords glued to trailing word characters (nullable)', async () => {
    const html = await renderColorized('nullable')
    expect(html).not.toContain('<span style="color:#EF4444">')
    expect(html).toContain('nullable')
  })

  it('does not colorize keywords preceded by a word character (anull, xtrue)', async () => {
    const html = await renderColorized('anull xtrue')
    expect(html).not.toContain('color:#EF4444')
    expect(html).not.toContain('color:#06b6d4')
  })

  it('colorizes keywords bounded by punctuation', async () => {
    const html = await renderColorized('[true,null]')
    expect(html).toContain('<span style="color:#06b6d4">true</span>')
    expect(html).toContain('<span style="color:#EF4444">null</span>')
  })

  it('does not treat keywords inside strings as bare keywords', async () => {
    const html = await renderColorized('{"v": "null"}')
    // the quoted "null" is a string token, not the red null keyword
    expect(html).toContain('<span style="color:#10b981">"null"</span>')
    expect(html).not.toContain('<span style="color:#EF4444">null</span>')
  })

  it('leaves structural characters uncolored', async () => {
    const html = await renderColorized('{"a": [1]}')
    // braces/brackets are emitted outside spans
    expect(html).toMatch(/\{.*\}/s)
    expect(html).toContain('[')
    expect(html).toContain(']')
  })
})

describe('ResourceDetailModal — component behavior', () => {
  it('shows the kind label and name in the header', async () => {
    installWindowApi({ k8s: { resourceDetail: vi.fn().mockResolvedValue('{}') } })
    render(
      <ResourceDetailModal context="ctx" namespace="ns1" kind="deployment" name="api" onClose={vi.fn()} />,
    )
    await waitFor(() => expect(screen.getByText('Deployment — api')).toBeTruthy())
    expect(screen.getByText('ns1')).toBeTruthy()
  })

  it('falls back to the raw kind when unmapped', async () => {
    installWindowApi({ k8s: { resourceDetail: vi.fn().mockResolvedValue('{}') } })
    render(
      <ResourceDetailModal context="ctx" namespace="ns1" kind="mystery" name="x" onClose={vi.fn()} />,
    )
    await waitFor(() => expect(screen.getByText('mystery — x')).toBeTruthy())
  })

  it('renders an error message when the IPC call fails', async () => {
    installWindowApi({ k8s: { resourceDetail: vi.fn().mockRejectedValue(new Error('boom')) } })
    const { container } = render(
      <ResourceDetailModal context="ctx" namespace="ns" kind="pod" name="p" onClose={vi.fn()} />,
    )
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toContain('Error: boom'))
  })

  it('copies the JSON to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    installWindowApi({ k8s: { resourceDetail: vi.fn().mockResolvedValue('{"a":1}') } })
    render(<ResourceDetailModal context="ctx" namespace="ns" kind="pod" name="p" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTitle('Copy JSON')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Copy JSON'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"a":1}'))
  })

  it('closes when clicking the backdrop but not the panel', async () => {
    const onClose = vi.fn()
    installWindowApi({ k8s: { resourceDetail: vi.fn().mockResolvedValue('{}') } })
    const { container } = render(
      <ResourceDetailModal context="ctx" namespace="ns" kind="pod" name="p" onClose={onClose} />,
    )
    await waitFor(() => expect(container.querySelector('pre')).toBeTruthy())
    const panel = container.querySelector('pre')!
    fireEvent.mouseDown(panel)
    expect(onClose).not.toHaveBeenCalled()
    const backdrop = container.firstElementChild as HTMLElement
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('refreshes via the refresh button', async () => {
    const resourceDetail = vi.fn().mockResolvedValue('{"a":1}')
    installWindowApi({ k8s: { resourceDetail } })
    render(<ResourceDetailModal context="ctx" namespace="ns" kind="pod" name="p" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTitle('Refresh')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Refresh'))
    await waitFor(() => expect(resourceDetail).toHaveBeenCalledTimes(2))
  })
})
