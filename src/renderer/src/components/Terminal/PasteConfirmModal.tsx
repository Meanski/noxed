import { useState } from 'react'
import Modal, { ModalButton } from '../Modal'
import { ipcErrorMessage } from '../../lib/format'
import { useAppStore } from '../../store'

const PREVIEW_LINES = 8

interface PasteConfirmModalProps {
  text: string
  onPaste: () => void
  onCancel: () => void
}

export default function PasteConfirmModal({ text, onPaste, onCancel }: Readonly<PasteConfirmModalProps>) {
  const [dontAsk, setDontAsk] = useState(false)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  // A trailing newline still runs the last line, but isn't a line of its own.
  const lineCount = lines.at(-1) === '' ? lines.length - 1 : lines.length
  const hidden = lines.length - PREVIEW_LINES

  const paste = () => {
    if (dontAsk) {
      window.api.settings
        .set('confirmMultilinePaste', false)
        .then(() => window.dispatchEvent(new CustomEvent('noxed:settings-changed')))
        .catch((err: unknown) => {
          useAppStore.getState().addNotification({ type: 'warning', message: ipcErrorMessage(err, 'Could not save paste preference') })
        })
    }
    onPaste()
  }

  return (
    <Modal
      title={lineCount === 1 ? 'Paste a line that ends with Enter?' : `Paste ${lineCount} lines?`}
      onClose={onCancel}
      width={520}
      footer={
        <>
          <ModalButton onClick={onCancel}>Cancel</ModalButton>
          <ModalButton variant="primary" onClick={paste} initialFocus>Paste</ModalButton>
        </>
      }
    >
      <p>Each line will run as a command as soon as it&apos;s pasted.</p>
      <pre
        className="font-['JetBrains_Mono'] text-[11.5px] px-3 py-2 rounded max-h-48 overflow-auto whitespace-pre-wrap break-all select-text"
        style={{ background: 'var(--nox-sidebar)', color: 'var(--nox-text)' }}
      >
        {lines.slice(0, PREVIEW_LINES).join('\n')}
        {hidden > 0 && `\n… ${hidden} more line${hidden === 1 ? '' : 's'}`}
      </pre>
      <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--nox-text)' }}>
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        <span>Don&apos;t ask again (change in Settings → Terminal)</span>
      </label>
    </Modal>
  )
}
