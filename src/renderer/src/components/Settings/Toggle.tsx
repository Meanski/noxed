import { ACCENT } from '../../lib/colors'

interface ToggleProps {
  on: boolean
  onChange: (on: boolean) => void
  /** Accessible name, when the surrounding row's text doesn't label it. */
  label?: string
  disabled?: boolean
}

// The on/off switch used throughout Settings.
export default function Toggle({ on, onChange, label, disabled }: Readonly<ToggleProps>) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="w-9 h-5 rounded-full relative transition-colors flex-shrink-0 disabled:opacity-50"
      style={{ background: on ? ACCENT : 'var(--nox-border)' }}
    >
      <div
        className="w-4 h-4 rounded-full absolute top-[2px] shadow-sm transition-all"
        style={{ left: on ? 'calc(100% - 18px)' : '2px', background: on ? '#fff' : 'var(--nox-shell)' }}
      />
    </button>
  )
}
