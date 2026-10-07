// Form building blocks shared by the add/edit connection forms.

export function FormField({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div>
      <label className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold block mb-1.5" style={{ color: 'var(--nox-text-3)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

export function FormInput({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement> & { className?: string }) {
  return (
    <input
      {...props}
      className={`w-full rounded-md px-3 py-2 font-['Inter'] text-[12.5px] focus:outline-none focus:ring-1 focus:ring-[#3B5CCC] ${className}`}
      style={{
        background: 'var(--nox-bg)',
        border: '1px solid var(--nox-border)',
        color: 'var(--nox-text)',
        ...(props as any).style,
      }}
    />
  )
}

export function FormSelect({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      {...props}
      className="w-full rounded-md px-3 py-2 font-['Inter'] text-[12.5px] focus:outline-none focus:ring-1 focus:ring-[#3B5CCC]"
      style={{
        background: 'var(--nox-bg)',
        border: '1px solid var(--nox-border)',
        color: 'var(--nox-text)',
      }}
    >
      {children}
    </select>
  )
}

export function storedPasswordPlaceholder(isEditing: boolean, hasExistingPassword: boolean, fallback: string): string {
  return isEditing && hasExistingPassword ? '••••••••  (leave blank to keep)' : fallback
}
