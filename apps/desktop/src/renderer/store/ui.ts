import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SectionViewStateValue = string | number | boolean | null
export const EMPTY_SECTION_VIEW_STATE: Readonly<Record<string, SectionViewStateValue>> = Object.freeze({})

interface UiState {
  /** Currently selected game (workspace), or null on the All-Games dashboard. */
  currentGameId: string | null
  setCurrentGame: (id: string | null) => void
  /** Whether the "ask MarCat" command input (in the companion strip) is open. */
  commandOpen: boolean
  setCommandOpen: (open: boolean) => void
  /** Whether the cross-entity quick search is open. */
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
  /** Prompt handed off from the companion strip to the AI den to run. */
  pendingPrompt: string | null
  setPendingPrompt: (p: string | null) => void
  /** Prompt to PREFILL the AI den input (inline-AI) without auto-running it. */
  seedPrompt: string | null
  setSeedPrompt: (p: string | null) => void
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  /** Explicit disclosure choices. Missing keys follow the active route automatically. */
  sidebarSections: Record<string, boolean>
  setSidebarSection: (section: string, expanded: boolean) => void
  /** Persisted working state for product sections, scoped by a stable section/project key. */
  sectionViewStates: Record<string, Record<string, SectionViewStateValue>>
  setSectionViewState: (section: string, patch: Record<string, SectionViewStateValue>) => void
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      currentGameId: null,
      setCurrentGame: (id) => set({ currentGameId: id }),
      commandOpen: false,
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      searchOpen: false,
      setSearchOpen: (searchOpen) => set({ searchOpen }),
      pendingPrompt: null,
      setPendingPrompt: (pendingPrompt) => set({ pendingPrompt }),
      seedPrompt: null,
      setSeedPrompt: (seedPrompt) => set({ seedPrompt }),
      sidebarCollapsed: false,
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      sidebarSections: {},
      setSidebarSection: (section, expanded) =>
        set((state) => ({ sidebarSections: { ...state.sidebarSections, [section]: expanded } })),
      sectionViewStates: {},
      setSectionViewState: (section, patch) =>
        set((state) => {
          const current = state.sectionViewStates?.[section] ?? EMPTY_SECTION_VIEW_STATE
          const changed = Object.entries(patch).some(([key, value]) => current[key] !== value)
          if (!changed) return state
          return {
            sectionViewStates: {
              ...(state.sectionViewStates ?? {}),
              [section]: { ...current, ...patch },
            },
          }
        }),
    }),
    {
      name: 'marcat-ui',
      partialize: (s) => ({
        currentGameId: s.currentGameId,
        sidebarCollapsed: s.sidebarCollapsed,
        sidebarSections: s.sidebarSections,
        sectionViewStates: s.sectionViewStates,
      }),
    },
  ),
)
