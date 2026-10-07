import { AlertTriangle, Loader2 } from 'lucide-react'
import { useAppStore } from '../../store'
import { ModalButton } from '../Modal'

// The dashboard before saved connections are known: loading, or why not.
export default function SessionsLoadState() {
  const error = useAppStore((s) => s.sessionsLoadError)
  const loadSessions = useAppStore((s) => s.loadSessions)
  return (
    <div className="h-full w-full flex items-center justify-center" style={{ background: 'var(--nox-bg)' }}>
      {error ? (
        <div className="text-center max-w-sm">
          <AlertTriangle className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--nox-danger-text)' }} />
          <p role="alert" className="font-['Inter'] text-[12.5px] mb-3" style={{ color: 'var(--nox-text-2)' }}>{error}</p>
          <ModalButton variant="primary" onClick={() => loadSessions()}>Retry</ModalButton>
        </div>
      ) : (
        <Loader2 aria-label="Loading connections" className="w-5 h-5 animate-spin" style={{ color: 'var(--nox-text-2)' }} />
      )}
    </div>
  )
}
