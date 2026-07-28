import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { resolveReaction, type Mood, type Trigger } from '@/components/companion/cat'
import { useSettings } from '@/store/settings'

interface CompanionState {
  mood: Mood
  message: string | null
  /** Cat level (1–10), grows with the current game's wishlist balance. */
  level: number
  levelsByGame: Record<string, number>
  /** Highest level whose celebration has already been emitted for each game. */
  celebratedLevelsByGame: Record<string, number>
  celebration: { gameId: string; fromLevel: number; level: number } | null
  /** Rotating seed so repeated triggers vary their phrasing. */
  seed: number
  /** Fire a semantic event; the engine maps it to a mood + phrase (no LLM). */
  react: (trigger: Trigger, ctx?: Record<string, string | number>) => void
  /** Update the level from wishlist balance; celebrates on a level-up. */
  setLevel: (gameId: string, level: number) => void
  dismissCelebration: () => void
  /** Wake the cat with an explicit status (e.g. echo a prompt while it works). */
  setStatus: (mood: Mood, message?: string | null) => void
  /** Back to the default sleeping state. */
  sleep: () => void
  adviceByGame: Record<string, StoredAdvice>
  timingByGame: Record<string, AdviceTiming>
  dismissedByGame: Record<string, string>
  rememberAdvice: (gameId: string, value: StoredAdvice) => void
  beginAdvice: (gameId: string, fingerprint: string) => void
  shouldAutoAdvise: (gameId: string, fingerprint: string) => boolean
  dismissAdvice: (gameId: string, fingerprint: string) => void
}

export interface CompanionKnowledge {
  id: string
  title: string
  summary: string
  guidance: string
  source: string
  sourcePages: string | null
  volatility: 'low' | 'medium' | 'high'
}

export interface StoredAdvice {
  fingerprint: string
  advice: {
    title: string
    message: string
    why: string
    mood: Mood
    confidence: number
    action: { id: string; label: string; path: string }
    knowledgeRefs: string[]
    model: string
  }
  knowledge: CompanionKnowledge[]
  createdAt: number
}

interface AdviceTiming {
  lastAt: number
  lastFingerprint: string
  day: string
  dayCount: number
}

const PROACTIVE_TRIGGERS = new Set<Trigger>([
  'idle',
  'wishlistsUp',
  'onTrack',
  'deadlineNear',
  'overdue',
  'milestoneRisk',
  'outreachDue',
])

/**
 * Runtime state of the MarCat mascot. Driven by a deterministic trigger engine
 * (deadlines, syncs, spikes, AI run states). Default is a sleeping cat: zero cost.
 */
export const useCompanion = create<CompanionState>()(
  persist(
    (set, get) => ({
      mood: 'sleeping',
      message: null,
      level: 1,
      levelsByGame: {},
      celebratedLevelsByGame: {},
      celebration: null,
      seed: 0,
      adviceByGame: {},
      timingByGame: {},
      dismissedByGame: {},
      react: (trigger, ctx) => {
        if (useSettings.getState().companionActivity === 'request' && PROACTIVE_TRIGGERS.has(trigger)) return
        const seed = get().seed + 1
        const lang = useSettings.getState().lang
        const { mood, message } = resolveReaction(trigger, lang, seed, ctx)
        set({ mood, message, seed })
      },
      setLevel: (gameId, level) => {
        const state = get()
        const previous = state.levelsByGame[gameId]
        const celebratedLevel = state.celebratedLevelsByGame[gameId] ?? previous ?? level
        if (previous === level && get().level === level) return
        if (previous != null && level > previous && level > celebratedLevel) {
          const seed = get().seed + 1
          const lang = useSettings.getState().lang
          const { mood, message } = resolveReaction('levelUp', lang, seed, { level })
          set((state) => ({
            level,
            levelsByGame: { ...state.levelsByGame, [gameId]: level },
            celebratedLevelsByGame: { ...state.celebratedLevelsByGame, [gameId]: level },
            celebration: { gameId, fromLevel: previous, level },
            mood,
            message,
            seed,
          }))
        } else {
          set((state) => ({ level, levelsByGame: { ...state.levelsByGame, [gameId]: level } }))
        }
      },
      dismissCelebration: () => set({ celebration: null }),
      setStatus: (mood, message = null) => set({ mood, message }),
      sleep: () => set({ mood: 'sleeping', message: null }),
      rememberAdvice: (gameId, value) => set((state) => ({ adviceByGame: { ...state.adviceByGame, [gameId]: value } })),
      beginAdvice: (gameId, fingerprint) => {
        const now = Date.now()
        const day = new Date(now).toISOString().slice(0, 10)
        set((state) => {
          const previous = state.timingByGame[gameId]
          const dayCount = previous?.day === day ? previous.dayCount + 1 : 1
          return {
            timingByGame: {
              ...state.timingByGame,
              [gameId]: { lastAt: now, lastFingerprint: fingerprint, day, dayCount },
            },
          }
        })
      },
      shouldAutoAdvise: (gameId, fingerprint) => {
        const state = get()
        const activity = useSettings.getState().companionActivity
        if (activity === 'request') return false
        if (state.dismissedByGame[gameId] === fingerprint) return false
        if (state.adviceByGame[gameId]?.fingerprint === fingerprint) return false
        const previous = state.timingByGame[gameId]
        const day = new Date().toISOString().slice(0, 10)
        if (previous?.lastFingerprint === fingerprint) return false
        const cooldownMs = activity === 'high' ? 20 * 60_000 : 60 * 60_000
        const dailyLimit = activity === 'high' ? 4 : 2
        const timings = Object.values(state.timingByGame)
        const latestAt = timings.reduce((latest, timing) => Math.max(latest, timing.lastAt), 0)
        const usedToday = timings.reduce((count, timing) => count + (timing.day === day ? timing.dayCount : 0), 0)
        if (latestAt && Date.now() - latestAt < cooldownMs) return false
        return usedToday < dailyLimit
      },
      dismissAdvice: (gameId, fingerprint) =>
        set((state) => ({ dismissedByGame: { ...state.dismissedByGame, [gameId]: fingerprint } })),
    }),
    {
      name: 'marcat-companion',
      partialize: (state) => ({
        adviceByGame: state.adviceByGame,
        timingByGame: state.timingByGame,
        dismissedByGame: state.dismissedByGame,
        levelsByGame: state.levelsByGame,
        celebratedLevelsByGame: state.celebratedLevelsByGame,
      }),
    },
  ),
)
