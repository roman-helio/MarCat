import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark' | 'system'

interface ThemeState {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  cycle: () => void
}

const order: ThemeMode[] = ['system', 'light', 'dark']

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      setMode: (mode) => set({ mode }),
      cycle: () => {
        const i = order.indexOf(get().mode)
        set({ mode: order[(i + 1) % order.length]! })
      },
    }),
    { name: 'marcat-theme' },
  ),
)

/** Resolve the requested mode against the OS preference and toggle <html>.dark. */
export function applyTheme(mode: ThemeMode): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const dark = mode === 'dark' || (mode === 'system' && prefersDark)
  document.documentElement.classList.toggle('dark', dark)
}
