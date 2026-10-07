import { useEffect, useRef } from 'react'
import SplitHandle from '../SplitHandle'
import { useAppStore } from '../../store'
import { ipcErrorMessage } from '../../lib/format'

const SIDEBAR_MIN_PX = 180
const SIDEBAR_MAX_PX = 480
const SIDEBAR_DEFAULT_PX = 220
// Drags fire a change per pointer move; only persist once the user settles.
const PERSIST_DELAY_MS = 400

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_PX
  return Math.round(Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, px)))
}

// The sidebar starts at the window's left edge, so its width is the pointer's x.
const widthFromPointer = (clientX: number) => clientX

export default function SidebarResizeHandle() {
  const width = useAppStore((s) => s.sidebarWidth)
  const setWidth = useAppStore((s) => s.setSidebarWidth)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onChange = (px: number) => {
    const next = clampSidebarWidth(px)
    setWidth(next)
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      window.api.settings.set('sidebarWidth', next).catch((err: unknown) => {
        useAppStore.getState().addNotification({ type: 'warning', message: ipcErrorMessage(err, 'Could not save sidebar width') })
      })
    }, PERSIST_DELAY_MS)
  }

  useEffect(() => () => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
  }, [])

  return (
    <SplitHandle
      orientation="vertical"
      label="Resize sidebar"
      value={width}
      min={SIDEBAR_MIN_PX}
      max={SIDEBAR_MAX_PX}
      defaultValue={SIDEBAR_DEFAULT_PX}
      step={10}
      onChange={onChange}
      valueFromPointer={widthFromPointer}
    />
  )
}
