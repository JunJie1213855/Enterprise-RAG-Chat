import { Moon, Sun } from 'lucide-react'
import clsx from 'clsx'
import { useThemeStore } from '@/store/themeStore'

/** Segmented control for switching between 护眼系 and 明亮系. */
export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useThemeStore()
  const isEye = theme === 'eye'

  if (compact) {
    return (
      <button
        onClick={() => setTheme(isEye ? 'light' : 'eye')}
        title={isEye ? '切换到明亮系' : '切换到护眼系'}
        className="btn-ghost p-2"
      >
        {isEye ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-1 p-1 rounded-xl bg-surface-100 border border-white/5">
      <button
        onClick={() => setTheme('eye')}
        className={clsx(
          'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs transition-colors',
          isEye ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200',
        )}
      >
        <Moon className="w-3.5 h-3.5" />
        护眼系
      </button>
      <button
        onClick={() => setTheme('light')}
        className={clsx(
          'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs transition-colors',
          !isEye ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200',
        )}
      >
        <Sun className="w-3.5 h-3.5" />
        明亮系
      </button>
    </div>
  )
}
