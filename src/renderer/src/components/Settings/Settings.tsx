import { useState, useEffect, useRef } from 'react'
import {
  Settings2, Shield, Terminal, Info, ShieldCheck, Trash2,
  AlertTriangle, Minus, Plus, ChevronRight, Eye, EyeOff,
  Fingerprint, Hash, KeyRound, ShieldOff, Upload, Download,
  RefreshCw, CheckCircle2, RotateCw,
} from 'lucide-react'
import { useAppStore } from '../../store'

type SettingsTab = 'general' | 'security' | 'terminal' | 'about'

export default function Settings() {
  const [tab, setTab] = useState<SettingsTab>('general')
  const [showClearModal, setShowClearModal] = useState(false)

  const navItems: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: 'General', icon: <Settings2 className="w-4 h-4" /> },
    { id: 'security', label: 'Security', icon: <Shield className="w-4 h-4" /> },
    { id: 'terminal', label: 'Terminal', icon: <Terminal className="w-4 h-4" /> },
    { id: 'about', label: 'About', icon: <Info className="w-4 h-4" /> },
  ]

  return (
    <div className="h-full flex overflow-hidden" style={{ background: 'var(--nox-bg)' }}>
      {/* Settings sidebar nav */}
      <div
        className="w-[200px] min-w-[200px] py-4 flex-shrink-0"
        style={{ background: 'var(--nox-shell)', borderRight: '1px solid var(--nox-border)' }}
      >
        <div className="px-4 mb-3">
          <span
            className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: 'var(--nox-text-3)' }}
          >
            Settings
          </span>
        </div>
        <nav className="px-2 space-y-0.5">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-left transition-colors"
              style={{
                background: tab === item.id ? 'var(--nox-active)' : 'transparent',
                color: tab === item.id ? 'var(--nox-active-t)' : 'var(--nox-text)',
              }}
              onMouseEnter={e => { if (tab !== item.id) (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { if (tab !== item.id) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span style={{ color: tab === item.id ? 'var(--nox-active-t)' : 'var(--nox-text-2)' }}>{item.icon}</span>
              <span
                className="font-['Inter'] text-[12.5px]"
                style={{ fontWeight: tab === item.id ? 500 : 400 }}
              >
                {item.label}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* Settings content */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'general' && <GeneralSettings />}
        {tab === 'security' && <SecuritySettings onClear={() => setShowClearModal(true)} />}
        {tab === 'terminal' && <TerminalSettings />}
        {tab === 'about' && <AboutSettings />}
      </div>

      {showClearModal && (
        <ClearCredentialsModal
          onCancel={() => setShowClearModal(false)}
          onConfirm={async () => {
            await window.api.sessions.clearAll()
            setShowClearModal(false)
          }}
        />
      )}
    </div>
  )
}

/* ── Toggle switch ───────────────────────────────────────────────────────── */
function Toggle({ on, onChange }: Readonly<{ on: boolean; onChange: (v: boolean) => void }>) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="w-9 h-5 rounded-full relative transition-colors flex-shrink-0"
      style={{ background: on ? '#3B5CCC' : 'var(--nox-border)' }}
    >
      <div
        className="w-4 h-4 rounded-full absolute top-[2px] shadow-sm transition-all"
        style={{ left: on ? 'calc(100% - 18px)' : '2px', background: on ? '#fff' : 'var(--nox-shell)' }}
      />
    </button>
  )
}

/* ── Row separator ───────────────────────────────────────────────────────── */
const Divider = () => <div style={{ borderTop: '1px solid var(--nox-border)' }} />

/* ── Small bordered action button ────────────────────────────────────────── */
function ActionButton({ icon, label, onClick }: Readonly<{ icon: React.ReactNode; label: string; onClick: () => void }>) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] transition-colors"
      style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <span style={{ color: 'var(--nox-text-2)' }}>{icon}</span>
      {label}
    </button>
  )
}

/* ── Section card ────────────────────────────────────────────────────────── */
function Card({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div
      className="rounded-md p-5"
      style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
    >
      <div className="mb-4">
        <span
          className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold"
          style={{ color: 'var(--nox-text-3)' }}
        >
          {label}
        </span>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

/* ── Row ─────────────────────────────────────────────────────────────────── */
function Row({ label, description, children }: Readonly<{
  label: string
  description?: string
  children: React.ReactNode
}>) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <span className="font-['Inter'] text-[13px] font-medium" style={{ color: 'var(--nox-text)' }}>{label}</span>
        {description && (
          <p className="font-['Inter'] text-[11.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>{description}</p>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

function Select({ options, value, onChange }: Readonly<{ options: string[]; value: string; onChange: (v: string) => void }>) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="rounded-md px-3 py-1.5 font-['Inter'] text-[12.5px] focus:outline-none focus:ring-1 focus:ring-[#3B5CCC] w-44"
      style={{
        background: 'var(--nox-bg)',
        border: '1px solid var(--nox-border)',
        color: 'var(--nox-text)',
      }}
    >
      {options.map(o => <option key={o}>{o}</option>)}
    </select>
  )
}

function useSettings() {
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    window.api.settings.get().then(s => { setSettings(s); setLoaded(true) })
  }, [])
  const update = async (key: string, value: unknown) => {
    const updated = await window.api.settings.set(key, value)
    setSettings(updated)
    window.dispatchEvent(new CustomEvent('noxed:settings-changed'))
  }
  return { settings, loaded, update }
}

