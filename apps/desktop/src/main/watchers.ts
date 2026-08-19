import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { utilityProcess } from 'electron'
import {
  appRouter,
  expireYoutubeDiscoveryCache,
  isReviewPlatform,
  MARCAT_MCP_HTTP_PORT,
  processGmassQueue,
  recoverInterruptedDiscoveryRuns,
  syncYouTubeDiscoveryArchives,
  syncYouTubeDiscoveryRunArchive,
  type MarkdownWorkspaceCoordinator,
  type SecretsStore,
} from '@marcat/core'
import { withDatabaseWritePurpose, type DB } from '@marcat/db'

export interface BackgroundWorkerController {
  wake(): void
  stop(): void
}

interface McpHealth {
  name?: string
  dbPath?: string
}

/** Keep the reconnectable loopback MCP endpoint available while MarCat is running. */
export function setupMcpHttpWorker(
  dbPath: string,
  serverPath: string,
  onDiagnostic?: (message: string, error?: unknown) => void,
): BackgroundWorkerController {
  let child: Electron.UtilityProcess | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let checking = false
  let failures = 0
  const healthUrl = `http://127.0.0.1:${MARCAT_MCP_HTTP_PORT}/health`

  const schedule = (delayMs: number) => {
    clearTimeout(retryTimer)
    if (!stopped) retryTimer = setTimeout(() => void ensureRunning(), delayMs)
  }
  const endpointIsHealthy = async (): Promise<boolean> => {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) })
      if (!response.ok) return false
      const health = (await response.json()) as McpHealth
      return health.name === 'marcat' && Boolean(health.dbPath) && resolve(health.dbPath!) === resolve(dbPath)
    } catch {
      return false
    }
  }
  const ensureRunning = async () => {
    if (stopped || child || checking) return
    checking = true
    try {
      if (await endpointIsHealthy()) {
        failures = 0
        schedule(5_000)
        return
      }
      const worker = utilityProcess.fork(serverPath, ['--http', '--port', String(MARCAT_MCP_HTTP_PORT)], {
        serviceName: 'MarCat MCP HTTP',
        stdio: 'ignore',
        env: { ...process.env, MARCAT_DB: dbPath },
      })
      child = worker
      worker.on('spawn', () => {
        failures = 0
        onDiagnostic?.(`MCP HTTP worker started (pid ${worker.pid ?? 'unknown'}).`)
      })
      worker.on('error', (type, location, report) => {
        onDiagnostic?.(`MCP HTTP worker fatal error (${type} at ${location}).`, report)
      })
      worker.once('exit', (code) => {
        if (child === worker) child = undefined
        worker.removeAllListeners()
        if (stopped) return
        failures += 1
        onDiagnostic?.(`MCP HTTP worker exited: code ${code}.`)
        schedule(Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)))
      })
    } catch (error) {
      failures += 1
      onDiagnostic?.('MCP HTTP worker failed to start.', error)
      schedule(Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)))
    } finally {
      checking = false
    }
  }

  void ensureRunning()
  return {
    wake: () => {
      clearTimeout(retryTimer)
      retryTimer = undefined
      void ensureRunning()
    },
    stop: () => {
      stopped = true
      clearTimeout(retryTimer)
      const activeChild = child
      child = undefined
      activeChild?.removeAllListeners()
      activeChild?.kill()
    },
  }
}

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
  const run = () =>
    void withDatabaseWritePurpose('GMass background worker', () => processGmassQueue(db, secrets)).catch(() => {})
  run()
  setInterval(run, 30_000)
}

