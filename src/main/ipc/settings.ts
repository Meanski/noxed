import { ipcMain } from 'electron'
import Store from 'electron-store'
import { ValidationError } from './errors'

export interface AppSettings {
  dateFormat: string
  sidebarDefault: 'expanded' | 'collapsed'
  sidebarWidth: number
  recentConnections: Array<{ id: string; at: number }>
  mcpEnabled: boolean
  mcpPort: number
  confirmClose: boolean
  dashboardView: 'grid' | 'compact' | 'list'
  connAlerts: boolean
  transferAlerts: boolean
  resourceAlerts: boolean
  sshKeepalive: string
  terminalFont: string
  terminalFontSize: number
  terminalTheme: string
  terminalCursorStyle: string
  scrollbackSize: number
  copyOnSelect: boolean
  confirmMultilinePaste: boolean
  bellSound: boolean
  autoLockTimeout: string
  isDarkMode: boolean
  groupColors: Record<string, string>
  sectionOrder: Record<string, string[]>
  projectGroupOrder: string[]
  [key: `snippets:${string}`]: unknown
}

const DEFAULTS: Omit<AppSettings, `snippets:${string}`> = {
  dateFormat: 'YYYY-MM-DD HH:mm',
  sidebarDefault: 'expanded',
  sidebarWidth: 220,
  recentConnections: [],
  mcpEnabled: false,
  mcpPort: 39_847,
  confirmClose: true,
  dashboardView: 'compact',
  connAlerts: true,
  transferAlerts: false,
  resourceAlerts: true,
  sshKeepalive: '30 seconds',
  terminalFont: 'JetBrains Mono',
  terminalFontSize: 14,
  terminalTheme: 'noxed Dark',
  terminalCursorStyle: 'Vertical Bar',
  scrollbackSize: 100000,
  copyOnSelect: false,
  confirmMultilinePaste: true,
  bellSound: true,
  autoLockTimeout: '15 minutes',
  isDarkMode: false,
  groupColors: {},
  sectionOrder: {},
  projectGroupOrder: [],
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS))

const MAX_RECENT_CONNECTIONS = 20

// Value checks for settings whose type or range matters to the app. The
// renderer clamps too, but settings:set is reachable from untrusted code.
const VALUE_VALIDATORS: Partial<Record<keyof AppSettings, (value: unknown) => boolean>> = {
  sidebarWidth: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 180 && v <= 480,
  confirmMultilinePaste: (v) => typeof v === 'boolean',
  recentConnections: (v) =>
    Array.isArray(v) &&
    v.length <= MAX_RECENT_CONNECTIONS &&
    v.every((r) => typeof r?.id === 'string' && r.id.length <= 128 && typeof r.at === 'number' && Number.isFinite(r.at)),
  mcpEnabled: (v) => typeof v === 'boolean',
  mcpPort: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65_535,
}

function isValidKey(key: string): boolean {
  return KNOWN_KEYS.has(key) || key.startsWith('snippets:')
}

const settingsStore = new Store<{ settings: AppSettings }>({
  name: 'settings',
  defaults: { settings: DEFAULTS as AppSettings },
})

export function getStoredSettings(): AppSettings {
  return { ...DEFAULTS, ...settingsStore.get('settings') }
}

// Settings that grant capabilities change only through their own handlers
// (which check the lock screen), never through the generic settings:set.
const MAIN_ONLY_KEYS = new Set<keyof AppSettings>(['mcpEnabled', 'mcpPort'])

/** For main-process modules that own a MAIN_ONLY setting. */
export function setStoredSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  settingsStore.set('settings', { ...settingsStore.get('settings'), [key]: value })
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', () => settingsStore.get('settings'))

  ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
    if (!isValidKey(key)) throw new Error(`Unknown setting: ${key}`)
    if (MAIN_ONLY_KEYS.has(key as keyof AppSettings)) throw new ValidationError(`${key} can only be changed from its own settings section`)
    const validate = VALUE_VALIDATORS[key as keyof AppSettings]
    if (validate && !validate(value)) throw new ValidationError(`Invalid value for setting: ${key}`)
    const settings = settingsStore.get('settings')
    ;(settings as any)[key] = value
    settingsStore.set('settings', settings)
    return settings
  })

  ipcMain.handle('settings:reset', () => {
    const current = getStoredSettings()
    const kept = Object.fromEntries([...MAIN_ONLY_KEYS].map((k) => [k, current[k]]))
    const reset = { ...DEFAULTS, ...kept } as AppSettings
    settingsStore.set('settings', reset)
    return reset
  })
}
