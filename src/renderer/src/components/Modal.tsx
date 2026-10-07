import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { ACCENT } from '../lib/colors'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Danger tone colours the title for destructive or security warnings. */
  tone?: 'default' | 'danger'
  width?: number
}

// Shared dialog chrome on a native <dialog> opened with showModal(), so it sits
// in the top layer, contains focus, and makes the rest of the app inert.
export default function Modal({ title, onClose, children, footer, tone = 'default', width = 440 }: Readonly<ModalProps>) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    // jsdom has no showModal(); the open attribute is the closest stand-in.
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }
    // showModal() focuses the first focusable element, which would override
    // React's autoFocus — so buttons opt in via data-autofocus instead.
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])

  // Escape is handled here (and the native cancel suppressed) so onClose runs
  // exactly once, in Electron and in tests alike.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onCancel={(e) => e.preventDefault()}
      // Capped to the viewport with a scrolling body, so the footer buttons
      // stay reachable however long the content is.
      className="m-auto p-0 rounded-xl shadow-2xl overflow-hidden max-h-[calc(100vh-32px)] open:flex open:flex-col backdrop:bg-black/50"
      style={{ width, maxWidth: 'calc(100vw - 32px)', background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
    >
      <div className="flex-shrink-0 px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--nox-border)' }}>
        <h2
          id={titleId}
          className="font-['Plus_Jakarta_Sans'] font-bold text-[15px]"
          style={{ color: tone === 'danger' ? 'var(--nox-danger-text)' : 'var(--nox-text)' }}
        >
          {title}
        </h2>
      </div>
      <div className="min-h-0 overflow-y-auto px-5 py-4 font-['Inter'] text-[12.5px] space-y-3" style={{ color: 'var(--nox-text-2)' }}>
        {children}
      </div>
      {footer && (
        <div className="flex-shrink-0 px-5 py-3 flex justify-end gap-2" style={{ borderTop: '1px solid var(--nox-border)' }}>
          {footer}
        </div>
      )}
    </dialog>
  )
}

interface ModalButtonProps {
  children: ReactNode
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  /** Receives focus when the modal opens. */
  initialFocus?: boolean
  disabled?: boolean
}

const BUTTON_STYLES: Record<NonNullable<ModalButtonProps['variant']>, React.CSSProperties> = {
  primary: { background: ACCENT, color: '#fff' },
  secondary: { background: 'transparent', color: 'var(--nox-text)', border: '1px solid var(--nox-border)' },
  danger: { background: 'var(--nox-danger-bg)', color: '#fff' },
}

export function ModalButton({ children, onClick, variant = 'secondary', initialFocus, disabled }: Readonly<ModalButtonProps>) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-autofocus={initialFocus ? '' : undefined}
      disabled={disabled}
      className="px-3.5 py-1.5 rounded-md text-[12.5px] font-medium disabled:opacity-50"
      style={BUTTON_STYLES[variant]}
    >
      {children}
    </button>
  )
}