/* ── General settings ────────────────────────────────────────────────────── */
function GeneralSettings() {
  const { settings, loaded, update } = useSettings()
  const addNotification = useAppStore(s => s.addNotification)
  const setSessions = useAppStore(s => s.setSessions)

  async function exportConnections() {
    try {
      const result = await window.api.sessions.export()
      if (result.canceled) return
      addNotification({ type: 'success', message: `Exported ${result.exported} connection${result.exported !== 1 ? 's' : ''}` })
    } catch (err: any) {
      addNotification({ type: 'error', message: err?.message ?? 'Export failed' })
    }
  }

  async function importConnections() {
    try {
      const result = await window.api.sessions.import()
      if (result.canceled) return
      setSessions(await window.api.sessions.list())
      const dupWord = result.skipped === 1 ? 'duplicate' : 'duplicates'
      const skippedNote = result.skipped > 0 ? ` (${result.skipped} ${dupWord} skipped)` : ''
      const connWord = result.imported === 1 ? 'connection' : 'connections'
      addNotification({ type: 'success', message: `Imported ${result.imported} ${connWord}${skippedNote}` })
    } catch (err: any) {
      addNotification({ type: 'error', message: err?.message ?? 'Import failed' })
    }
  }

  if (!loaded) return null
  const dateFormat = settings.dateFormat ?? 'YYYY-MM-DD HH:mm'
  const sidebarDefault = settings.sidebarDefault ?? 'expanded'
  const confirmClose = settings.confirmClose ?? true
  const connAlerts = settings.connAlerts ?? true
  const transferAlerts = settings.transferAlerts ?? false
  const resourceAlerts = settings.resourceAlerts ?? true
  const sshKeepalive = settings.sshKeepalive ?? '30 seconds'

  return (
    <div className="p-6 max-w-2xl">
      <div className="mb-6">
        <h1 className="font-['Plus_Jakarta_Sans'] font-bold text-[22px]" style={{ color: 'var(--nox-text)' }}>General</h1>
        <p className="font-['Inter'] text-[12.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
          Application preferences and display settings
        </p>
      </div>

      <div className="space-y-6">
        <Card label="Display">
          <Row label="Date Format" description="How dates are displayed throughout the app">
            <Select
              options={['YYYY-MM-DD HH:mm', 'DD/MM/YYYY HH:mm', 'MM/DD/YYYY h:mm A', 'Relative (e.g. "2 hours ago")']}
              value={dateFormat}
              onChange={v => update('dateFormat', v)}
            />
          </Row>
          <Divider />
          <Row label="Sidebar Default State" description="Whether the sidebar starts expanded or collapsed">
            <div className="flex items-center gap-2">
              <button
                onClick={() => update('sidebarDefault', 'expanded')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[11.5px] font-medium transition-colors"
                style={{
                  background: sidebarDefault === 'expanded' ? '#3B5CCC' : 'transparent',
                  color: sidebarDefault === 'expanded' ? '#fff' : 'var(--nox-text-2)',
                  border: sidebarDefault === 'expanded' ? 'none' : '1px solid var(--nox-border)',
                }}
              >
                Expanded
              </button>
              <button
                onClick={() => update('sidebarDefault', 'collapsed')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[11.5px] font-medium transition-colors"
                style={{
                  background: sidebarDefault === 'collapsed' ? '#3B5CCC' : 'transparent',
                  color: sidebarDefault === 'collapsed' ? '#fff' : 'var(--nox-text-2)',
                  border: sidebarDefault === 'collapsed' ? 'none' : '1px solid var(--nox-border)',
                }}
              >
                Collapsed
              </button>
            </div>
          </Row>
          <Divider />
          <Row label="Confirm Before Closing Tabs" description="Ask before closing active SSH sessions">
            <Toggle on={confirmClose} onChange={v => update('confirmClose', v)} />
          </Row>
        </Card>

        <Card label="Connections">
          <Row label="Keep Connections Alive" description="How often to ping idle SSH sessions so they stay open. Turn off if your server rate-limits idle traffic">
            <Select
              options={['Off', '15 seconds', '30 seconds', '60 seconds']}
              value={sshKeepalive}
              onChange={v => update('sshKeepalive', v)}
            />
          </Row>
          <Divider />
          <Row label="Backup & Restore" description="Export connection settings to a JSON file or import them back. Passwords stay in the OS keychain and are never exported">
            <div className="flex items-center gap-2">
              <ActionButton icon={<Upload className="w-3.5 h-3.5" />} label="Export" onClick={exportConnections} />
              <ActionButton icon={<Download className="w-3.5 h-3.5" />} label="Import" onClick={importConnections} />
            </div>
          </Row>
        </Card>

        <Card label="Notifications">
          <Row label="Connection Alerts" description="Notify when connections drop or reconnect">
            <Toggle on={connAlerts} onChange={v => update('connAlerts', v)} />
          </Row>
          <Divider />
          <Row label="Transfer Notifications" description="Notify when file transfers complete or fail">
            <Toggle on={transferAlerts} onChange={v => update('transferAlerts', v)} />
          </Row>
          <Divider />
          <Row label="Resource Alerts" description="Warn when a connected server pins its CPU or the root disk passes 90% full">
            <Toggle on={resourceAlerts} onChange={v => update('resourceAlerts', v)} />
          </Row>
        </Card>
      </div>
    </div>
  )
}

/* ── Security settings ───────────────────────────────────────────────────── */
function SecuritySettings({ onClear }: Readonly<{ onClear: () => void }>) {
  const { settings, loaded, update } = useSettings()
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [currentMode, setCurrentMode] = useState<'none' | 'pin' | 'password' | 'biometrics' | null>(null)
  const [credentialCount, setCredentialCount] = useState<number | null>(null)

  useEffect(() => {
    window.api.auth.getMode().then(m => setCurrentMode(m))
    window.api.sessions.count().then(c => setCredentialCount(c))
  }, [])

  if (!loaded) return null
  const autoLockTimeout = settings.autoLockTimeout ?? '15 minutes'

  const modeLabel = (m: typeof currentMode) => {
    if (!m) return '…'
    return { none: 'None', pin: 'PIN', password: 'Password', biometrics: 'Touch ID' }[m]
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="mb-6">
        <h1 className="font-['Plus_Jakarta_Sans'] font-bold text-[22px]" style={{ color: 'var(--nox-text)' }}>Security</h1>
        <p className="font-['Inter'] text-[12.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
          Encryption and credential management
        </p>
      </div>

      <div className="space-y-6">
        <Card label="Authentication">
          <Row
            label="Lock Method"
            description="How you unlock noxed on startup"
          >
            <button
              onClick={() => setShowAuthModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md font-['Inter'] text-[12.5px] transition-colors"
              style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span style={{ color: 'var(--nox-text-2)' }}>{modeLabel(currentMode)}</span>
              <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--nox-text-3)' }} />
            </button>
          </Row>
        </Card>

        <Card label="Credentials">
          <div
            className="flex items-center gap-3 p-3 rounded-md"
            style={{ background: '#10B98115', border: '1px solid #10B98140' }}
          >
            <ShieldCheck className="w-5 h-5 text-[#10B981] flex-shrink-0" />
            <div>
              <span className="font-['Inter'] text-[12.5px] font-medium" style={{ color: 'var(--nox-text)' }}>
                Passwords live in your OS keychain
              </span>
              <p className="font-['Inter'] text-[11px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
                Credentials are stored by the operating system's keychain, never in noxed's
                config files, and are only read while the app is unlocked
              </p>
            </div>
          </div>
          <Row label="Auto-lock Timeout" description="Lock credentials after inactivity">
            <Select
              options={['5 minutes', '15 minutes', '30 minutes', '1 hour', 'Never']}
              value={autoLockTimeout}
              onChange={v => update('autoLockTimeout', v)}
            />
          </Row>
        </Card>

        <Card label="Credential Store">
          <Row label="Stored Connections" description="Sessions with credentials in OS Keychain">
            <span
              className="font-['JetBrains_Mono'] text-[12px] px-2.5 py-1 rounded font-medium"
              style={{ color: 'var(--nox-text)', background: 'var(--nox-sidebar)' }}
            >
              {credentialCount !== null ? String(credentialCount) : '…'}
            </span>
          </Row>
        </Card>

        <div
          className="rounded-md p-5"
          style={{ background: 'var(--nox-shell)', border: '1px solid #EF444440' }}
        >
          <div className="mb-4">
            <span className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider text-[#EF4444] font-semibold">
              Danger Zone
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="font-['Inter'] text-[13px] font-medium" style={{ color: 'var(--nox-text)' }}>
                Clear All Stored Credentials
              </span>
              <p className="font-['Inter'] text-[11.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
                Permanently delete all saved passwords, keys, and connection configs
              </p>
            </div>
            <button
              onClick={onClear}
              className="flex items-center gap-1.5 bg-[#EF4444] text-white rounded-md px-3 py-1.5 font-['Inter'] text-[12px] font-medium hover:bg-[#DC2626] transition-colors flex-shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear All
            </button>
          </div>
        </div>
      </div>

      {showAuthModal && currentMode !== null && (
        <ChangeAuthModal
          currentMode={currentMode}
          onClose={() => setShowAuthModal(false)}
          onDone={newMode => {
            setCurrentMode(newMode)
            setShowAuthModal(false)
          }}
        />
      )}
    </div>
  )
}

/* ── Terminal settings ───────────────────────────────────────────────────── */
function TerminalSettings() {
  const { settings, loaded, update } = useSettings()
  const [scrollbackDraft, setScrollbackDraft] = useState('')
  const scrollbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (loaded) setScrollbackDraft(String(settings.scrollbackSize ?? 100000))
  }, [loaded])

  if (!loaded) return null
  const fontSize = settings.terminalFontSize ?? 14
  const terminalFont = settings.terminalFont ?? 'JetBrains Mono'
  const terminalTheme = settings.terminalTheme ?? 'noxed Dark'
  const terminalCursorStyle = settings.terminalCursorStyle ?? 'Vertical Bar'
  const copyOnSelect = settings.copyOnSelect ?? false
  const bellSound = settings.bellSound ?? true

  const handleScrollbackChange = (raw: string) => {
    setScrollbackDraft(raw)
    if (scrollbackTimer.current) clearTimeout(scrollbackTimer.current)
    scrollbackTimer.current = setTimeout(() => {
      const n = Number.parseInt(raw, 10)
      if (!Number.isNaN(n) && n >= 100 && n <= 100000) update('scrollbackSize', n)
    }, 600)
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="mb-6">
        <h1 className="font-['Plus_Jakarta_Sans'] font-bold text-[22px]" style={{ color: 'var(--nox-text)' }}>Terminal</h1>
        <p className="font-['Inter'] text-[12.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
          Customize the terminal emulator appearance and behavior
        </p>
      </div>

      <div className="space-y-6">
        <Card label="Font">
          <Row label="Font Family" description="Monospace font for terminal text">
            <Select
              options={['JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Monaco', 'Cascadia Code']}
              value={terminalFont}
              onChange={v => update('terminalFont', v)}
            />
          </Row>
          <Divider />
          <Row label="Font Size" description="Terminal text size in pixels">
            <div className="flex items-center gap-2">
              <button
                onClick={() => update('terminalFontSize', Math.max(8, fontSize - 1))}
                className="w-8 h-8 rounded-md flex items-center justify-center transition-colors"
                style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <span className="font-['Inter'] text-[13px] w-12 text-center" style={{ color: 'var(--nox-text)' }}>
                {fontSize}px
              </span>
              <button
                onClick={() => update('terminalFontSize', Math.min(32, fontSize + 1))}
                className="w-8 h-8 rounded-md flex items-center justify-center transition-colors"
                style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </Row>
        </Card>

        <Card label="Color Scheme">
          <Row label="Theme" description="Terminal color palette">
            <Select
              options={['noxed Dark', 'noxed Light', 'Monokai', 'Dracula', 'Solarized Dark']}
              value={terminalTheme}
              onChange={v => update('terminalTheme', v)}
            />
          </Row>
          <Divider />
          <Row label="Cursor Style" description="Terminal cursor appearance">
            <Select
              options={['Block', 'Underline', 'Vertical Bar']}
              value={terminalCursorStyle}
              onChange={v => update('terminalCursorStyle', v)}
            />
          </Row>
        </Card>

        <Card label="Behavior">
          <Row label="Scrollback Buffer Size" description="Maximum lines of terminal history to keep">
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={scrollbackDraft}
                onChange={e => handleScrollbackChange(e.target.value)}
                min={100}
                max={100000}
                className="rounded-md px-3 py-1.5 font-['Inter'] text-[12.5px] focus:outline-none focus:ring-1 focus:ring-[#3B5CCC] w-24"
                style={{
                  background: 'var(--nox-bg)',
                  border: '1px solid var(--nox-border)',
                  color: 'var(--nox-text)',
                }}
              />
              <span className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-2)' }}>lines</span>
            </div>
          </Row>
          <Divider />
          <Row label="Copy on Select" description="Automatically copy selected text to clipboard">
            <Toggle on={copyOnSelect} onChange={v => update('copyOnSelect', v)} />
          </Row>
          <Divider />
          <Row label="Bell Sound" description="Play sound on terminal bell character">
            <Toggle on={bellSound} onChange={v => update('bellSound', v)} />
          </Row>
        </Card>
      </div>
    </div>
  )
}

