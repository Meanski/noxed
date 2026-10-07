import { Cable, FileDown, Play, Plus, SquareTerminal, Zap } from 'lucide-react'
import { useAppStore } from '../../store'
import { ACCENT } from '../../lib/colors'

interface QuickActionsProps {
  /** `bar` is the compact row above the dashboard; `cards` is the first-run grid. */
  variant: 'bar' | 'cards'
  onImportSshConfig: () => void
}

interface Action {
  id: string
  label: string
  description: string
  Icon: typeof Plus
  run: () => void
  /** Only shown in the compact bar (the first-run grid keeps to the essentials). */
  barOnly?: boolean
}

// The common ways into noxed, shared by the dashboard header and its empty state.
export default function QuickActions({ variant, onImportSshConfig }: Readonly<QuickActionsProps>) {
  const state = useAppStore.getState
  const actions: Action[] = [
    { id: 'new', label: 'New connection', description: 'Save an SSH, database, Kubernetes, Redis or RDP connection', Icon: Plus, run: () => state().setShowAddConnection(true) },
    { id: 'quick', label: 'Quick connect', description: 'ssh user@host without saving it first (⌘⇧K)', Icon: Zap, run: () => state().setQuickConnectTarget('') },
    { id: 'import', label: 'Import ~/.ssh/config', description: 'Bring in the hosts you already use with ssh', Icon: FileDown, run: onImportSshConfig },
    { id: 'local', label: 'Local terminal', description: 'A shell on this machine (⌘`)', Icon: SquareTerminal, run: () => state().openLocalTerminalTab() },
    { id: 'tunnels', label: 'Tunnels', description: 'Port forwards and SOCKS proxies', Icon: Cable, run: () => state().openTunnelsTab(), barOnly: true },
    { id: 'runner', label: 'Run command', description: 'One command across many servers', Icon: Play, run: () => state().openRunnerTab(), barOnly: true },
  ]

  if (variant === 'bar') {
    return (
      <div className="flex flex-wrap gap-2">
        {actions.map(({ id, label, Icon, run }) => (
          <button
            key={id}
            type="button"
            onClick={run}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-['Inter'] text-[12px] transition-colors hover:bg-[var(--nox-hover)]"
            style={{ color: 'var(--nox-text)', border: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}
          >
            <Icon className="w-3.5 h-3.5" style={{ color: ACCENT }} />
            {label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {actions.filter((a) => !a.barOnly).map(({ id, label, description, Icon, run }) => (
        <button
          key={id}
          type="button"
          onClick={run}
          className="flex items-start gap-3 p-4 rounded-lg text-left transition-colors hover:bg-[var(--nox-hover)]"
          style={{ border: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}
        >
          <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: ACCENT }} />
          <span>
            <span className="block font-['Inter'] text-[13px] font-medium" style={{ color: 'var(--nox-text)' }}>{label}</span>
            <span className="block font-['Inter'] text-[11.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>{description}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
