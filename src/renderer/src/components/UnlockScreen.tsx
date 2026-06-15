import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store'

type AuthMode = 'none' | 'pin' | 'password' | 'biometrics'

export default function UnlockScreen() {
  const { setLocked } = useAppStore()
  const [mode, setMode] = useState<AuthMode | null>(null)
  const [touchIDAvailable, setTouchIDAvailable] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [shake, setShake] = useState(false)
  const biometricPromptedRef = useRef(false)

  useEffect(() => {
    Promise.all([
      window.api.auth.getMode(),
      window.api.auth.isAvailable(),
    ]).then(([m, available]) => {
      setTouchIDAvailable(available)
      setMode(m)

      // Auto-unlock for 'none' mode
      if (m === 'none') {
        window.api.auth.unlock().then(r => { if (r.success) setLocked(false) })
      }

      if (m === 'biometrics') {
        promptBiometricWhenFocused()
      }
    })
  }, [])

  useEffect(() => {
    if (mode !== 'biometrics') return

    const onFocus = () => promptBiometricWhenFocused()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)

    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [mode])

  const handleUnlock = async (credential?: string) => {
    setLoading(true)
    setError('')
    const result = await window.api.auth.unlock(credential)
    setLoading(false)

    if (result.success) {
      setLocked(false)
    } else {
      setError(result.error ?? 'Authentication failed')
      triggerShake()
    }
  }

  const handleBiometricUnlock = async () => {
    setLoading(true)
    setError('')
    const result = await window.api.auth.unlock()
    setLoading(false)
    if (result.success) {
      setLocked(false)
    } else {
      setError(result.error ?? 'Touch ID failed')
    }
  }

  const promptBiometricWhenFocused = () => {
    if (biometricPromptedRef.current || document.visibilityState !== 'visible' || !document.hasFocus()) return
    biometricPromptedRef.current = true
    handleBiometricUnlock()
  }

  const triggerShake = () => {
    setShake(true)
    setTimeout(() => setShake(false), 500)
  }

  // Loading/auto-unlock for 'none' mode
  if (!mode || mode === 'none') {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'var(--nox-bg)' }}>
        <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin"
          style={{ borderColor: 'var(--nox-border)', borderTopColor: '#3B5CCC' }} />
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'var(--nox-bg)' }}>
      <div className="flex flex-col items-center gap-8 w-full max-w-xs px-8">
        {/* Logo */}
        <div className="flex flex-col items-center gap-2">
          <svg width="40" height="40" viewBox="0 0 32 32" fill="none">
            <path d="M12 8 L4 16 L12 24" stroke="#3B5CCC" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M20 8 L28 16 L20 24" stroke="#3B5CCC" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="font-['Plus_Jakarta_Sans'] font-bold text-[20px]" style={{ color: 'var(--nox-text)' }}>
            noxed
          </span>
        </div>

        {mode === 'biometrics' && (
          <BiometricView
            loading={loading}
            error={error}
            onRetry={handleBiometricUnlock}
            touchIDAvailable={touchIDAvailable}
          />
        )}

        {mode === 'pin' && (
          <PinView
            loading={loading}
            error={error}
            shake={shake}
            onSubmit={handleUnlock}
          />
        )}

        {mode === 'password' && (
          <PasswordView
            loading={loading}
            error={error}
            shake={shake}
            onSubmit={handleUnlock}
          />
        )}
      </div>
    </div>
  )
}

/* ── Biometric view ─────────────────────────────────────────────────────── */
function BiometricView({ loading, error, onRetry, touchIDAvailable }: {
  loading: boolean
  error: string
  onRetry: () => void
  touchIDAvailable: boolean
}) {
  return (
    <div className="flex flex-col items-center gap-5 w-full">
      <div
        className="w-20 h-20 rounded-2xl flex items-center justify-center"
        style={{ background: 'var(--nox-surface)', border: '1px solid var(--nox-border)' }}
      >
        <FingerprintIcon size={44} active={loading} />
      </div>

      <div className="text-center">
        <p className="font-['Plus_Jakarta_Sans'] font-semibold text-[16px]" style={{ color: 'var(--nox-text)' }}>
          {loading ? 'Waiting for Touch ID…' : 'Touch ID Required'}
        </p>
        <p className="font-['Inter'] text-[12.5px] mt-1" style={{ color: 'var(--nox-text-2)' }}>
          {touchIDAvailable
            ? 'Place your finger on the sensor'
            : 'Touch ID is not available on this device'}
        </p>
      </div>

      {error && (
        <p className="font-['Inter'] text-[12px] text-[#EF4444] text-center">{error}</p>
      )}

      {!loading && (
        <button
          onClick={onRetry}
          disabled={!touchIDAvailable}
          className="w-full py-2.5 rounded-xl font-['Inter'] text-[13.5px] font-semibold text-white transition-all disabled:opacity-40"
          style={{ background: '#3B5CCC' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2A4299' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#3B5CCC' }}
        >
          Try Again
        </button>
      )}
    </div>
  )
}

