/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/src/**/*.{ts,tsx,html}', './src/renderer/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Dark theme base (used by terminal, existing components)
        bg:          '#0c0b0f',
        'bg-raised':  '#131118',
        surface:     '#1a1725',
        'surface-2': '#211e2e',
        'surface-3': '#2a263a',

        // Borders (dark)
        border:      '#252231',
        'border-soft':'#1d1a28',
        'border-strong': '#3a3552',

        // Text tokens (dark theme) — used by AddSessionModal etc.
        'text-primary':   '#ffffff',
        'text-secondary': '#b0a9c8',
        'text-muted':     '#6b6480',

        // Legacy text shorthands
        't1': '#ffffff',
        't2': '#b0a9c8',
        't3': '#6b6480',
        't4': '#3d3952',

        // Accent — vivid violet (dark theme)
        accent:       '#7c3aed',
        'accent-2':   '#9d6ff8',
        'accent-3':   '#c4afff',
        'accent-bg':  'rgba(124,58,237,0.15)',
        'accent-ring':'rgba(124,58,237,0.4)',
        'accent-hover':'#8b47f0',

        // Connected state — emerald
        connected:    '#10b981',
        'connected-bg':'rgba(16,185,129,0.12)',

        // K8s — amber
        k8s:          '#f59e0b',
        'k8s-bg':     'rgba(245,158,11,0.12)',

        // States
        success:  '#10b981',
        warning:  '#f59e0b',
        error:    '#ef4444',
        'error-bg': 'rgba(239,68,68,0.1)',

        // Light theme tokens (new UI shell)
        'lt-bg':         '#F8F9FB',
        'lt-sidebar':    '#F1F3F6',
        'lt-surface':    '#FFFFFF',
        'lt-border':     '#E5E7EB',
        'lt-border-strong': '#D1D5DB',
        'lt-text':       '#1A1D26',
        'lt-text-2':     '#6B7280',
        'lt-text-3':     '#9CA3AF',
        'lt-accent':     '#3B5CCC',
        'lt-accent-hover':'#2A4299',
        'lt-accent-bg':  '#EBF0FF',
        'lt-green':      '#10B981',
        'lt-amber':      '#F59E0B',
        'lt-red':        '#EF4444',
      },

      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Menlo', 'monospace'],
        jakarta: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
      },

      fontSize: {
        '2xs': ['10px', { lineHeight: '1.4', letterSpacing: '0.02em' }],
        'xs':  ['11px', { lineHeight: '1.45' }],
        'sm':  ['12px', { lineHeight: '1.5' }],
        'base':['13px', { lineHeight: '1.55' }],
        'md':  ['14px', { lineHeight: '1.5' }],
        'lg':  ['16px', { lineHeight: '1.4' }],
        'xl':  ['20px', { lineHeight: '1.3', letterSpacing: '-0.02em' }],
        '2xl': ['28px', { lineHeight: '1.2', letterSpacing: '-0.03em' }],
        '3xl': ['40px', { lineHeight: '1.1', letterSpacing: '-0.04em' }],
      },

      boxShadow: {
        'sm':    '0 1px 4px rgba(0,0,0,0.4)',
        'md':    '0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)',
        'lg':    '0 16px 60px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06)',
        'soft':  '0 2px 8px rgba(0,0,0,0.08)',
        'modal': '0 8px 32px rgba(0,0,0,0.15)',
        'modal-dark': '0 20px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.08)',
        'glow-accent':   '0 0 24px rgba(124,58,237,0.4)',
        'glow-connected':'0 0 12px rgba(16,185,129,0.45)',
        'glow-k8s':      '0 0 12px rgba(245,158,11,0.4)',
        'glow-error':    '0 0 16px rgba(239,68,68,0.35)',
      },

      animation: {
        'in':        'fade-in 0.15s ease-out',
        'up':        'slide-up 0.22s cubic-bezier(0.16,1,0.3,1)',
        'right':     'slide-right 0.2s cubic-bezier(0.16,1,0.3,1)',
        'fade-in':   'fade-in 0.15s ease-out',
        'slide-up':  'slide-up 0.22s cubic-bezier(0.16,1,0.3,1)',
        'slide-in-right': 'slide-in-right 0.22s cubic-bezier(0.16,1,0.3,1)',
        'modal-in':  'modal-in 0.2s cubic-bezier(0.16,1,0.3,1)',
        'pulse-ring':'pulse-ring 2s ease-out infinite',
        'spin':      'spin 0.8s linear infinite',
        'shimmer':   'shimmer 1.6s linear infinite',
      },

      keyframes: {
        'fade-in':   { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up':  { from: { opacity: '0', transform: 'translateY(10px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-right': { from: { opacity: '0', transform: 'translateX(-8px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'slide-in-right': { from: { opacity: '0', transform: 'translateX(14px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'modal-in':  { from: { opacity: '0', transform: 'scale(0.96) translateY(-6px)' }, to: { opacity: '1', transform: 'scale(1) translateY(0)' } },
        'pulse-ring': { from: { transform: 'scale(1)', opacity: '0.8' }, to: { transform: 'scale(2.6)', opacity: '0' } },
        'spin':      { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
        'shimmer':   { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
      },
    },
  },
  plugins: [],
}
