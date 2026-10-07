import Modal, { ModalButton } from '../Modal'
import { toEditable } from '../../lib/dbSql'

interface DeleteRowModalProps {
  table: string
  primaryKey: string[]
  row: Record<string, unknown>
  onConfirm: () => void
  onCancel: () => void
}

// Names the row by its primary key so the user sees exactly what goes.
export default function DeleteRowModal({ table, primaryKey, row, onConfirm, onCancel }: Readonly<DeleteRowModalProps>) {
  return (
    <Modal
      title={`Delete row from ${table}?`}
      tone="danger"
      onClose={onCancel}
      footer={
        <>
          <ModalButton onClick={onCancel} initialFocus>Cancel</ModalButton>
          <ModalButton variant="danger" onClick={onConfirm}>Delete row</ModalButton>
        </>
      }
    >
      <p>This permanently deletes the row with:</p>
      <ul className="font-['JetBrains_Mono'] text-[11.5px] space-y-0.5" style={{ color: 'var(--nox-text)' }}>
        {primaryKey.map((col) => (
          <li key={col}>{col} = {toEditable(row[col])}</li>
        ))}
      </ul>
    </Modal>
  )
}
