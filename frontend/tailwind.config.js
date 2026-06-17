/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Studio Dark — cool slate base with a refined teal-green accent.
        bg: '#0f1113',
        surface: { 1: '#141719', 2: '#181b1f', 3: '#1f242a', 4: '#272d34' },
        accent: { DEFAULT: '#5eead4', 2: '#34d399' },
        ok: '#5eead4',
        warn: '#fbbf77',
        danger: '#fb7185',
        ink: { 1: '#f1f4f6', 2: '#9aa6b2', 3: '#5d6772' },
        line: '#272d34',
      },
      fontFamily: {
        head: ['Sora', 'system-ui', 'sans-serif'],
        ui: ['Manrope', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 18px rgba(94,234,212,0.18)',
        card: '0 16px 36px rgba(0,0,0,0.45)',
      },
    },
  },
  plugins: [],
}