/* ── About settings ──────────────────────────────────────────────────────── */
function AboutSettings() {
  const status = useAppStore(s => s.updateStatus)
  const [version, setVersion] = useState('…')

  useEffect(() => { window.api.updater.version().then(setVersion) }, [])

  const busy = status?.state === 'checking' || status?.state === 'downloading'

  const statusText = (() => {
    switch (status?.state) {
      case 'checking': return 'Checking for updates…'
      case 'available': return `Version ${status.version} is available`
      case 'downloading': return `Downloading update… ${status.percent}%`
      case 'downloaded': return `Update v${status.version} is ready to install`
      case 'not-available': return "You're on the latest version"
      case 'error': return status.message
      default: return null
    }
  })()

  const statusColor = (() => {
    switch (status?.state) {
      case 'error': return '#EF4444'
      case 'not-available': return '#10B981'
      case 'available':
      case 'downloaded': return '#3B5CCC'
      default: return 'var(--nox-text-2)'
    }
  })()

  // Primary action depends on where we are: download is opt-in, not automatic.
  const action = (() => {
    if (status?.state === 'downloaded') {
      return (
        <button
          onClick={() => window.api.updater.quitAndInstall()}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 font-['Inter'] text-[12px] font-medium text-white transition-colors"
          style={{ background: '#3B5CCC' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2A4299' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#3B5CCC' }}
        >
          <RotateCw className="w-3.5 h-3.5" />
          Restart &amp; Install
        </button>
      )
    }
    if (status?.state === 'available') {
      return (
        <button
          onClick={() => window.api.updater.download()}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 font-['Inter'] text-[12px] font-medium text-white transition-colors"
          style={{ background: '#10B981' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#059669' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#10B981' }}
        >
          <Download className="w-3.5 h-3.5" />
          Download v{status.version}
        </button>
      )
    }
    return (
      <button
        onClick={() => window.api.updater.check()}
        disabled={busy}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] transition-colors disabled:opacity-50"
        style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
        onMouseEnter={e => { if (!busy) (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} style={{ color: 'var(--nox-text-2)' }} />
        Check for Updates
      </button>
    )
  })()

  return (
    <div className="p-6 max-w-2xl">
      <div className="mb-6">
        <h1 className="font-['Plus_Jakarta_Sans'] font-bold text-[22px]" style={{ color: 'var(--nox-text)' }}>About</h1>
        <p className="font-['Inter'] text-[12.5px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
          Version and license information
        </p>
      </div>

      <div className="space-y-6">
        <Card label="Software Update">
          <Row label="Version" description="The version of noxed you're running">
            <span
              className="font-['JetBrains_Mono'] text-[12px] px-2.5 py-1 rounded"
              style={{ color: 'var(--nox-text-2)', background: 'var(--nox-sidebar)' }}
            >
              {version}
            </span>
          </Row>
          <Divider />
          <Row label="Updates" description="Check GitHub for a newer release, then download and install it">
            {action}
          </Row>
          {statusText && (
            <div className="flex items-center gap-2">
              {status?.state === 'not-available' && <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#10B981' }} />}
              {status?.state === 'error' && <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#EF4444' }} />}
              <p className="font-['Inter'] text-[11.5px]" style={{ color: statusColor }}>{statusText}</p>
            </div>
          )}
        </Card>

        <Card label="Application">
          <Row label="Application">
            <span className="font-['Inter'] text-[12.5px] font-medium" style={{ color: 'var(--nox-text)' }}>noxed</span>
          </Row>
          <Divider />
          <Row label="Platform">
            <span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-2)' }}>Electron + React</span>
          </Row>
          <Divider />
          <Row label="License">
            <span className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-2)' }}>MIT</span>
          </Row>
        </Card>
      </div>
    </div>
  )
}

/* ── Change auth modal ───────────────────────────────────────────────────── */
type AuthMode = 'none' | 'pin' | 'password' | 'biometrics'

type AuthStep = 'verify' | 'select' | 'set'

function authModalTitle(step: AuthStep, selectedMode: AuthMode | null): string {
  if (step === 'verify') return 'Confirm Your Identity'
  if (step === 'select') return 'Choose Lock Method'
  return `Set New ${selectedMode === 'pin' ? 'PIN' : 'Password'}`
}

function authModalSubtitle(step: AuthStep, selectedMode: AuthMode | null): string {
  if (step === 'verify') return 'Enter your current credential to continue'
  if (step === 'select') return 'How should noxed lock on startup?'
  return selectedMode === 'pin' ? 'Choose a 4-digit PIN' : 'Choose a strong password'
}

function BiometricVerify({ loading, error, onRetry }: Readonly<{
  loading: boolean; error: string; onRetry: () => void
}>) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center"
        style={{ background: 'var(--nox-surface)', border: '1px solid var(--nox-border)' }}
      >
        <Fingerprint
          className="w-9 h-9"
          style={{ color: loading ? '#3B5CCC' : 'var(--nox-text-2)' }}
        />
      </div>
      <p className="font-['Inter'] text-[12.5px] text-center" style={{ color: 'var(--nox-text-2)' }}>
        {loading ? 'Waiting for Touch ID…' : 'Place your finger on the sensor'}
      </p>
      {error && <p className="font-['Inter'] text-[12px] text-[#EF4444] text-center">{error}</p>}
      {!loading && (
        <button
          onClick={onRetry}
          className="w-full py-2 rounded-lg font-['Inter'] text-[13px] font-semibold text-white"
          style={{ background: '#3B5CCC' }}
        >
          Try Again
        </button>
      )}
    </div>
  )
}

function SetPasswordInput({ loading, error, newCredential, confirmCredential, showNew, onNewChange, onConfirmChange, onToggleShow, onSubmit }: Readonly<{
  loading: boolean; error: string; newCredential: string; confirmCredential: string; showNew: boolean
  onNewChange: (v: string) => void; onConfirmChange: (v: string) => void; onToggleShow: () => void; onSubmit: () => void
}>) {
  return (
    <div className="space-y-3">
      <div className="relative">
        <input
          type={showNew ? 'text' : 'password'}
          value={newCredential}
          onChange={e => onNewChange(e.target.value)}
          placeholder="New password"
          autoFocus
          className="w-full rounded-lg px-4 py-2.5 font-['Inter'] text-[13px] focus:outline-none focus:ring-2 focus:ring-[#3B5CCC]"
          style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
        />
        <button type="button" onClick={onToggleShow} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--nox-text-3)' }}>
          {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      <input
        type="password"
        value={confirmCredential}
        onChange={e => onConfirmChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onSubmit() }}
        placeholder="Confirm password"
        className="w-full rounded-lg px-4 py-2.5 font-['Inter'] text-[13px] focus:outline-none focus:ring-2 focus:ring-[#3B5CCC]"
        style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
      />
      {error && <p className="font-['Inter'] text-[12px] text-[#EF4444]">{error}</p>}
      <button
        onClick={onSubmit}
        disabled={loading || !newCredential || !confirmCredential}
        className="w-full py-2.5 rounded-lg font-['Inter'] text-[13px] font-semibold text-white transition-all disabled:opacity-40"
        style={{ background: '#3B5CCC' }}
      >
        {loading ? 'Saving…' : 'Set Password'}
      </button>
    </div>
  )
}

