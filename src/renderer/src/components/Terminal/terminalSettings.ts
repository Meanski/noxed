import { Terminal } from '@xterm/xterm'

// Shared xterm configuration for every terminal in the app (SSH + local):
// themes, settings parsing, and the bell.

export const DEFAULT_SCROLLBACK_SIZE = 100000

export const TERMINAL_THEMES: Record<string, Record<string, string>> = {
  'noxed Dark': {
    background: '#0c0b0f', foreground: '#ffffff', cursor: '#9d6ff8', cursorAccent: '#0c0b0f',
    selectionBackground: 'rgba(124,58,237,0.3)',
    black: '#1a1725', brightBlack: '#3d3952', red: '#ef4444', brightRed: '#f87171',
    green: '#10b981', brightGreen: '#34d399', yellow: '#f59e0b', brightYellow: '#fbbf24',
    blue: '#7c3aed', brightBlue: '#9d6ff8', magenta: '#c084fc', brightMagenta: '#d8b4fe',
    cyan: '#06b6d4', brightCyan: '#22d3ee', white: '#ffffff', brightWhite: '#ffffff',
  },
  'noxed Light': {
    background: '#fafafa', foreground: '#1a1a2e', cursor: '#3B5CCC', cursorAccent: '#fafafa',
    selectionBackground: 'rgba(59,92,204,0.2)',
    black: '#1a1a2e', brightBlack: '#6b7280', red: '#dc2626', brightRed: '#ef4444',
    green: '#059669', brightGreen: '#10b981', yellow: '#d97706', brightYellow: '#f59e0b',
    blue: '#3B5CCC', brightBlue: '#6366f1', magenta: '#9333ea', brightMagenta: '#a855f7',
    cyan: '#0891b2', brightCyan: '#06b6d4', white: '#1a1a2e', brightWhite: '#000000',
  },
  'Monokai': {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', cursorAccent: '#272822',
    selectionBackground: 'rgba(73,72,62,0.6)',
    black: '#272822', brightBlack: '#75715e', red: '#f92672', brightRed: '#f92672',
    green: '#a6e22e', brightGreen: '#a6e22e', yellow: '#f4bf75', brightYellow: '#f4bf75',
    blue: '#66d9ef', brightBlue: '#66d9ef', magenta: '#ae81ff', brightMagenta: '#ae81ff',
    cyan: '#a1efe4', brightCyan: '#a1efe4', white: '#f8f8f2', brightWhite: '#f9f8f5',
  },
  'Dracula': {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
    selectionBackground: 'rgba(68,71,90,0.6)',
    black: '#21222c', brightBlack: '#6272a4', red: '#ff5555', brightRed: '#ff6e6e',
    green: '#50fa7b', brightGreen: '#69ff94', yellow: '#f1fa8c', brightYellow: '#ffffa5',
    blue: '#bd93f9', brightBlue: '#d6acff', magenta: '#ff79c6', brightMagenta: '#ff92df',
    cyan: '#8be9fd', brightCyan: '#a4ffff', white: '#f8f8f2', brightWhite: '#ffffff',
  },
  'Solarized Dark': {
    background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36',
    selectionBackground: 'rgba(7,54,66,0.6)',
    black: '#073642', brightBlack: '#586e75', red: '#dc322f', brightRed: '#cb4b16',
    green: '#859900', brightGreen: '#586e75', yellow: '#b58900', brightYellow: '#657b83',
    blue: '#268bd2', brightBlue: '#839496', magenta: '#d33682', brightMagenta: '#6c71c4',
    cyan: '#2aa198', brightCyan: '#93a1a1', white: '#eee8d5', brightWhite: '#fdf6e3',
  },
}

export function resolveTerminalTheme(name: string): Record<string, string> {
  return TERMINAL_THEMES[name] ?? TERMINAL_THEMES['noxed Dark']
}

export function parseCursorStyle(setting: string): 'block' | 'underline' | 'bar' {
  if (setting === 'Block') return 'block'
  if (setting === 'Underline') return 'underline'
  return 'bar'
}

export function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

export function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export interface TerminalSettingsConfig {
  terminalFont?: unknown
  terminalFontSize?: unknown
  scrollbackSize?: unknown
  terminalCursorStyle?: unknown
  terminalTheme?: unknown
  copyOnSelect?: unknown
  bellSound?: unknown
  resourceAlerts?: unknown
}

export interface TerminalBehavior {
  copyOnSelect: boolean
  bellSound: boolean
  resourceAlerts: boolean
}

export function applyTerminalSettings(term: Terminal, behavior: { current: TerminalBehavior }, afterFit?: () => void): void {
  window.api.settings.get().then((cfg: TerminalSettingsConfig) => {
    const font = readString(cfg.terminalFont, 'JetBrains Mono')
    term.options.fontFamily = `"${font}", "SF Mono", Menlo, monospace`
    term.options.fontSize = readNumber(cfg.terminalFontSize, 14)
    term.options.scrollback = readNumber(cfg.scrollbackSize, DEFAULT_SCROLLBACK_SIZE)
    term.options.cursorStyle = parseCursorStyle(readString(cfg.terminalCursorStyle, 'Vertical Bar'))
    term.options.theme = resolveTerminalTheme(readString(cfg.terminalTheme, 'noxed Dark'))
    behavior.current = {
      copyOnSelect: cfg.copyOnSelect === true,
      bellSound: cfg.bellSound !== false,
      resourceAlerts: cfg.resourceAlerts !== false,
    }
    document.fonts.ready.then(() => {
      if (afterFit) afterFit()
    })
  })
}

let bellAudioContext: AudioContext | null = null

export function playBellSound(): void {
  try {
    bellAudioContext ??= new AudioContext()
    const ctx = bellAudioContext
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.08, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.16)
  } catch (err: any) {
    console.error('[terminal] bell failed:', err?.message ?? err)
  }
}
