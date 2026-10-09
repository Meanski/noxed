import { useState } from 'react'
import Modal, { ModalButton } from '../Modal'

export type ExportFormat = 'csv' | 'json' | 'sql'

const FORMATS: { value: ExportFormat; label: string; description: string }[] = [
  { value: 'csv', label: 'CSV', description: 'Opens in spreadsheets; re-importable here' },
  { value: 'json', label: 'JSON', description: 'An array of row objects' },
  { value: 'sql', label: 'SQL', description: 'INSERT statements for this table' },
]

interface ExportTableModalProps {
  table: string
  onExport: (format: ExportFormat) => void
  onClose: () => void
}

export default function ExportTableModal({ table, onExport, onClose }: Readonly<ExportTableModalProps>) {
  const [format, setFormat] = useState<ExportFormat>('csv')
  return (
    <Modal
      title={`Export ${table}`}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" initialFocus onClick={() => onExport(format)}>Choose file…</ModalButton>
        </>
      }
    >
      <p>Exports every row of the table (up to 200,000), not just the rows on screen.</p>
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Format</legend>
        {FORMATS.map((f) => (
          <label key={f.value} className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--nox-text)' }}>
            <input type="radio" name="export-format" aria-label={f.label} className="mt-0.5" checked={format === f.value} onChange={() => setFormat(f.value)} />
            <span>
              <span className="font-medium">{f.label}</span>
              <span className="ml-1.5 text-[11px]" style={{ color: 'var(--nox-text-2)' }}>{f.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Modal>
  )
}