/** Run durable creator-discovery jobs while MarCat is open or minimized. */
export function setupYoutubeDiscoveryWorker(
  db: DB,
  dbPath: string,
  secrets?: SecretsStore,
  workspace?: MarkdownWorkspaceCoordinator,
  onDiagnostic?: (message: string, error?: unknown) => void,
): BackgroundWorkerController {
  type WorkerMessage = { kind: 'result'; runId: string | null } | { kind: 'error'; error: string }
  let child: Electron.UtilityProcess | undefined
  let stopped = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let wakePending = false
  const wakePath = `${dbPath}.discovery-wakeup`
  const idlePollMs = 5 * 60_000

  const schedule = (delayMs: number) => {
    clearTimeout(retryTimer)
    if (!stopped) retryTimer = setTimeout(() => void run(), delayMs)
  }
  const run = () => {
    if (stopped || child) return
    const apiKeys = {
      youtube: secrets?.getApiKey('youtube'),
      scrapecreators: secrets?.getApiKey('scrapecreators'),
    }
    if (!apiKeys.youtube && !apiKeys.scrapecreators) {
      schedule(idlePollMs)
      return
    }
    const worker = utilityProcess.fork(join(__dirname, 'discovery-worker.js'), [], {
      serviceName: 'MarCat Creator Discovery',
      stdio: 'ignore',
    })
    child = worker
    let reportedResult = false
    let completedRunId: string | null | undefined
    worker.on('spawn', () => {
      onDiagnostic?.(`Creator discovery worker started (pid ${worker.pid ?? 'unknown'}).`)
      worker.postMessage({ kind: 'run', dbPath, apiKeys })
    })
    worker.on('message', (message: WorkerMessage) => {
      if (!message || (message.kind !== 'result' && message.kind !== 'error')) return
      reportedResult = true
      if (message.kind === 'error') {
        onDiagnostic?.('Creator discovery worker reported an error.', message.error)
        return
      }
      completedRunId = message.runId
      failures = 0
      if (message.runId && workspace) {
        void syncYouTubeDiscoveryRunArchive(db, workspace, message.runId).catch((error) =>
          onDiagnostic?.('Creator discovery archive synchronization failed.', error),
        )
      }
    })
    worker.on('error', (type, location, report) => {
      onDiagnostic?.(`Creator discovery worker fatal error (${type} at ${location}).`, report)
    })
    worker.once('exit', (code) => {
      if (child === worker) child = undefined
      worker.removeAllListeners()
      if (stopped) return
      const clean = code === 0 && reportedResult
      if (!clean) {
        failures += 1
        const hexCode = `0x${(code >>> 0).toString(16).padStart(8, '0').toUpperCase()}`
        onDiagnostic?.(`Creator discovery worker exited unexpectedly: code ${code} (${hexCode}).`)
      }
      const backoff = clean
        ? completedRunId
          ? 5_000
          : wakePending
            ? 0
            : idlePollMs
        : Math.min(5 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 4))
      wakePending = false
      if (clean) {
        schedule(backoff)
      } else {
        void withDatabaseWritePurpose('creator discovery worker crash recovery', () =>
          recoverInterruptedDiscoveryRuns(db),
        )
          .then((result) =>
            onDiagnostic?.(
              `Creator discovery recovery completed: requeued=${result.requeued}, partial=${result.partial}.`,
            ),
          )
          .catch((error) => onDiagnostic?.('Creator discovery worker crash recovery failed.', error))
          .finally(() => schedule(backoff))
      }
    })
  }
  const wake = () => {
    if (stopped) return
    clearTimeout(retryTimer)
    retryTimer = undefined
    if (child) {
      wakePending = true
      return
    }
    run()
  }
  const expire = () =>
    void withDatabaseWritePurpose('creator discovery cache expiry', () => expireYoutubeDiscoveryCache(db)).catch(
      (error) => onDiagnostic?.('Creator discovery cache expiry failed.', error),
    )
  const archive = () => {
    if (workspace) {
      void syncYouTubeDiscoveryArchives(db, workspace).catch((error) =>
        onDiagnostic?.('Creator discovery archive reconciliation failed.', error),
      )
    }
  }
  void withDatabaseWritePurpose('creator discovery startup recovery', () => recoverInterruptedDiscoveryRuns(db))
    .catch((error) => onDiagnostic?.('Creator discovery startup recovery failed.', error))
    .finally(run)
  expire()
  archive()
  const expireTimer = setInterval(expire, 60 * 60 * 1_000)

  // Queue writers in either the desktop process or MCP touch this tiny file.
  // No SQLite call is made from the Electron timer, so a native DB fault stays
  // isolated inside the short-lived utility process and cannot close the UI.
  let wakeWatcher: fs.FSWatcher | undefined
  try {
    fs.closeSync(fs.openSync(wakePath, 'a'))
    wakeWatcher = fs.watch(wakePath, { persistent: false }, wake)
  } catch (error) {
    onDiagnostic?.('Creator discovery wake file initialization failed.', error)
  }

  return {
    wake,
    stop: () => {
      stopped = true
      clearTimeout(retryTimer)
      clearInterval(expireTimer)
      wakeWatcher?.close()
      const activeChild = child
      child = undefined
      activeChild?.removeAllListeners()
      activeChild?.kill()
    },
  }
}

