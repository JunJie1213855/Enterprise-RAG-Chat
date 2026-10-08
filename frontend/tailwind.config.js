/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f0f4ff',
          100: '#e0e9ff',
          200: '#c7d7fe',
          300: '#a5bcfc',
          400: '#8196f8',
          500: '#6170f1',
          600: '#4d52e5',
          700: '#3f42cb',
          800: '#3437a3',
          900: '#2e3181',
          950: '#1c1d4e',
        },
        surface: {
          DEFAULT: '#0f1117',
          50:  '#1a1d27',
          100: '#222533',
          200: '#2a2e3f',
          300: '#363a4e',
        },
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-slow': 'pulse 2s cubic-bezier(0.4,0,0.6,1) infinite',
        'typing': 'typing 1.2s steps(3) infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        typing: { '0%,100%': { opacity: '0.2' }, '50%': { opacity: '1' } },
      },
    },
  },
  plugins: [],
}

