import { Eye, EyeOff, Fingerprint, Key, Lock } from 'lucide-react'
import { FormField, FormInput, FormSelect, storedPasswordPlaceholder } from './FormControls'
import { ACCENT } from '../../lib/colors'

type AuthType = 'password' | 'key' | 'agent'

interface SshFieldsForm {
  username: string
  authType: AuthType
  password: string
  showPassword: boolean
  keyPath: string
  jumpHostId: string
}

type SetField = (field: string, value: string | boolean) => void

interface SshFieldsProps {
  form: SshFieldsForm
  set: SetField
  isEditing: boolean
  hasExistingPassword: boolean
  jumpHostCandidates: { id: string; label?: string; host: string }[]
}

/** A password field with a show/hide toggle. */
export function PasswordInput({ form, set, placeholder }: Readonly<{
  form: { password: string; showPassword: boolean }
  set: SetField
  placeholder: string
}>) {
  return (
    <div className="relative">
      <FormInput
        type={form.showPassword ? 'text' : 'password'}
        placeholder={placeholder}
        value={form.password}
        onChange={e => set('password', e.target.value)}
      />
      <button
        type="button"
        onClick={() => set('showPassword', !form.showPassword)}
        aria-label={form.showPassword ? 'Hide password' : 'Show password'}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors hover:text-[var(--nox-text)]"
        style={{ color: 'var(--nox-text-2)' }}
      >
        {form.showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}

function AuthButton({ form, set, value, icon: Icon, label }: Readonly<{
  form: { authType: string }
  set: SetField
  value: AuthType
  icon: typeof Key
  label: string
}>) {
  const active = form.authType === value
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => set('authType', value)}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] font-medium transition-colors"
      style={active ? { background: ACCENT, color: '#fff' } : { border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  )
}

// Login fields for SSH and SFTP connections: user, how to authenticate, and
// an optional jump host.
export default function SshFields({ form, set, isEditing, hasExistingPassword, jumpHostCandidates }: Readonly<SshFieldsProps>) {
  return (
    <>
      <FormField label="Username">
        <FormInput
          placeholder="root"
          value={form.username}
          onChange={e => set('username', e.target.value)}
        />
      </FormField>

      <div>
        <span className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold block mb-2" style={{ color: 'var(--nox-text-3)' }}>
          Authentication Method
        </span>
        <div className="flex items-center gap-2">
          <AuthButton form={form} set={set} value="key" icon={Key} label="Private Key" />
          <AuthButton form={form} set={set} value="password" icon={Lock} label="Password" />
          <AuthButton form={form} set={set} value="agent" icon={Fingerprint} label="SSH Agent" />
        </div>
      </div>

      {form.authType === 'password' && (
        <FormField label="Password">
          <PasswordInput form={form} set={set} placeholder={storedPasswordPlaceholder(isEditing, hasExistingPassword, 'Enter password')} />
        </FormField>
      )}

      {form.authType === 'agent' && (
        <p className="font-['Inter'] text-[11px]" style={{ color: 'var(--nox-text-2)' }}>
          Uses your SSH agent, then any passphrase-free id_rsa, id_ecdsa or id_ed25519 key in ~/.ssh.
        </p>
      )}

      {form.authType === 'key' && (
        <FormField label="Private Key Path">
          <FormInput
            placeholder="~/.ssh/id_ed25519"
            value={form.keyPath}
            onChange={e => set('keyPath', e.target.value)}
          />
        </FormField>
      )}

      {jumpHostCandidates.length > 0 && (
        <FormField label="Connect via (jump host)">
          <FormSelect value={form.jumpHostId} onChange={e => set('jumpHostId', e.target.value)}>
            <option value="">None — connect directly</option>
            {jumpHostCandidates.map(s => (
              <option key={s.id} value={s.id}>{s.label || s.host}</option>
            ))}
          </FormSelect>
        </FormField>
      )}
    </>
  )
}
