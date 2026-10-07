// Label/description on the left, control on the right — one Settings line.
export default function Row({ label, description, children }: Readonly<{
  label: string
  description?: string
  children: React.ReactNode
}>) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <span className="font-['Inter'] text-[13px] font-medium" style={{ color: 'var(--nox-text)' }}>{label}</span>
        {description && (
          <p className="font-['Inter'] text-[11.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>{description}</p>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}
