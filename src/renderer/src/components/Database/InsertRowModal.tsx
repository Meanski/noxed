import { useState } from 'react'
import Modal, { ModalButton } from '../Modal'
import { coerceForColumn, type QueryParam } from '../../lib/dbSql'
import type { TableColumn } from './types'

interface InsertRowModalProps {
  table: string
  columns: TableColumn[]
  onInsert: (values: Record<string, QueryParam>) => Promise<boolean>
  onClose: () => void
}

const FORM_ID = 'insert-row-form'

// One field per column. Blank fields are left out of the INSERT so the
// database applies its default (serial ids, timestamps, NULL).
export default function InsertRowModal({ table, columns, onInsert, onClose }: Readonly<InsertRowModalProps>) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    // Table column order, so the INSERT is the same however fields were filled.
    const filled = Object.fromEntries(columns
      .filter((c) => (values[c.name] ?? '') !== '')
      .map((c) => [c.name, coerceForColumn(values[c.name], c.type)]))
    setBusy(true)
    const ok = await onInsert(filled)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Modal
      title={`Add row to ${table}`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" type="submit" form={FORM_ID} disabled={busy}>{busy ? 'Adding…' : 'Add row'}</ModalButton>
        </>
      }
    >
      <p>Leave a field blank to use the column&apos;s default.</p>
      <form
        id={FORM_ID}
        className="space-y-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {columns.map((col, i) => (
          <label key={col.name} className="block">
            <span className="flex items-baseline gap-2 text-[11.5px] mb-1">
              <span className="font-['JetBrains_Mono']" style={{ color: 'var(--nox-text)' }}>{col.name}</span>
              <span className="text-[10.5px]" style={{ color: 'var(--nox-text-2)' }}>
                {col.type}{col.nullable ? '' : ' · required'}
              </span>
            </span>
            <input
              data-autofocus={i === 0 ? '' : undefined}
              value={values[col.name] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [col.name]: e.target.value }))}
              placeholder="default"
              spellCheck={false}
              className="w-full px-2.5 py-1.5 rounded-md text-[12px] font-['JetBrains_Mono'] outline-none"
              style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
            />
          </label>
        ))}
      </form>
    </Modal>
  )
}
