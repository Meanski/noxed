import { useEffect, useId, type ReactNode } from 'react'
import { ACCENT, DANGER } from '../lib/colors'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Danger tone colours the title for destructive or security warnings. */
  tone?: 'default' | 'danger'
  width?: number
}

// Shared dialog chrome: backdrop, Escape to close, and labelled aria-modal
// semantics. Callers own the body and footer buttons.
export default function Modal({ title, onClose, children, footer, tone = 'default', width = 440 }: Readonly<ModalProps>) {
  const titleId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <dialog
        open
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative m-0 p-0 rounded-xl shadow-2xl overflow-hidden"
        style={{ width, maxWidth: 'calc(100vw - 32px)', background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
      >
        <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--nox-border)' }}>
          <h2
            id={titleId}
            className="font-['Plus_Jakarta_Sans'] font-bold text-[15px]"
            style={{ color: tone === 'danger' ? DANGER : 'var(--nox-text)' }}
          >
            {title}
          </h2>
        </div>
        <div className="px-5 py-4 font-['Inter'] text-[12.5px] space-y-3" style={{ color: 'var(--nox-text-2)' }}>
          {children}
        </div>
        {footer && (
          <div className="px-5 py-3 flex justify-end gap-2" style={{ borderTop: '1px solid var(--nox-border)' }}>
            {footer}
          </div>
        )}
      </dialog>
    </div>
  )
}

interface ModalButtonProps {
  children: ReactNode
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  autoFocus?: boolean
  disabled?: boolean
}

const BUTTON_STYLES: Record<NonNullable<ModalButtonProps['variant']>, React.CSSProperties> = {
  primary: { background: ACCENT, color: '#fff' },
  secondary: { background: 'transparent', color: 'var(--nox-text)', border: '1px solid var(--nox-border)' },
  danger: { background: DANGER, color: '#fff' },
}

export function ModalButton({ children, onClick, variant = 'secondary', autoFocus, disabled }: Readonly<ModalButtonProps>) {
  return (
    <button
      type="button"
      onClick={onClick}
      autoFocus={autoFocus}
      disabled={disabled}
      className="px-3.5 py-1.5 rounded-md text-[12.5px] font-medium disabled:opacity-50"
      style={BUTTON_STYLES[variant]}
    >
      {children}
    </button>
  )
}
