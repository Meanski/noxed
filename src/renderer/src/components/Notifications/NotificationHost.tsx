import { useEffect } from 'react'
import { X, CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react'
import { useAppStore, AppNotification } from '../../store'

const AUTO_DISMISS_MS = 5000

const TYPE_STYLES: Record<AppNotification['type'], { color: string; icon: React.ReactNode }> = {
  success: { color: '#10B981', icon: <CheckCircle2 className="w-4 h-4" /> },
  warning: { color: '#F59E0B', icon: <AlertTriangle className="w-4 h-4" /> },
  error: { color: '#EF4444', icon: <XCircle className="w-4 h-4" /> },
  info: { color: '#3B5CCC', icon: <Info className="w-4 h-4" /> },
}

export default function NotificationHost() {
  const notifications = useAppStore(s => s.notifications)
  const dismiss = useAppStore(s => s.dismissNotification)

  if (notifications.length === 0) return null

  return (
    <div className="fixed bottom-10 right-4 z-50 flex flex-col gap-2 w-[320px] pointer-events-none">
      {notifications.slice(-5).map(n => (
        <Toast key={n.id} notification={n} onDismiss={() => dismiss(n.id)} />
      ))}
    </div>
  )
}

function Toast({ notification, onDismiss }: Readonly<{ notification: AppNotification; onDismiss: () => void }>) {
  const { color, icon } = TYPE_STYLES[notification.type]

  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [notification.id])

  return (
    <div
      className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg shadow-lg animate-slide-up pointer-events-auto"
      style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
    >
      <span className="flex-shrink-0 mt-px" style={{ color }}>{icon}</span>
      <p className="flex-1 min-w-0 font-['Inter'] text-[12px] leading-snug break-words" style={{ color: 'var(--nox-text)' }}>
        {notification.message}
      </p>
      <button
        onClick={onDismiss}
        className="flex-shrink-0 transition-colors"
        style={{ color: 'var(--nox-text-3)' }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--nox-text)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--nox-text-3)' }}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