function ChangeAuthModal({
  currentMode,
  onClose,
  onDone,
}: Readonly<{
  currentMode: AuthMode
  onClose: () => void
  onDone: (mode: AuthMode) => void
}>) {
  // step: 'verify' (verify current) → 'select' (pick new mode) → 'set' (enter new credential)
  const [step, setStep] = useState<'verify' | 'select' | 'set'>(
    currentMode === 'none' ? 'select' : 'verify'
  )
  const [selectedMode, setSelectedMode] = useState<AuthMode | null>(null)
  const [touchIDAvailable, setTouchIDAvailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // For verify / set steps
  const [verifyCredential, setVerifyCredential] = useState('')
  const [newCredential, setNewCredential] = useState('')
  const [confirmCredential, setConfirmCredential] = useState('')
  const [showVerify, setShowVerify] = useState(false)
  const [showNew, setShowNew] = useState(false)
  // PIN digits
  const [newDigits, setNewDigits] = useState<string[]>([])
  const [confirmDigits, setConfirmDigits] = useState<string[]>([])
  const [pinPhase, setPinPhase] = useState<'enter' | 'confirm'>('enter')

  useEffect(() => {
    window.api.auth.isAvailable().then(setTouchIDAvailable)
  }, [])

  // Auto-trigger biometric verify
  useEffect(() => {
    if (step === 'verify' && currentMode === 'biometrics') {
      handleBiometricVerify()
    }
  }, [step])

  const handleBiometricVerify = async () => {
    setLoading(true)
    setError('')
    const result = await window.api.auth.unlock()
    setLoading(false)
    if (result.success) {
      setStep('select')
    } else {
      setError(result.error ?? 'Touch ID failed')
    }
  }

  // Verify credential (pin/password)
  const handleVerifySubmit = async (cred: string) => {
    if (!cred) return
    setLoading(true)
    setError('')
    // Use auth:unlock to verify — it returns success without changing lock state if already unlocked
    // Actually we need to call setup with same mode to verify. Instead we try unlock.
    const result = await window.api.auth.unlock(cred)
    setLoading(false)
    if (result.success) {
      setVerifyCredential(cred)
      setStep('select')
    } else {
      setError(result.error ?? 'Authentication failed')
    }
  }

  const handleModeSelect = (mode: AuthMode) => {
    setSelectedMode(mode)
    if (mode === 'none' || mode === 'biometrics') {
      // No credential needed — go straight to apply
      applyNewMode(mode)
    } else {
      setNewDigits([])
      setConfirmDigits([])
      setNewCredential('')
      setConfirmCredential('')
      setPinPhase('enter')
      setStep('set')
    }
  }

  const applyNewMode = async (mode: AuthMode, credential?: string) => {
    setLoading(true)
    setError('')
    const result = await window.api.auth.setup(mode, credential, verifyCredential || undefined)
    setLoading(false)
    if (result.success) {
      onDone(mode)
    } else {
      setError(result.error ?? 'Failed to change authentication')
    }
  }

  // `confirmPin` carries the just-completed confirm digits from SetPinInput —
  // the `confirmDigits` state may not be committed yet when submit fires.
  const handleSetSubmit = async (confirmPin?: string[]) => {
    if (!selectedMode) return
    if (selectedMode === 'pin') {
      const pin = newDigits.join('')
      const conf = (confirmPin ?? confirmDigits).join('')
      if (pin.length !== 4) { setError('Enter a 4-digit PIN'); return }
      if (pin !== conf) { setError('PINs do not match'); setConfirmDigits([]); setPinPhase('enter'); setNewDigits([]); return }
      applyNewMode(selectedMode, pin)
    } else {
      if (!newCredential.trim()) { setError('Password cannot be empty'); return }
      if (newCredential !== confirmCredential) { setError('Passwords do not match'); setConfirmCredential(''); return }
      applyNewMode(selectedMode, newCredential)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={e => { if (e.key === 'Escape') onClose() }}
    >
      <div
        className="rounded-xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
        style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4" style={{ borderBottom: '1px solid var(--nox-border)' }}>
          <h2 className="font-['Plus_Jakarta_Sans'] font-bold text-[17px]" style={{ color: 'var(--nox-text)' }}>
            {authModalTitle(step, selectedMode)}
          </h2>
          <p className="font-['Inter'] text-[12px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
            {authModalSubtitle(step, selectedMode)}
          </p>
        </div>

        <div className="p-6 space-y-4">
          {/* ── VERIFY STEP ── */}
          {step === 'verify' && currentMode === 'biometrics' && (
            <BiometricVerify loading={loading} error={error} onRetry={handleBiometricVerify} />
          )}

          {step === 'verify' && currentMode === 'pin' && (
            <VerifyPinInput
              loading={loading}
              error={error}
              onSubmit={handleVerifySubmit}
            />
          )}

          {step === 'verify' && currentMode === 'password' && (
            <VerifyPasswordInput
              loading={loading}
              error={error}
              show={showVerify}
              onToggleShow={() => setShowVerify(s => !s)}
              onSubmit={handleVerifySubmit}
            />
          )}

          {/* ── SELECT STEP ── */}
          {step === 'select' && (
            <div className="space-y-2">
              {error && <p className="font-['Inter'] text-[12px] text-[#EF4444]">{error}</p>}
              {([
                { mode: 'none' as AuthMode, icon: <ShieldOff className="w-4 h-4" />, label: 'None', desc: 'No lock screen' },
                { mode: 'pin' as AuthMode, icon: <Hash className="w-4 h-4" />, label: 'PIN', desc: '4-digit numeric code' },
                { mode: 'password' as AuthMode, icon: <KeyRound className="w-4 h-4" />, label: 'Password', desc: 'Alphanumeric password' },
                { mode: 'biometrics' as AuthMode, icon: <Fingerprint className="w-4 h-4" />, label: 'Touch ID', desc: touchIDAvailable ? 'Use biometric sensor' : 'Not available on this Mac', disabled: !touchIDAvailable },
              ] as { mode: AuthMode; icon: React.ReactNode; label: string; desc: string; disabled?: boolean }[]).map(opt => (
                <button
                  key={opt.mode}
                  onClick={() => !opt.disabled && !loading && handleModeSelect(opt.mode)}
                  disabled={opt.disabled || loading}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors disabled:opacity-40"
                  style={{ border: '1px solid var(--nox-border)', background: 'transparent' }}
                  onMouseEnter={e => { if (!opt.disabled) (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'var(--nox-bg)', color: 'var(--nox-text-2)' }}
                  >
                    {opt.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-['Inter'] text-[13px] font-medium" style={{ color: 'var(--nox-text)' }}>{opt.label}</span>
                    <p className="font-['Inter'] text-[11px]" style={{ color: 'var(--nox-text-3)' }}>{opt.desc}</p>
                  </div>
                  {loading && opt.mode === selectedMode
                    ? <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: '#3B5CCC', borderTopColor: 'transparent' }} />
                    : <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
                  }
                </button>
              ))}
            </div>
          )}

          {/* ── SET STEP ── */}
          {step === 'set' && selectedMode === 'pin' && (
            <SetPinInput
              phase={pinPhase}
              enterDigits={newDigits}
              confirmDigits={confirmDigits}
              loading={loading}
              error={error}
              onEnterChange={setNewDigits}
              onConfirmChange={setConfirmDigits}
              onPhaseChange={setPinPhase}
              onSubmit={handleSetSubmit}
            />
          )}

          {step === 'set' && selectedMode === 'password' && (
            <SetPasswordInput
              loading={loading}
              error={error}
              newCredential={newCredential}
              confirmCredential={confirmCredential}
              showNew={showNew}
              onNewChange={setNewCredential}
              onConfirmChange={setConfirmCredential}
              onToggleShow={() => setShowNew(s => !s)}
              onSubmit={() => handleSetSubmit()}
            />
          )}
        </div>

        {/* Footer cancel */}
        <div className="px-6 pb-5">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg font-['Inter'] text-[12.5px] transition-colors"
            style={{ color: 'var(--nox-text-2)', border: '1px solid var(--nox-border)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Verify PIN input (compact numpad for modal) ─────────────────────────── */
function VerifyPinInput({ loading, error, onSubmit }: Readonly<{
  loading: boolean; error: string; onSubmit: (pin: string) => void
}>) {
  const [digits, setDigits] = useState<string[]>([])

  const pressKey = (key: string) => {
    if (key === '⌫') {
      setDigits(d => d.slice(0, -1))
      return
    }
    if (loading || digits.length >= 4) return
    const next = [...digits, key]
    setDigits(next)
    if (next.length === 4) {
      setTimeout(() => { onSubmit(next.join('')); setDigits([]) }, 80)
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (loading) return
      if (/^\d$/.test(e.key)) pressKey(e.key)
      if (e.key === 'Backspace') setDigits(d => d.slice(0, -1))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [digits, loading])

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-3">
        {[0,1,2,3].map(i => (
          <div key={i} className="w-3 h-3 rounded-full transition-all"
            style={{ background: i < digits.length ? '#3B5CCC' : 'var(--nox-border)' }} />
        ))}
      </div>
      {error && <p className="font-['Inter'] text-[12px] text-[#EF4444] text-center">{error}</p>}
      <div className="grid grid-cols-3 gap-2 w-full">
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((key) => {
          if (key === '') return <div key="numpad-gap" />
          const isDel = key === '⌫'
          return (
            <button key={key}
              onClick={() => pressKey(key)}
              disabled={loading}
              className="h-11 rounded-lg font-['Plus_Jakarta_Sans'] text-[16px] font-semibold transition-all active:scale-95 disabled:opacity-40"
              style={{
                background: isDel ? 'transparent' : 'var(--nox-bg)',
                border: isDel ? 'none' : '1px solid var(--nox-border)',
                color: isDel ? 'var(--nox-text-2)' : 'var(--nox-text)',
              }}
            >{key}</button>
          )
        })}
      </div>
    </div>
  )
}

/* ── Verify password input ───────────────────────────────────────────────── */
function VerifyPasswordInput({ loading, error, show, onToggleShow, onSubmit }: Readonly<{
  loading: boolean; error: string; show: boolean; onToggleShow: () => void; onSubmit: (v: string) => void
}>) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <div className="space-y-3">
      <div className="relative">
        <input
          ref={ref}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && value.trim()) onSubmit(value) }}
          placeholder="Current password"
          className="w-full rounded-lg px-4 py-2.5 font-['Inter'] text-[13px] focus:outline-none focus:ring-2 focus:ring-[#3B5CCC]"
          style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
        />
        <button type="button" onClick={onToggleShow} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--nox-text-3)' }}>
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      {error && <p className="font-['Inter'] text-[12px] text-[#EF4444]">{error}</p>}
      <button
        onClick={() => value.trim() && onSubmit(value)}
        disabled={loading || !value.trim()}
        className="w-full py-2.5 rounded-lg font-['Inter'] text-[13px] font-semibold text-white transition-all disabled:opacity-40"
        style={{ background: '#3B5CCC' }}
      >
        {loading ? 'Verifying…' : 'Continue'}
      </button>
    </div>
  )
}

