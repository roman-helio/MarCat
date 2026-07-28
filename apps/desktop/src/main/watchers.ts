import fs from 'node:fs'
import { appRouter, isReviewPlatform, processGmassQueue, type SecretsStore } from '@marcat/core'
import type { DB } from '@marcat/db'

/**
 * Steam watched-folders. Every 60s it reconciles the set of enabled steam sources:
 * newly-seen ones get a catch-up import + an fs.watch (debounced re-import on change);
 * removed/disabled ones get their watcher closed. So sources added at runtime are
 * picked up within a minute (manual "Sync" works instantly in the meantime).
 */
export function setupSteamWatchers(db: DB, secrets?: SecretsStore): void {
  const caller = appRouter.createCaller({ db, secrets })
  const watchers = new Map<string, fs.FSWatcher>()

  const reconcile = async () => {
    try {
      const games = await caller.games.list()
      const current = new Map<string, string>() // sourceId -> folder
      for (const g of games) {
        const srcs = await caller.sources.list({ gameId: g.id })
        for (const s of srcs) if (s.platform === 'steam' && s.enabled) current.set(s.id, s.handle)
      }
      // Drop watchers for sources that are gone or disabled.
      for (const [id, w] of watchers) {
        if (!current.has(id)) {
          try {
            w.close()
          } catch {
            /* ignore */
          }
          watchers.delete(id)
        }
      }
      // Add watchers (+ catch-up) for newly-seen sources.
      for (const [id, folder] of current) {
        if (watchers.has(id) || !fs.existsSync(folder)) continue
        void caller.sources.sync({ sourceId: id }).catch(() => {})
        try {
          let timer: ReturnType<typeof setTimeout> | undefined
          const w = fs.watch(folder, () => {
            clearTimeout(timer)
            timer = setTimeout(() => void caller.sources.sync({ sourceId: id }).catch(() => {}), 1500)
          })
          watchers.set(id, w)
        } catch {
          /* folder may be unwatchable; manual sync still works */
        }
      }
    } catch {
      /* best effort — never block */
    }
  }

  void reconcile()
  setInterval(() => void reconcile(), 60_000)
}

/** Process MCP/UI-created GMass jobs and catch up delivery reports while the desktop app is open. */
export function setupGmassWorker(db: DB, secrets?: SecretsStore): void {
  const run = () => void processGmassQueue(db, secrets).catch(() => {})
  run()
  setInterval(run, 30_000)
}

/** Refresh public review/comment feeds while MarCat is open. */
export function setupFeedbackWorker(db: DB, secrets?: SecretsStore): void {
  const caller = appRouter.createCaller({ db, secrets })
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      const games = await caller.games.list()
      for (const game of games) {
        const sourceRows = await caller.sources.list({ gameId: game.id })
        for (const source of sourceRows) {
          if (!source.enabled || !isReviewPlatform(source.platform)) continue
          await caller.sources.sync({ sourceId: source.id }).catch(() => {})
        }
      }
    } finally {
      running = false
    }
  }
  void run()
  setInterval(() => void run(), 15 * 60 * 1_000)
}