/* ── PIN view ───────────────────────────────────────────────────────────── */
function PinView({ loading, error, shake, onSubmit }: {
  loading: boolean
  error: string
  shake: boolean
  onSubmit: (pin: string) => void
}) {
  const [digits, setDigits] = useState<string[]>([])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (loading) return
      if (/^[0-9]$/.test(e.key) && digits.length < 4) {
        const next = [...digits, e.key]
        setDigits(next)
        if (next.length === 4) {
          onSubmit(next.join(''))
          setDigits([])
        }
      }
      if (e.key === 'Backspace') setDigits(d => d.slice(0, -1))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [digits, loading])

  const pressDigit = (d: string) => {
    if (loading || digits.length >= 4) return
    const next = [...digits, d]
    setDigits(next)
    if (next.length === 4) {
      setTimeout(() => {
        onSubmit(next.join(''))
        setDigits([])
      }, 80)
    }
  }

  const deleteDigit = () => setDigits(d => d.slice(0, -1))

  return (
    <div className="flex flex-col items-center gap-6 w-full">
      <p className="font-['Plus_Jakarta_Sans'] font-semibold text-[16px]" style={{ color: 'var(--nox-text)' }}>
        Enter PIN
      </p>

      {/* Dot indicators */}
      <div className={`flex items-center gap-4 transition-all ${shake ? 'animate-shake' : ''}`}>
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            className="w-3.5 h-3.5 rounded-full transition-all"
            style={{
              background: i < digits.length ? '#3B5CCC' : 'var(--nox-border)',
              transform: i < digits.length ? 'scale(1.1)' : 'scale(1)',
            }}
          />
        ))}
      </div>

      {error && (
        <p className="font-['Inter'] text-[12px] text-[#EF4444] text-center -mt-2">{error}</p>
      )}

      {/* Numpad */}
      <div className="grid grid-cols-3 gap-3 w-full">
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((key, i) => {
          if (key === '') return <div key={i} />
          const isDelete = key === '⌫'
          return (
            <button
              key={key}
              onClick={() => isDelete ? deleteDigit() : pressDigit(key)}
              disabled={loading}
              className="h-14 rounded-xl font-['Plus_Jakarta_Sans'] text-[18px] font-semibold transition-all active:scale-95 disabled:opacity-40"
              style={{
                background: isDelete ? 'transparent' : 'var(--nox-shell)',
                border: isDelete ? 'none' : '1px solid var(--nox-border)',
                color: isDelete ? 'var(--nox-text-2)' : 'var(--nox-text)',
              }}
              onMouseEnter={e => {
                if (!isDelete) (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)'
              }}
              onMouseLeave={e => {
                if (!isDelete) (e.currentTarget as HTMLElement).style.background = 'var(--nox-shell)'
              }}
            >
              {key}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ── Password view ──────────────────────────────────────────────────────── */
function PasswordView({ loading, error, shake, onSubmit }: {
  loading: boolean
  error: string
  shake: boolean
  onSubmit: (pw: string) => void
}) {
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (value.trim()) onSubmit(value)
  }

  return (
    <div className="flex flex-col items-center gap-5 w-full">
      <p className="font-['Plus_Jakarta_Sans'] font-semibold text-[16px]" style={{ color: 'var(--nox-text)' }}>
        Enter Password
      </p>

      <form onSubmit={handleSubmit} className={`w-full flex flex-col gap-3 ${shake ? 'animate-shake' : ''}`}>
        <div className="relative">
          <input
            ref={inputRef}
            type={show ? 'text' : 'password'}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="Password"
            className="w-full rounded-xl px-4 py-3 font-['Inter'] text-[13.5px] focus:outline-none focus:ring-2 focus:ring-[#3B5CCC]"
            style={{
              background: 'var(--nox-shell)',
              border: '1px solid var(--nox-border)',
              color: 'var(--nox-text)',
            }}
          />
          <button
            type="button"
            onClick={() => setShow(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--nox-text-3)' }}
          >
            {show ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
          </button>
        </div>

        {error && (
          <p className="font-['Inter'] text-[12px] text-[#EF4444] text-center">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading || !value.trim()}
          className="w-full py-2.5 rounded-xl font-['Inter'] text-[13.5px] font-semibold text-white transition-all disabled:opacity-40"
          style={{ background: '#3B5CCC' }}
          onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLElement).style.background = '#2A4299' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#3B5CCC' }}
        >
          {loading ? 'Verifying…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}

/* ── Icons ──────────────────────────────────────────────────────────────── */
function FingerprintIcon({ size = 24, active }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8.5C4 6 6 4 8.5 4" stroke={active ? '#3B5CCC' : 'var(--nox-text-2)'} strokeWidth="1.5" />
      <path d="M15.5 4C18 4 20 6 20 8.5" stroke={active ? '#3B5CCC' : 'var(--nox-text-2)'} strokeWidth="1.5" />
      <path d="M20 15.5C20 18 18 20 15.5 20" stroke={active ? '#3B5CCC' : 'var(--nox-text-2)'} strokeWidth="1.5" />
      <path d="M8.5 20C6 20 4 18 4 15.5" stroke={active ? '#3B5CCC' : 'var(--nox-text-2)'} strokeWidth="1.5" />
      <path d="M9 12a3 3 0 0 1 6 0v1" stroke={active ? '#3B5CCC' : 'var(--nox-text-2)'} strokeWidth="1.5" opacity="0.9" />
      <path d="M12 15v2" stroke={active ? '#3B5CCC' : 'var(--nox-text-2)'} strokeWidth="1.5" />
      <path d="M8 12a4 4 0 0 1 8 0" stroke={active ? '#3B5CCC' : 'var(--nox-text-3)'} strokeWidth="1.5" opacity="0.6" />
      <path d="M6.5 11a5.5 5.5 0 0 1 11 0v2" stroke={active ? '#3B5CCC' : 'var(--nox-text-3)'} strokeWidth="1.5" opacity="0.35" />
    </svg>
  )
}

function EyeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  )
}

function EyeOffIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  )
}
