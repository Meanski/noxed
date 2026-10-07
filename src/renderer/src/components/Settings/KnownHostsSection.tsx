import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import Card from './Card'
import { useAppStore } from '../../store'
import { ipcErrorMessage, relativeTime } from '../../lib/format'

type TrustedHostKey = Awaited<ReturnType<Window['api']['hostKeys']['list']>>[number]

// SSH host keys noxed has been told to trust. Keys from ~/.ssh/known_hosts are
// honoured too but aren't listed here — noxed never edits that file.
export default function KnownHostsSection() {
  const [hosts, setHosts] = useState<TrustedHostKey[] | null>(null)
  const addNotification = useAppStore((s) => s.addNotification)

  const load = () => {
    window.api.hostKeys.list().then(setHosts, (err: unknown) => {
      setHosts([])
      addNotification({ type: 'error', message: ipcErrorMessage(err, 'Could not load known hosts') })
    })
  }
  useEffect(load, [])

  const remove = async (h: TrustedHostKey) => {
    try {
      await window.api.hostKeys.remove(h.host, h.port, h.keyType)
      load()
    } catch (err) {
      addNotification({ type: 'error', message: ipcErrorMessage(err, 'Could not remove host key') })
    }
  }

  return (
    <Card label="Known Hosts">
      <p className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>
        SSH host keys you&apos;ve trusted in noxed. Removing one means you&apos;ll be asked to verify that host again.
        Hosts in ~/.ssh/known_hosts are trusted automatically.
      </p>
      {hosts === null && <p className="text-[12px]" style={{ color: 'var(--nox-text-3)' }}>Loading…</p>}
      {hosts?.length === 0 && (
        <p className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-3)' }}>No host keys trusted in noxed yet.</p>
      )}
      {hosts && hosts.length > 0 && (
        <ul className="space-y-1.5">
          {hosts.map((h) => (
            <li
              key={`${h.host}:${h.port}:${h.keyType}`}
              className="flex items-center gap-3 px-3 py-2 rounded"
              style={{ background: 'var(--nox-sidebar)' }}
            >
              <div className="min-w-0 flex-1">
                <div className="font-['Inter'] text-[12.5px] font-medium truncate" style={{ color: 'var(--nox-text)' }}>
                  {h.port === 22 ? h.host : `${h.host}:${h.port}`}
                  <span className="ml-2 font-normal text-[11px]" style={{ color: 'var(--nox-text-3)' }}>
                    {h.keyType} · added {relativeTime(h.addedAt)}
                  </span>
                </div>
                <div className="font-['JetBrains_Mono'] text-[10.5px] truncate" style={{ color: 'var(--nox-text-2)' }}>
                  {h.fingerprint}
                </div>
              </div>
              <button
                type="button"
                onClick={() => remove(h)}
                aria-label={`Remove ${h.keyType} host key for ${h.port === 22 ? h.host : `${h.host}:${h.port}`}`}
                className="p-1.5 rounded hover:bg-[var(--nox-hover)]"
                style={{ color: 'var(--nox-text-2)' }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
