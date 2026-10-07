import { useRef } from 'react'
import { ACCENT } from '../lib/colors'

interface SplitHandleProps {
  /** `vertical` is a vertical bar dragged left/right; `horizontal` is dragged up/down. */
  orientation: 'vertical' | 'horizontal'
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  /** Maps a pointer position to a value in the same units as `value`. */
  valueFromPointer: (clientX: number, clientY: number) => number
  /** Double-click restores this value. */
  defaultValue: number
  /** Keyboard increment, in `value` units. */
  step?: number
  label: string
  style?: React.CSSProperties
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

// Draggable divider shared by split panes, the sidebar, and the SFTP/database
// splitters. Pointer capture keeps a drag alive when the cursor leaves the thin
// hit area or crosses a terminal canvas. Keyboard users get a visually hidden
// native range input, which brings slider semantics and arrow/Home/End keys.
export default function SplitHandle({
  orientation, value, min, max, onChange, valueFromPointer, defaultValue, step = 1, label, style,
}: Readonly<SplitHandleProps>) {
  const dragging = useRef(false)
  const vertical = orientation === 'vertical'

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragging.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    onChange(clamp(valueFromPointer(e.clientX, e.clientY), min, max))
  }
  const endDrag = () => { dragging.current = false }

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onChange(clamp(defaultValue, min, max))}
      className={`group relative flex flex-shrink-0 items-center justify-center z-10 ${vertical ? 'w-[5px] cursor-col-resize' : 'h-[5px] cursor-row-resize'}`}
      style={{ touchAction: 'none', ...style }}
    >
      <input
        type="range"
        className="sr-only"
        aria-label={label}
        aria-orientation={orientation}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value), min, max))}
      />
      {/* A hairline at rest that thickens into the accent colour on hover or
          keyboard focus; the 5px wrapper is the hit area. */}
      <div
        className={`transition-all bg-[var(--nox-border)] group-hover:bg-[var(--split-accent)] group-focus-within:bg-[var(--split-accent)] ${
          vertical ? 'w-px h-full group-hover:w-[3px] group-focus-within:w-[3px]' : 'h-px w-full group-hover:h-[3px] group-focus-within:h-[3px]'
        }`}
        style={{ '--split-accent': ACCENT } as React.CSSProperties}
      />
    </div>
  )
}
