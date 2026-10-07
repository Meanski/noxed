import { useEffect, useState } from 'react'
import Modal, { ModalButton } from '../Modal'
import { ipcErrorMessage } from '../../lib/format'
import { useAppStore } from '../../store'

type HostKeyPromptRequest = Parameters<Parameters<Window['api']['hostKeys']['onPrompt']>[0]>[0]
type Decision = Parameters<Window['api']['hostKeys']['respond']>[1]

const withoutRequest = (requestId: string) => (queue: HostKeyPromptRequest[]) =>
  queue.filter((p) => p.requestId !== requestId)

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

  useEffect(() => {
    const offPrompt = window.api.hostKeys.onPrompt((prompt) => setQueue((q) => [...q, prompt]))
    const offDismiss = window.api.hostKeys.onDismiss((requestId) => setQueue(withoutRequest(requestId)))
    return () => {
      offPrompt()
      offDismiss()
    }
  }, [])

  const current = queue[0]
  if (!current) return null

  const answer = (decision: Decision) => {
    setQueue((q) => q.slice(1))
    window.api.hostKeys.respond(current.requestId, decision).catch((err: unknown) => {
      useAppStore.getState().addNotification({ type: 'error', message: ipcErrorMessage(err, 'Could not send host key decision') })
    })
  }
  const reject = () => answer('reject')

  if (current.status === 'changed') {
    return (
      <Modal
        title={`Host key changed for ${hostLabel(current)}`}
        tone="danger"
        onClose={reject}
        width={480}
        footer={
          <>
            <ModalButton onClick={reject} autoFocus>Cancel connection</ModalButton>
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
      title={`Trust ${hostLabel(current)}?`}
      onClose={reject}
      footer={
        <>
          <ModalButton onClick={reject}>Cancel</ModalButton>
          <ModalButton onClick={() => answer('once')}>Connect once</ModalButton>
          <ModalButton variant="primary" onClick={() => answer('trust')} autoFocus>Trust and connect</ModalButton>
        </>
      }
    >
      <p>
        noxed hasn&apos;t connected to this host before. Check the fingerprint against the one your server
        administrator gave you (or <code className="font-['JetBrains_Mono']">ssh-keygen -lf</code> on the server) before trusting it.
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
