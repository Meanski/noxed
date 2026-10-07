import { FolderOpen } from 'lucide-react'
import { FormField, FormInput, FormSelect, storedPasswordPlaceholder } from './FormControls'
import { ipcErrorMessage } from '../../lib/format'
import { useAppStore } from '../../store'

interface DatabaseFieldsProps {
  form: { dbType: string; databaseName: string; username: string; password: string; sslMode: string; filePath: string; authSource: string; mongoSrv: boolean }
  set: (field: string, value: string | boolean) => void
  isEditing: boolean
  hasExistingPassword: boolean
}

const DB_TYPES = [
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'mariadb', label: 'MariaDB' },
  { value: 'mssql', label: 'SQL Server' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'mongodb', label: 'MongoDB' },
]

/** Default server port per engine; SQLite is a file and has none. */
export function defaultDatabasePort(dbType: string): string {
  if (dbType === 'mysql' || dbType === 'mariadb') return '3306'
  if (dbType === 'mssql') return '1433'
  if (dbType === 'mongodb') return '27017'
  return '5432'
}

function SqliteFileField({ filePath, set }: Readonly<{ filePath: string; set: DatabaseFieldsProps['set'] }>) {
  const browse = () => {
    window.api.database.pickSqliteFile().then(
      (path) => { if (path) set('filePath', path) },
      (err: unknown) => useAppStore.getState().addNotification({ type: 'error', message: ipcErrorMessage(err, 'Could not open the file picker') }),
    )
  }
  return (
    <FormField label="Database File">
      <div className="flex gap-2">
        <FormInput placeholder="~/data/app.sqlite" value={filePath} onChange={(e) => set('filePath', e.target.value)} className="font-mono" />
        <button
          type="button"
          onClick={browse}
          className="flex items-center gap-1.5 px-3 rounded-md font-['Inter'] text-[12px] flex-shrink-0 hover:bg-[var(--nox-hover)]"
          style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
        >
          <FolderOpen className="w-3.5 h-3.5" /> Browse…
        </button>
      </div>
    </FormField>
  )
}

function MongoFields({ form, set, isEditing, hasExistingPassword }: Readonly<DatabaseFieldsProps>) {
  return (
    <>
      <label className="flex items-center gap-2 font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text)' }}>
        <input type="checkbox" checked={form.mongoSrv} onChange={(e) => set('mongoSrv', e.target.checked)} />
        <span>DNS seed list (<code>mongodb+srv://</code>, e.g. Atlas); the port is ignored</span>
      </label>
      <FormField label="Username (optional)">
        <FormInput value={form.username} onChange={(e) => set('username', e.target.value)} />
      </FormField>
      <FormField label="Password">
        <FormInput
          type="password"
          placeholder={storedPasswordPlaceholder(isEditing, hasExistingPassword, 'Leave blank if there is no login')}
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
        />
      </FormField>
      <FormField label="Auth Database (optional)">
        <FormInput placeholder="admin" value={form.authSource} onChange={(e) => set('authSource', e.target.value)} />
      </FormField>
      <FormField label="TLS">
        <FormSelect value={form.sslMode === 'disable' ? 'disable' : 'require'} onChange={(e) => set('sslMode', e.target.value)}>
          <option value="disable">Off</option>
          <option value="require">On (verify the certificate)</option>
        </FormSelect>
      </FormField>
    </>
  )
}

export default function DatabaseFields({ form, set, isEditing, hasExistingPassword }: Readonly<DatabaseFieldsProps>) {
  return (
    <>
      <FormField label="Database Type">
        <FormSelect value={form.dbType} onChange={(e) => set('dbType', e.target.value)}>
          {DB_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </FormSelect>
      </FormField>
      {form.dbType === 'mongodb' && <MongoFields form={form} set={set} isEditing={isEditing} hasExistingPassword={hasExistingPassword} />}
      {form.dbType === 'sqlite' && <SqliteFileField filePath={form.filePath} set={set} />}
      {form.dbType !== 'sqlite' && form.dbType !== 'mongodb' && (
        <>
          <FormField label="Database Name">
            <FormInput placeholder="mydb" value={form.databaseName} onChange={(e) => set('databaseName', e.target.value)} />
          </FormField>
          <FormField label="Username">
            <FormInput placeholder={form.dbType === 'mssql' ? 'sa' : 'postgres'} value={form.username} onChange={(e) => set('username', e.target.value)} />
          </FormField>
          <FormField label="Password">
            <FormInput
              type="password"
              placeholder={storedPasswordPlaceholder(isEditing, hasExistingPassword, 'Enter password')}
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
            />
          </FormField>
          <FormField label="SSL Mode">
            <FormSelect value={form.sslMode} onChange={(e) => set('sslMode', e.target.value)}>
              <option value="disable">Disable</option>
              <option value="require">Require</option>
              <option value="verify-ca">Verify CA</option>
              <option value="verify-full">Verify Full</option>
            </FormSelect>
          </FormField>
        </>
      )}
    </>
  )
}
