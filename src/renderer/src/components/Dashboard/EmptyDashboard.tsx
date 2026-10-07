import QuickActions from './QuickActions'

interface EmptyDashboardProps {
  onImportSshConfig: () => void
}

// First run: no saved connections yet, so lead with the ways to get started.
export default function EmptyDashboard({ onImportSshConfig }: Readonly<EmptyDashboardProps>) {
  return (
    <div className="h-full w-full overflow-y-auto flex items-center justify-center" style={{ background: 'var(--nox-bg)' }}>
      <div className="w-full max-w-xl px-6 py-10">
        <h1 className="font-['Plus_Jakarta_Sans'] font-bold text-[22px]" style={{ color: 'var(--nox-text)' }}>
          Welcome to noxed
        </h1>
        <p className="font-['Inter'] text-[13px] mt-1.5 mb-6 leading-relaxed" style={{ color: 'var(--nox-text-2)' }}>
          Every server in one window: SSH, SFTP, databases, Redis, Docker, Kubernetes and Remote Desktop.
          Pick a way to start.
        </p>
        <QuickActions variant="cards" onImportSshConfig={onImportSshConfig} />
        <p className="font-['Inter'] text-[11.5px] mt-6" style={{ color: 'var(--nox-text-2)' }}>
          Tip: press ⌘K anywhere to search connections and commands.
        </p>
      </div>
    </div>
  )
}
