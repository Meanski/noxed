import { IconAlert, IconRefresh, IconWifi } from '../Icons'

interface Props {
  message?: string
  onReconnect: () => void
  connecting: boolean
  cooldown: number
  failCount: number
  onDismiss: () => void
  onClose: () => void
}

export default function DisconnectedOverlay({ message, onReconnect, connecting, cooldown, failCount, onDismiss, onClose }: Props) {
  const blocked = connecting || cooldown > 0
  const showFail2banHint = failCount >= 2 && message?.toLowerCase().includes('timeout')
  return (
    <div
      className="absolute inset-0 flex items-center justify-center animate-fade-in backdrop-blur-sm"
      style={{ background: 'rgba(9,9,15,0.75)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onDismiss() }}
    >
      <div className="text-center space-y-5 animate-slide-up max-w-[300px] px-6">
        <div className="relative mx-auto w-14 h-14">
          <span className="absolute inset-0 rounded-full blur-xl" style={{ background: 'rgba(248,113,113,0.15)' }} />
          <div
            className="relative w-full h-full rounded-full flex items-center justify-center"
            style={{ border: '1px solid rgba(248,113,113,0.25)', background: 'rgba(248,113,113,0.08)', color: '#f87171' }}
          >
            <IconAlert size={22} />
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-md font-semibold" style={{ color: '#eeeef2' }}>Connection lost</p>
          {message && <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.45)' }}>{message}</p>}
          {showFail2banHint && (
            <p className="text-xs leading-relaxed" style={{ color: 'rgba(248,113,113,0.7)' }}>
              Multiple failures detected — your IP may be temporarily blocked by fail2ban. Wait a few minutes before retrying.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={onReconnect}
            disabled={blocked}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium rounded-xl transition-all disabled:opacity-50"
            style={{ background: '#6366f1', color: '#fff', boxShadow: blocked ? 'none' : '0 0 24px rgba(99,102,241,0.3)' }}
            onMouseEnter={(e) => { if (!blocked) e.currentTarget.style.background = '#818cf8' }}
            onMouseLeave={(e) => { if (!blocked) e.currentTarget.style.background = '#6366f1' }}
          >
            {connecting ? (
              <><IconRefresh size={13} className="animate-spin" />Reconnecting…</>
            ) : cooldown > 0 ? (
              <><IconRefresh size={13} />Retry in {cooldown}s</>
            ) : (
              <><IconWifi size={13} />Reconnect</>
            )}
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center gap-2 px-5 py-2 text-xs font-medium rounded-xl transition-all"
            style={{ color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.1)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)' }}
          >
            Close connection
          </button>
        </div>
      </div>
    </div>
  )
}