/* ── Set PIN input (two-phase: enter + confirm) ──────────────────────────── */
function SetPinInput({ phase, enterDigits, confirmDigits, loading, error, onEnterChange, onConfirmChange, onPhaseChange, onSubmit }: Readonly<{
  phase: 'enter' | 'confirm'
  enterDigits: string[]
  confirmDigits: string[]
  loading: boolean
  error: string
  onEnterChange: (d: string[]) => void
  onConfirmChange: (d: string[]) => void
  onPhaseChange: (p: 'enter' | 'confirm') => void
  onSubmit: (confirmPin: string[]) => void
}>) {
  const digits = phase === 'enter' ? enterDigits : confirmDigits
  const setDigits = phase === 'enter' ? onEnterChange : onConfirmChange

  const pressKey = (key: string) => {
    if (loading || digits.length >= 4) return
    const next = [...digits, key]
    setDigits(next)
    if (next.length === 4) {
      setTimeout(() => {
        if (phase === 'enter') { onPhaseChange('confirm') }
        else { onSubmit(next) }
      }, 80)
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (loading) return
      if (/^[0-9]$/.test(e.key)) pressKey(e.key)
      if (e.key === 'Backspace') setDigits(digits.slice(0, -1))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [digits, loading, phase])

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-2)' }}>
        {phase === 'enter' ? 'Enter new PIN' : 'Confirm new PIN'}
      </p>
      <div className="flex items-center gap-3">
        {[0,1,2,3].map(i => (
          <div key={i} className="w-3 h-3 rounded-full transition-all"
            style={{ background: i < digits.length ? '#3B5CCC' : 'var(--nox-border)' }} />
        ))}
      </div>
      {error && <p className="font-['Inter'] text-[12px] text-[#EF4444] text-center">{error}</p>}
      <div className="grid grid-cols-3 gap-2 w-full">
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((key) => {
          if (key === '') return <div key="numpad-gap" />
          const isDel = key === '⌫'
          return (
            <button key={key}
              onClick={() => isDel ? setDigits(digits.slice(0,-1)) : pressKey(key)}
              disabled={loading}
              className="h-11 rounded-lg font-['Plus_Jakarta_Sans'] text-[16px] font-semibold transition-all active:scale-95 disabled:opacity-40"
              style={{
                background: isDel ? 'transparent' : 'var(--nox-bg)',
                border: isDel ? 'none' : '1px solid var(--nox-border)',
                color: isDel ? 'var(--nox-text-2)' : 'var(--nox-text)',
              }}
            >{key}</button>
          )
        })}
      </div>
    </div>
  )
}

