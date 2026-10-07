import { ACCENT } from '../../lib/colors'

interface SshOptionsForm {
  pollingEnabled: boolean
  connectOnStart: boolean
  agentForward: boolean
}

interface SshOptionsProps {
  form: SshOptionsForm
  set: (field: keyof SshOptionsForm, value: boolean) => void
}

function MiniToggleRow({ on, onToggle, label, description }: Readonly<{
  on: boolean; onToggle: () => void; label: string; description: string
}>) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-md" style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}>
      <button
        type="button"
        className="relative flex-shrink-0 cursor-pointer"
        aria-pressed={on}
        aria-label={label}
        onClick={onToggle}
      >
        <div className="w-8 h-4 rounded-full transition-colors" style={{ background: on ? ACCENT : 'var(--nox-border)' }} />
        <div
          className="w-3.5 h-3.5 bg-white rounded-full absolute top-[1px] transition-all shadow-sm"
          style={{ left: on ? 'calc(100% - 14px - 2px)' : 2 }}
        />
      </button>
      <div>
        <span className="font-['Inter'] text-[12px] font-medium" style={{ color: 'var(--nox-text)' }}>{label}</span>
        <p className="font-['Inter'] text-[10.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>{description}</p>
      </div>
    </div>
  )
}

// SSH-only connection options in the add/edit connection form.
export default function SshOptions({ form, set }: Readonly<SshOptionsProps>) {
  return (
    <div className="space-y-2">
      <MiniToggleRow
        on={form.pollingEnabled}
        onToggle={() => set('pollingEnabled', !form.pollingEnabled)}
        label="Enable Dashboard Polling"
        description="Monitor CPU/RAM usage on the dashboard"
      />
      <MiniToggleRow
        on={form.connectOnStart}
        onToggle={() => set('connectOnStart', !form.connectOnStart)}
        label="Connect on App Start"
        description="Automatically open a terminal session when noxed launches"
      />
      <MiniToggleRow
        on={form.agentForward}
        onToggle={() => set('agentForward', !form.agentForward)}
        label="Forward SSH Agent"
        description="Lets this server use your local SSH keys (e.g. git pull, hopping to other hosts). Anyone with root on the server can use them while you're connected, so only enable it for hosts you trust"
      />
    </div>
  )
}
