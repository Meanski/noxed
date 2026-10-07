import { useState } from 'react'
import Modal, { ModalButton } from '../Modal'
import { ipcErrorMessage } from '../../lib/format'

interface MongoDocumentModalProps {
  title: string
  /** Extended JSON to start from. */
  initial: string
  /** Saves the edited Extended JSON; rejects to keep the editor open with the error. */
  onSave: (json: string) => Promise<void>
  onClose: () => void
}

const FORM_ID = 'mongo-document-form'

// A JSON editor for inserting or replacing one document. Extended JSON
// ({"$oid": …}, {"$date": …}) keeps ObjectIds and dates typed.
export default function MongoDocumentModal({ title, initial, onSave, onClose }: Readonly<MongoDocumentModalProps>) {
  const [text, setText] = useState(initial)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    try {
      JSON.parse(text)
    } catch (err) {
      setError(`Not valid JSON: ${ipcErrorMessage(err)}`)
      return
    }
    setSaving(true)
    try {
      await onSave(text)
      onClose()
    } catch (err) {
      setError(ipcErrorMessage(err, 'Could not save the document'))
      setSaving(false)
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" type="submit" form={FORM_ID} disabled={saving}>{saving ? 'Saving…' : 'Save'}</ModalButton>
        </>
      }
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <textarea
          data-autofocus
          aria-label="Document JSON"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError('')
          }}
          spellCheck={false}
          rows={16}
          className="w-full rounded-md px-3 py-2 font-['JetBrains_Mono'] text-[12px] outline-none"
          style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
        />
        {error && <p role="alert" className="mt-2 text-[11.5px]" style={{ color: 'var(--nox-danger-text)' }}>{error}</p>}
      </form>
    </Modal>
  )
}
