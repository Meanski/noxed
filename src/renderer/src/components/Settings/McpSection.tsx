import { useEffect, useState } from 'react'
import { Copy, RefreshCw } from 'lucide-react'
import Card from './Card'
import Row from './Row'
import Toggle from './Toggle'
import { useAppStore } from '../../store'
import { ipcErrorMessage } from '../../lib/format'

type McpStatus = Awaited<ReturnType<Window['api']['mcp']['status']>>

function notifyError(err: unknown, fallback: string) {
  useAppStore.getState().addNotification({ type: 'error', message: ipcErrorMessage(err, fallback) })
}

// Lets Claude Code (or any MCP client) use noxed's saved SSH servers, with
// every command and file read approved in noxed.
export default function McpSection() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [command, setCommand] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Bumped when the token changes, so the shown command follows it.
  const [tokenVersion, setTokenVersion] = useState(0)

  useEffect(() => {
    window.api.mcp.status().then(setStatus, (err: unknown) => notifyError(err, 'Could not read Claude Code access'))
  }, [])

  useEffect(() => {
    if (!status?.enabled) {
      setCommand(null)
      return
    }
    window.api.mcp.connectionInfo().then((info) => setCommand(info.command), (err: unknown) => notifyError(err, 'Could not read the setup command'))
  }, [status?.enabled, status?.port, tokenVersion])

  const act = async (action: () => Promise<McpStatus>, fallback: string) => {
    setBusy(true)
    try {
      setStatus(await action())
    } catch (err) {
      notifyError(err, fallback)
    } finally {
      setBusy(false)
    }
  }

  const copy = () => {
    if (!command) return
    navigator.clipboard.writeText(command).then(
      () => useAppStore.getState().addNotification({ type: 'success', message: 'Setup command copied. Run it in a terminal.' }),
      (err: unknown) => notifyError(err, 'Could not copy'),
    )
  }

  return (
    <Card label="Claude Code (MCP)">
      <Row
        label="Allow Claude Code to use noxed"
        description="Runs a local MCP server so Claude Code can list your SSH servers, run commands and read files. You approve every request in noxed."
      >
        <Toggle
          label="Allow Claude Code to use noxed"
          on={status?.enabled ?? false}
          disabled={busy || status === null}
          onChange={(v) => act(() => window.api.mcp.setEnabled(v), 'Could not change Claude Code access')}
        />
      </Row>
      {status?.error && (
        <p role="alert" className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-danger-text)' }}>{status.error}</p>
      )}
      {status?.running && (
        <p className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>
          Listening on 127.0.0.1:{status.port}, for this computer only.
        </p>
      )}
      {command && (
        <div className="space-y-2">
          <p className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>
            Run this once to add noxed to Claude Code. It contains a secret token, so don't share it.
          </p>
          <div className="flex items-start gap-2">
            <code
              className="flex-1 min-w-0 block font-['JetBrains_Mono'] text-[11px] px-2.5 py-1.5 rounded break-all select-text"
              style={{ background: 'var(--nox-sidebar)', color: 'var(--nox-text)' }}
            >
              {command}
            </code>
            <button type="button" onClick={copy} aria-label="Copy setup command" title="Copy" className="p-1.5 rounded hover:bg-[var(--nox-hover)]" style={{ color: 'var(--nox-text-2)' }}>
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => act(async () => {
              const next = await window.api.mcp.regenerateToken()
              setTokenVersion((v) => v + 1)
              return next
            }, 'Could not create a new token')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-['Inter'] text-[12px] disabled:opacity-50"
            style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
          >
            <RefreshCw className="w-3.5 h-3.5" /> New token
          </button>
          <p className="font-['Inter'] text-[11px]" style={{ color: 'var(--nox-text-2)' }}>
            A new token disconnects clients set up with the old one.
          </p>
        </div>
      )}
    </Card>
  )
}