/** Complete accepted bulk contact promotions without polling SQLite in the main process. */
export function setupCreatorPromotionWorker(
  db: DB,
  dbPath: string,
  workspace?: MarkdownWorkspaceCoordinator,
  onDiagnostic?: (message: string, error?: unknown) => void,
): BackgroundWorkerController {
  type WorkerMessage = { kind: 'result'; runId: string | null } | { kind: 'error'; error: string }
  let child: Electron.UtilityProcess | undefined
  let stopped = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let wakePending = false
  let failures = 0
  const wakePath = `${dbPath}.creator-promotion-wakeup`
  const idlePollMs = 5 * 60_000

  const schedule = (delayMs: number) => {
    clearTimeout(retryTimer)
    if (!stopped) retryTimer = setTimeout(run, delayMs)
  }
  const run = () => {
    if (stopped || child) return
    const worker = utilityProcess.fork(join(__dirname, 'promotion-worker.js'), [], {
      serviceName: 'MarCat Creator Promotion',
      stdio: 'ignore',
    })
    child = worker
    let reportedResult = false
    let completedRunId: string | null | undefined
    worker.on('spawn', () => worker.postMessage({ kind: 'run', dbPath }))
    worker.on('message', (message: WorkerMessage) => {
      if (!message || (message.kind !== 'result' && message.kind !== 'error')) return
      reportedResult = true
      if (message.kind === 'error') {
        onDiagnostic?.('Creator promotion worker reported an error.', message.error)
        return
      }
      completedRunId = message.runId
      failures = 0
      if (message.runId && workspace) {
        void syncYouTubeDiscoveryRunArchive(db, workspace, message.runId).catch((error) =>
          onDiagnostic?.('Creator promotion archive synchronization failed.', error),
        )
      }
    })
    worker.once('exit', (code) => {
      if (child === worker) child = undefined
      worker.removeAllListeners()
      if (stopped) return
      const clean = code === 0 && reportedResult
      if (!clean) {
        failures += 1
        onDiagnostic?.(`Creator promotion worker exited unexpectedly: code ${code}.`)
      }
      const backoff = clean
        ? completedRunId || wakePending
          ? 0
          : idlePollMs
        : Math.min(5 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 4))
      wakePending = false
      schedule(backoff)
    })
  }
  const wake = () => {
    if (stopped) return
    clearTimeout(retryTimer)
    retryTimer = undefined
    if (child) {
      wakePending = true
      return
    }
    run()
  }
  let wakeWatcher: fs.FSWatcher | undefined
  try {
    fs.closeSync(fs.openSync(wakePath, 'a'))
    wakeWatcher = fs.watch(wakePath, { persistent: false }, wake)
  } catch (error) {
    onDiagnostic?.('Creator promotion wake file initialization failed.', error)
  }
  run()
  return {
    wake,
    stop: () => {
      stopped = true
      clearTimeout(retryTimer)
      wakeWatcher?.close()
      const activeChild = child
      child = undefined
      activeChild?.removeAllListeners()
      activeChild?.kill()
    },
  }
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