/* ── Clear credentials modal ─────────────────────────────────────────────── */
function ClearCredentialsModal({ onCancel, onConfirm }: Readonly<{ onCancel: () => void; onConfirm: () => Promise<void> }>) {
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState('')

  const handleConfirm = async () => {
    setClearing(true)
    setError('')
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear credentials')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        className="rounded-lg shadow-xl max-w-md w-full mx-4"
        style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
      >
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-[#FEE2E2] flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-[#EF4444]" />
            </div>
            <div>
              <h2 className="font-['Plus_Jakarta_Sans'] font-bold text-[18px]" style={{ color: 'var(--nox-text)' }}>
                Clear All Credentials?
              </h2>
              <p className="font-['Inter'] text-[12px]" style={{ color: 'var(--nox-text-2)' }}>This action cannot be undone</p>
            </div>
          </div>
          <p className="font-['Inter'] text-[13px] mb-6" style={{ color: 'var(--nox-text-2)' }}>
            This will permanently delete all stored passwords, SSH keys, database credentials, and connection configurations. Your data cannot be recovered after this action.
          </p>
          {error && <p className="font-['Inter'] text-[12px] text-[#EF4444] mb-4">{error}</p>}
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={onCancel}
              disabled={clearing}
              className="px-4 py-2 rounded-md font-['Inter'] text-[12.5px] transition-colors disabled:opacity-40"
              style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={clearing}
              className="px-4 py-2 rounded-md bg-[#EF4444] text-white font-['Inter'] text-[12.5px] font-medium hover:bg-[#DC2626] transition-colors disabled:opacity-60"
            >
              {clearing ? 'Clearing…' : 'Yes, Clear All'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
