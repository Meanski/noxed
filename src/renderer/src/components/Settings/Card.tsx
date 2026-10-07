// Titled section container shared by the Settings tabs.
export default function Card({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div
      className="rounded-md p-5"
      style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
    >
      <div className="mb-4">
        <span
          className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold"
          style={{ color: 'var(--nox-text-3)' }}
        >
          {label}
        </span>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}
