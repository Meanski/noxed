import { useEffect, useState } from 'react'
import Modal, { ModalButton } from '../Modal'
import { ipcErrorMessage } from '../../lib/format'
import { withRequest, withoutRequest } from '../../lib/requestQueue'
import { useAppStore } from '../../store'

type ApprovalRequest = Parameters<Parameters<Window['api']['mcp']['onApproval']>[0]>[0]
type Decision = Parameters<Window['api']['mcp']['respond']>[1]

const TITLES: Record<ApprovalRequest['kind'], string> = {
  command: 'Claude Code wants to run a command',
  read: 'Claude Code wants to read files',
}

// Every MCP request (from Claude Code or any MCP client noxed was set up with)
// waits here for the user. Requests queue and are answered in order.
export default function McpApprovalPrompt() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([])
  const isLocked = useAppStore((s) => s.isLocked)

  useEffect(() => {
    const offApproval = window.api.mcp.onApproval((request) => setQueue((q) => [...q, request]))
    const offDismiss = window.api.mcp.onApprovalDismiss((requestId) => setQueue(withoutRequest(requestId)))
    return () => {
      offApproval()
      offDismiss()
    }
  }, [])

  const current = queue[0]
  if (!current || isLocked) return null

  const answer = (decision: Decision) => {
    const answered = current
    setQueue(withoutRequest(answered.requestId))
    window.api.mcp.respond(answered.requestId, decision).catch((err: unknown) => {
      useAppStore.getState().addNotification({ type: 'error', message: ipcErrorMessage(err, 'Could not send your answer') })
      setQueue(withRequest(answered))
    })
  }
  const isCommand = current.kind === 'command'

  return (
    <Modal
      key={current.requestId}
      title={TITLES[current.kind]}
      tone={isCommand ? 'danger' : undefined}
      onClose={() => answer('deny')}
      footer={
        <>
          <ModalButton onClick={() => answer('deny')} initialFocus>Deny</ModalButton>
          <ModalButton onClick={() => answer('session')}>Allow for this session</ModalButton>
          <ModalButton variant={isCommand ? 'danger' : 'primary'} onClick={() => answer('once')}>Allow once</ModalButton>
        </>
      }
    >
      <p className="mb-2">
        On <strong>{current.connection}</strong>{isCommand ? ', it would run:' : ':'}
      </p>
      <code
        className="block font-['JetBrains_Mono'] text-[12px] px-2.5 py-2 rounded whitespace-pre-wrap break-all select-text"
        style={{ background: 'var(--nox-sidebar)', color: 'var(--nox-text)' }}
      >
        {current.detail}
      </code>
      <p className="mt-3 text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>
        &ldquo;Allow for this session&rdquo; approves every {isCommand ? 'command' : 'read'} on {current.connection} until noxed quits or Claude Code access is turned off.
      </p>
      {queue.length > 1 && (
        <p className="mt-1 text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>{queue.length - 1} more waiting.</p>
      )}
    </Modal>
  )
}
