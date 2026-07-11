// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ServerContextMenu, MenuItem, COLORS } from '../ServerContextMenu'
import { installWindowApi, seedStore, makeSession } from '../../__tests__/harness'
import type { Session } from '../../store'

function makeHandlers() {
  return {
    onEdit: vi.fn(),
    onRename: vi.fn(),
    onColorChange: vi.fn(),
    onFavorite: vi.fn(),
    onMoveToProject: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  }
}

function renderMenu(session: Session, extra: Record<string, any> = {}) {
  const handlers = makeHandlers()
  const utils = render(
    <ServerContextMenu
      x={10}
      y={20}
      session={session}
      allGroups={['Prod', 'Staging']}
      {...handlers}
      {...extra}
    />
  )
  return { handlers, ...utils }
}

describe('ServerContextMenu', () => {
  beforeEach(() => {
    installWindowApi()
    seedStore({ groupColors: {} })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the session header with label and host:port', () => {
    const session = makeSession({ label: 'My Box', host: 'box.example.com', port: 2222 })
    renderMenu(session)
    expect(screen.getByText('My Box')).toBeTruthy()
    expect(screen.getByText('box.example.com:2222')).toBeTruthy()
  })

  it('falls back to the host when the session has no label', () => {
    const session = makeSession({ label: '', host: 'nameless.example.com' })
    renderMenu(session)
    expect(screen.getAllByText(/nameless\.example\.com/).length).toBeGreaterThan(0)
  })

  it('dispatches edit, rename, favorite and delete handlers', () => {
    const { handlers } = renderMenu(makeSession())
    fireEvent.click(screen.getByText('Edit Connection'))
    fireEvent.click(screen.getByText('Rename'))
    fireEvent.click(screen.getByText('Add to Favorites'))
    fireEvent.click(screen.getByText('Delete'))
    expect(handlers.onEdit).toHaveBeenCalledTimes(1)
    expect(handlers.onRename).toHaveBeenCalledTimes(1)
    expect(handlers.onFavorite).toHaveBeenCalledTimes(1)
    expect(handlers.onDelete).toHaveBeenCalledTimes(1)
  })

  it('shows the remove-favorite label for a favorited session', () => {
    renderMenu(makeSession({ isFavorite: true }))
    expect(screen.getByText('Remove from Favorites')).toBeTruthy()
    expect(screen.queryByText('Add to Favorites')).toBeNull()
  })

  it('only shows Docker and RDP entries when handlers are provided', () => {
    renderMenu(makeSession())
    expect(screen.queryByText('Docker Dashboard')).toBeNull()
    expect(screen.queryByText('Open Remote Desktop')).toBeNull()
  })

  it('dispatches Docker and RDP handlers when provided', () => {
    const onOpenDocker = vi.fn()
    const onOpenRdp = vi.fn()
    renderMenu(makeSession(), { onOpenDocker, onOpenRdp })
    fireEvent.click(screen.getByText('Docker Dashboard'))
    fireEvent.click(screen.getByText('Open Remote Desktop'))
    expect(onOpenDocker).toHaveBeenCalledTimes(1)
    expect(onOpenRdp).toHaveBeenCalledTimes(1)
  })

  it('opens the move submenu, excludes the current group, and moves to a project', () => {
    const { handlers } = renderMenu(makeSession({ group: 'Prod' }))
    fireEvent.click(screen.getByText('Move to Project'))
    expect(screen.queryByText('Prod')).toBeNull()
    fireEvent.click(screen.getByText('Staging'))
    expect(handlers.onMoveToProject).toHaveBeenCalledWith('Staging')
  })

  it('creates a new project via the inline input on Enter', () => {
    const { handlers } = renderMenu(makeSession({ group: 'Prod' }))
    fireEvent.click(screen.getByText('Move to Project'))
    fireEvent.click(screen.getByText('New project…'))
    const input = screen.getByPlaceholderText('Project name…')
    fireEvent.change(input, { target: { value: '  Fresh  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(handlers.onMoveToProject).toHaveBeenCalledWith('Fresh')
  })

  it('ignores Enter on an empty project name and cancels on Escape', () => {
    const { handlers } = renderMenu(makeSession())
    fireEvent.click(screen.getByText('Move to Project'))
    fireEvent.click(screen.getByText('New project…'))
    const input = screen.getByPlaceholderText('Project name…')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(handlers.onMoveToProject).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Project name…')).toBeNull()
    expect(screen.getByText('New project…')).toBeTruthy()
  })

  it('toggles the move submenu closed on a second click', () => {
    renderMenu(makeSession())
    fireEvent.click(screen.getByText('Move to Project'))
    expect(screen.getByText('Staging')).toBeTruthy()
    fireEvent.click(screen.getByText('Move to Project'))
    expect(screen.queryByText('Staging')).toBeNull()
  })

  it('dispatches a color change and outlines the current color', () => {
    const session = makeSession({ color: COLORS[2] })
    const { handlers, container } = renderMenu(session)
    const buttons = Array.from(container.querySelectorAll('button'))
    const selected = buttons.find(b => b.style.border === '2px solid var(--nox-text)')
    expect(selected).toBeTruthy()
    const first = buttons.find(b => b.style.background === 'rgb(59, 92, 204)')
    fireEvent.click(first as HTMLElement)
    expect(handlers.onColorChange).toHaveBeenCalledWith(COLORS[0])
  })

  it('closes on Escape', () => {
    const { handlers } = renderMenu(makeSession())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(handlers.onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'a' })
    expect(handlers.onClose).toHaveBeenCalledTimes(1)
  })

  it('flips the menu position when it would overflow the viewport', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200, height: 300, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    const handlers = makeHandlers()
    const { container } = render(
      <ServerContextMenu
        x={window.innerWidth - 10}
        y={window.innerHeight - 10}
        session={makeSession()}
        allGroups={[]}
        {...handlers}
      />
    )
    const menu = container.firstElementChild as HTMLElement
    expect(menu.style.left).toBe(`${window.innerWidth - 10 - 200}px`)
    expect(menu.style.top).toBe(`${window.innerHeight - 10 - 300}px`)
  })

  it('applies hover styling to menu items and group buttons', () => {
    renderMenu(makeSession({ group: 'Prod' }))
    const item = screen.getByText('Edit Connection').closest('button') as HTMLElement
    fireEvent.mouseEnter(item)
    expect(item.style.background).toBe('var(--nox-hover)')
    fireEvent.mouseLeave(item)
    expect(item.style.background).toBe('')

    fireEvent.click(screen.getByText('Move to Project'))
    const group = screen.getByText('Staging').closest('button') as HTMLElement
    fireEvent.mouseEnter(group)
    expect(group.style.background).toBe('var(--nox-hover)')
    fireEvent.mouseLeave(group)
    expect(group.style.background).toBe('')

    const create = screen.getByText('New project…').closest('button') as HTMLElement
    fireEvent.mouseEnter(create)
    expect(create.style.background).toBe('var(--nox-hover)')
    fireEvent.mouseLeave(create)
    expect(create.style.background).toBe('')

    fireEvent.mouseDown(group)
  })
})

describe('MenuItem', () => {
  it('renders a submenu chevron and danger colors', () => {
    const onClick = vi.fn()
    const { container } = render(
      <MenuItem icon={<span data-testid="icon" />} label="Danger" onClick={onClick} danger hasSubmenu />
    )
    const button = container.querySelector('button') as HTMLElement
    expect(button.style.color).toBe('rgb(239, 68, 68)')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
