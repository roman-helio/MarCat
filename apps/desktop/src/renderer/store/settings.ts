import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Lang = 'en' | 'ru'
export type CompanionActivity = 'request' | 'medium' | 'high'

interface SettingsState {
  /** Hotkey that opens the "ask MarCat" command input, e.g. "ctrl+space". */
  commandHotkey: string
  setCommandHotkey: (combo: string) => void
  /** Hotkey that opens the command palette, e.g. "ctrl+k". */
  paletteHotkey: string
  setPaletteHotkey: (combo: string) => void
  lang: Lang
  setLang: (lang: Lang) => void
  /** How often MarCat may surface unsolicited advice and invoke Claude automatically. */
  companionActivity: CompanionActivity
  setCompanionActivity: (activity: CompanionActivity) => void
  /** First-run onboarding shown/dismissed. */
  onboarded: boolean
  setOnboarded: (v: boolean) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      commandHotkey: 'ctrl+space',
      setCommandHotkey: (commandHotkey) => set({ commandHotkey }),
      paletteHotkey: 'ctrl+k',
      setPaletteHotkey: (paletteHotkey) => set({ paletteHotkey }),
      lang: 'ru',
      setLang: (lang) => set({ lang }),
      companionActivity: 'medium',
      setCompanionActivity: (companionActivity) => set({ companionActivity }),
      onboarded: false,
      setOnboarded: (onboarded) => set({ onboarded }),
    }),
    { name: 'marcat-settings' },
  ),
)

const MOD_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
])

/**
 * Layout-independent key token from a keyboard event's physical `code`
 * (so combos work on any keyboard layout, not just QWERTY/English).
 */
function keyToken(code: string): string {
  if (code.startsWith('Key')) return code.slice(3).toLowerCase() // KeyK → k
  if (code.startsWith('Digit')) return code.slice(5) // Digit1 → 1
  if (code.startsWith('Numpad') && code.length > 6) return `num${code.slice(6).toLowerCase()}`
  if (code === 'Space') return 'space'
  if (MOD_CODES.has(code)) return ''
  return code.toLowerCase() // arrowup, comma, period, …
}

function mods(e: KeyboardEvent): string[] {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.metaKey) parts.push('meta')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  return parts
}

/** Build a normalized combo string ("ctrl+shift+space") from a keyboard event. */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts = mods(e)
  const key = keyToken(e.code)
  if (key) parts.push(key)
  return parts.join('+')
}

/** Fallback combo from the produced character (layout-dependent, but catches space/punct). */
function comboFromKey(e: KeyboardEvent): string {
  const parts = mods(e)
  let k = (e.key || '').toLowerCase()
  if (k === ' ' || k === 'spacebar') k = 'space'
  if (!k || ['control', 'meta', 'alt', 'shift', 'os'].includes(k)) return ''
  parts.push(k)
  return parts.join('+')
}

/**
 * True if the event matches a combo. We accept EITHER the physical-`code` combo
 * (layout-independent — the canonical match) OR the produced-key combo, so a binding
 * fires on any keyboard layout regardless of which one the user is typing in.
 */
export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const target = combo.toLowerCase()
  const last = target.split('+').pop()
  if (!last || ['ctrl', 'meta', 'alt', 'shift'].includes(last)) return false
  return comboFromEvent(e) === target || comboFromKey(e) === target
}
