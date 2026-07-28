import { useMemo } from 'react'
import { useSettings } from '@/store/settings'
import { messages } from './messages'

export type TParams = Record<string, string | number>

/** Translator hook. `t('key', { name: 'X' })` interpolates `{name}`. */
export function useT() {
  const lang = useSettings((s) => s.lang)
  return useMemo(() => {
    return (key: string, params?: TParams): string => {
      let s = messages[lang][key] ?? messages.en[key] ?? key
      if (params) {
        for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v))
      }
      // Galmuri7 ships an empty glyph for uppercase Cyrillic Х (U+0425); it's identical
      // to Latin X (U+0058), which renders pixel-perfect — so swap it for display.
      return s.replace(/Х/g, 'X')
    }
  }, [lang])
}
