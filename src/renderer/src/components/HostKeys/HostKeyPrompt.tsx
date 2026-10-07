import { useEffect, useState } from 'react'
import Modal, { ModalButton } from '../Modal'
import { ipcErrorMessage } from '../../lib/format'
import { useAppStore } from '../../store'

type HostKeyPromptRequest = Parameters<Parameters<Window['api']['hostKeys']['onPrompt']>[0]>[0]
type Decision = Parameters<Window['api']['hostKeys']['respond']>[1]

const withoutRequest = (requestId: string) => (queue: HostKeyPromptRequest[]) =>
  queue.filter((p) => p.requestId !== requestId)

// Where sshd keeps the public host key for each algorithm family.
function hostKeyFile(keyType: string): string {
  if (keyType.includes('ed25519')) return '/etc/ssh/ssh_host_ed25519_key.pub'
  if (keyType.startsWith('ecdsa')) return '/etc/ssh/ssh_host_ecdsa_key.pub'
  return '/etc/ssh/ssh_host_rsa_key.pub'
}

function hostLabel(p: HostKeyPromptRequest): string {
  return p.port === 22 ? p.host : `${p.host}:${p.port}`
}

function Fingerprint({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div>
      <div className="text-[11px] mb-1" style={{ color: 'var(--nox-text-3)' }}>{label}</div>
      <code
        className="block font-['JetBrains_Mono'] text-[11.5px] px-2.5 py-1.5 rounded break-all select-text"
        style={{ background: 'var(--nox-sidebar)', color: 'var(--nox-text)' }}
      >
        {value}
      </code>
    </div>
  )
}

// Main asks before trusting an unknown or changed SSH host key. Prompts queue
// (the runner can hit several new hosts at once) and are answered in order.
export default function HostKeyPrompt() {
  const [queue, setQueue] = useState<HostKeyPromptRequest[]>([])
  // Prompts keep queueing while locked but aren't actionable above the lock screen.
  const isLocked = useAppStore((s) => s.isLocked)

  useEffect(() => {
    const offPrompt = window.api.hostKeys.onPrompt((prompt) => setQueue((q) => [...q, prompt]))
    const offDismiss = window.api.hostKeys.onDismiss((requestId) => setQueue(withoutRequest(requestId)))
    return () => {
      offPrompt()
      offDismiss()
    }
  }, [])

  const current = queue[0]
  if (!current || isLocked) return null

  // Removal by id keeps a double click (or Escape racing a click) from
  // consuming the next queued prompt; main ignores the duplicate answer.
  const answer = (decision: Decision) => {
    setQueue(withoutRequest(current.requestId))
    const answered = current
    window.api.hostKeys.respond(answered.requestId, decision).catch((err: unknown) => {
      useAppStore.getState().addNotification({ type: 'error', message: ipcErrorMessage(err, 'Could not send host key decision') })
      // Main still holds the request (e.g. it refused "trust" because the app
      // just auto-locked), so bring the prompt back to retry or reject.
      setQueue((q) => (q.some((p) => p.requestId === answered.requestId) ? q : [answered, ...q]))
    })
  }
  const reject = () => answer('reject')

  if (current.status === 'revoked') {
    return (
      <Modal
        key={current.requestId}
        title={`Host key revoked for ${hostLabel(current)}`}
        tone="danger"
        onClose={reject}
        footer={<ModalButton onClick={reject} initialFocus>Close</ModalButton>}
      >
        <p>
          This {current.keyType} key is marked <code className="font-['JetBrains_Mono']">@revoked</code> in
          ~/.ssh/known_hosts, so noxed won&apos;t connect with it.
        </p>
        <Fingerprint label="Revoked fingerprint" value={current.fingerprint} />
      </Modal>
    )
  }

  if (current.status === 'changed') {
    return (
      <Modal
        key={current.requestId}
        title={`Host key changed for ${hostLabel(current)}`}
        tone="danger"
        onClose={reject}
        width={480}
        footer={
          <>
            <ModalButton onClick={reject} initialFocus>Cancel connection</ModalButton>
            <ModalButton variant="danger" onClick={() => answer('trust')}>Replace key and connect</ModalButton>
          </>
        }
      >
        <p>
          The {current.keyType} key this server presented doesn&apos;t match the one you trusted before.
          Someone could be intercepting the connection, or the server may have been rebuilt or had its key rotated.
          Only continue if you know why the key changed.
        </p>
        <Fingerprint label="New fingerprint" value={current.fingerprint} />
        {current.knownFingerprints.map((fp) => (
          <Fingerprint key={fp} label="Previously trusted" value={fp} />
        ))}
      </Modal>
    )
  }

  return (
    <Modal
      key={current.requestId}
      title={`Trust ${hostLabel(current)}?`}
      onClose={reject}
      footer={
        <>
          <ModalButton onClick={reject}>Cancel</ModalButton>
          <ModalButton onClick={() => answer('once')}>Connect once</ModalButton>
          <ModalButton variant="primary" onClick={() => answer('trust')} initialFocus>Trust and connect</ModalButton>
        </>
      }
    >
      <p>
        noxed hasn&apos;t seen this {current.keyType} key for this host before. Check the fingerprint against the
        one your server administrator gave you, or run{' '}
        <code className="font-['JetBrains_Mono'] break-all">ssh-keygen -lf {hostKeyFile(current.keyType)}</code>{' '}
        on the server, before trusting it.
      </p>
      <Fingerprint label={`${current.keyType} fingerprint`} value={current.fingerprint} />
      {current.otherKeyTypes.length > 0 && (
        <p className="text-[11.5px]">
          This host is already trusted with a different key type ({current.otherKeyTypes.join(', ')}).
        </p>
      )}
    </Modal>
  )
}
