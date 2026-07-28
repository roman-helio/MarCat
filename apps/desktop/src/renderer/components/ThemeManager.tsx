import { useEffect } from 'react'
import { applyTheme, useTheme } from '@/store/theme'
import { useSettings } from '@/store/settings'

/** Applies the chosen theme and keeps it in sync with the OS preference. */
export function ThemeManager() {
  const mode = useTheme((s) => s.mode)
  const lang = useSettings((s) => s.lang)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  useEffect(() => {
    applyTheme(mode)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(mode)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  return null
}
