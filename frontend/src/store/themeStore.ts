import { create } from 'zustand'

/**
 * Two colour themes, switched by a class on <html>.
 *
 * The palettes live in index.css as CSS variables, so Tailwind utilities
 * (which compile to `var(--color-…)` references) re-resolve automatically —
 * no component needs to know which theme is active.
 */
export type Theme = 'eye' | 'light'

export const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: 'eye', label: '护眼系', hint: '暗色，长时间阅读更舒适' },
  { id: 'light', label: '明亮系', hint: '白底灰线黑字' },
]

const STORAGE_KEY = 'theme'

function readStoredTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'eye' ? stored : 'eye'
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.classList.remove('theme-eye', 'theme-light')
  root.classList.add(`theme-${theme}`)
  localStorage.setItem(STORAGE_KEY, theme)
}

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: readStoredTheme(),
  setTheme: (theme) => {
    applyTheme(theme)
    set({ theme })
  },
}))

// Apply before first paint so there is no flash of the wrong palette.
applyTheme(readStoredTheme())
