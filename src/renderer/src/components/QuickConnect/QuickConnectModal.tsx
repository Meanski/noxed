import { useState } from 'react'
import Modal, { ModalButton } from '../Modal'
import { useAppStore, type Session } from '../../store'
import { parseQuickConnectTarget } from '../../lib/quickConnect'
import { setAdhocPassword } from '../../lib/sshCredentials'
import { ipcErrorMessage } from '../../lib/format'

type AuthChoice = 'agent' | 'password' | 'key'

// The footer's Connect button joins the form through the `form` attribute, so
// Enter in any field submits it natively.
const FORM_ID = 'quick-connect-form'

interface QuickConnectModalProps {
  initialTarget: string
  onClose: () => void
}

const AUTH_OPTIONS: { value: AuthChoice; label: string }[] = [
  { value: 'agent', label: 'SSH agent / keys' },
  { value: 'password', label: 'Password' },
  { value: 'key', label: 'Key file' },
]

const inputStyle: React.CSSProperties = {
  background: 'var(--nox-bg)',
  border: '1px solid var(--nox-border)',
  color: 'var(--nox-text)',
}

function Field({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <label className="block">
      <span className="block text-[11px] mb-1" style={{ color: 'var(--nox-text-2)' }}>{label}</span>
      {children}
    </label>
  )
}

// Connect to a host without saving it first — what `ssh user@host` is in a
// shell. The session lives only while its tabs are open unless "Save" is ticked.
export default function QuickConnectModal({ initialTarget, onClose }: Readonly<QuickConnectModalProps>) {
  const [target, setTarget] = useState(initialTarget)
  const [username, setUsername] = useState('')
  const [auth, setAuth] = useState<AuthChoice>('agent')
  const [password, setPassword] = useState('')
  const [keyPath, setKeyPath] = useState('~/.ssh/id_ed25519')
  const [save, setSave] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const parsed = parseQuickConnectTarget(target)
  const needsUsername = parsed !== null && parsed.username === ''
  const user = needsUsername ? username.trim() : (parsed?.username ?? '')
  const credentialsComplete = (auth !== 'key' || keyPath.trim() !== '') && (auth !== 'password' || password !== '')
  const canConnect = parsed !== null && user !== '' && !busy && credentialsComplete

  const connect = async () => {
    if (!parsed || !canConnect) return
    const label = parsed.port === 22 ? `${user}@${parsed.host}` : `${user}@${parsed.host}:${parsed.port}`
    const base = {
      label,
      host: parsed.host,
      port: parsed.port,
      username: user,
      authType: auth,
      keyPath: auth === 'key' ? keyPath.trim() : undefined,
      type: 'ssh',
    } as const
    const state = useAppStore.getState()

    if (save) {
      setBusy(true)
      try {
        const saved: Session = await window.api.sessions.create({ ...base, password: auth === 'password' ? password : undefined })
        state.addSession(saved)
        state.openTab(saved)
        onClose()
      } catch (err) {
        setError(ipcErrorMessage(err, 'Could not save the connection'))
        setBusy(false)
      }
      return
    }

    const session: Session = { ...base, id: `adhoc-${crypto.randomUUID()}`, createdAt: Date.now() }
    if (auth === 'password') setAdhocPassword(session.id, password)
    state.openAdhocSession(session)
    onClose()
  }

  return (
    <Modal
      title="Quick connect"
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" type="submit" form={FORM_ID} disabled={!canConnect}>Connect</ModalButton>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          connect()
        }}
      >
        <Field label="Host">
          <input
            data-autofocus
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="user@host:port or ssh user@host -p 2222"
            spellCheck={false}
            className="w-full px-2.5 py-1.5 rounded-md text-[12.5px] font-['JetBrains_Mono'] outline-none"
            style={inputStyle}
          />
        </Field>
        {target.trim() !== '' && parsed === null && (
          <p className="text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>That doesn&apos;t look like a host.</p>
        )}
        {needsUsername && (
          <Field label="Username">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              spellCheck={false}
              className="w-full px-2.5 py-1.5 rounded-md text-[12.5px] outline-none"
              style={inputStyle}
            />
          </Field>
        )}
        <fieldset>
          <legend className="text-[11px] mb-1" style={{ color: 'var(--nox-text-2)' }}>Authentication</legend>
          <div className="flex gap-3">
            {AUTH_OPTIONS.map((o) => (
              <label key={o.value} className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--nox-text)' }}>
                <input type="radio" name="quick-auth" checked={auth === o.value} onChange={() => setAuth(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {auth === 'password' && (
          <Field label="Password">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-md text-[12.5px] outline-none"
              style={inputStyle}
            />
          </Field>
        )}
        {auth === 'key' && (
          <Field label="Private key">
            <input
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              spellCheck={false}
              className="w-full px-2.5 py-1.5 rounded-md text-[12.5px] font-['JetBrains_Mono'] outline-none"
              style={inputStyle}
            />
          </Field>
        )}
        {auth === 'agent' && (
          <p className="text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>Uses your SSH agent, then unencrypted keys in ~/.ssh — the same as running ssh.</p>
        )}
        <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--nox-text)' }}>
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          <span>Save to connections</span>
        </label>
        {error && <p className="text-[11.5px]" style={{ color: 'var(--nox-danger-text)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  )
}
