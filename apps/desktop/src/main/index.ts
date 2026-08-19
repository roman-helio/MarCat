import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, shell } from 'electron'
import fs from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIPCHandler } from 'electron-trpc/main'
import {
  appRouter,
  backfillTaskDescriptionMarkdown,
  DrizzleWorkspaceRepository,
  MARCAT_MCP_HTTP_URL,
  MarkdownWorkspaceCoordinator,
  syncSteamFinancials,
  type AgentRunner,
  type SecretsStore,
} from '@marcat/core'
import {
  aiRuns,
  backfillTaskKeys,
  checkpoint,
  cleanupBackupStaging,
  configureConnection,
  createDb,
  createVerifiedBackup,
  fileUrlFromPath,
  findVerifiedSnapshot,
  formatSalvageReport,
  listDatabaseSnapshots,
  runMigrations,
  salvageDatabase,
  seedPublicFestivalCatalogue,
  verifyDatabaseFile,
  type DatabaseSnapshot,
  type DB,
} from '@marcat/db'
import { eq } from 'drizzle-orm'
import { claudeAvailable, codexAvailable, createAgentRunner } from './agent'
import { createSecrets } from './secrets'
import {
  setupCreatorPromotionWorker,
  setupFeedbackWorker,
  setupGmassWorker,
  setupMcpHttpWorker,
  setupSteamWatchers,
  setupYoutubeDiscoveryWorker,
} from './watchers'

// Set the app name early so getPath('userData') resolves to %APPDATA%/MarCat.
app.setName('MarCat')
crashReporter.start({
  productName: 'MarCat',
  companyName: 'heliogames',
  uploadToServer: false,
})

let db: DB | undefined
let dbClient: ReturnType<typeof createDb>['client'] | undefined
let agent: AgentRunner | undefined
let secrets: SecretsStore | undefined
let mainWindow: BrowserWindow | undefined
let startupRecoveryMessage: string | undefined
let activeDbPath: string | undefined
let workspace: MarkdownWorkspaceCoordinator | undefined
let youtubeDiscoveryWorker: ReturnType<typeof setupYoutubeDiscoveryWorker> | undefined
let creatorPromotionWorker: ReturnType<typeof setupCreatorPromotionWorker> | undefined
let mcpHttpWorker: ReturnType<typeof setupMcpHttpWorker> | undefined

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const formatted = [error.stack || error.message]
    let cause = (error as Error & { cause?: unknown }).cause
    for (let depth = 0; cause !== undefined && depth < 3; depth += 1) {
      if (cause instanceof Error) {
        formatted.push(`Caused by: ${cause.stack || cause.message}`)
        cause = (cause as Error & { cause?: unknown }).cause
      } else {
        formatted.push(`Caused by: ${String(cause)}`)
        break
      }
    }
    return formatted.join('\n')
  }
  return String(error)
}

function appendStartupLog(message: string, error?: unknown): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}${error ? `\n${formatError(error)}` : ''}\n`
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.appendFileSync(join(app.getPath('userData'), 'startup.log'), line)
  } catch {
    /* logging is best-effort */
  }
}

appendStartupLog(
  `Application starting: version=${app.getVersion()}, pid=${process.pid}, crashDumps=${app.getPath('crashDumps')}.`,
)

const RENDERER_LOG_MAX_BYTES = 2 * 1024 * 1024

function diagnosticText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\0/g, '').trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}

/** Persist renderer failures as bounded JSONL so a restart never erases the useful stack. */
function appendRendererLog(report: unknown, rendererUrl: string): void {
  try {
    const value = report && typeof report === 'object' ? (report as Record<string, unknown>) : {}
    const userData = app.getPath('userData')
    const logPath = join(userData, 'renderer.log')
    const previousPath = `${logPath}.1`
    fs.mkdirSync(userData, { recursive: true })
    if (fs.existsSync(logPath) && fs.statSync(logPath).size >= RENDERER_LOG_MAX_BYTES) {
      try {
        fs.rmSync(previousPath, { force: true })
        fs.renameSync(logPath, previousPath)
      } catch {
        // Keep appending if an external log viewer briefly holds the file on Windows.
      }
    }
    const record = {
      timestamp: new Date().toISOString(),
      appVersion: app.getVersion(),
      processId: process.pid,
      kind: diagnosticText(value.kind, 80) ?? 'renderer-error',
      message: diagnosticText(value.message, 8_000) ?? 'Unknown renderer error',
      stack: diagnosticText(value.stack, 32_000),
      componentStack: diagnosticText(value.componentStack, 32_000),
      route: diagnosticText(value.route, 2_000),
      title: diagnosticText(value.title, 500),
      scope: diagnosticText(value.scope, 200),
      taskId: diagnosticText(value.taskId, 200),
      rendererUrl: diagnosticText(rendererUrl, 2_000),
    }
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (error) {
    appendStartupLog('Failed to persist renderer diagnostics.', error)
  }
}

function isCorruptDatabaseError(error: unknown): boolean {
  const text = formatError(error)
  return /SQLITE_CORRUPT|malformed database schema|database disk image is malformed|file is not a database/i.test(text)
}

function defaultDatabasePath(): string {
  return join(app.getPath('userData'), 'marcat.db')
}

function activeDbMarkerPath(): string {
  return join(app.getPath('userData'), 'active-db-path.txt')
}

function readActiveDbPath(): string {
  try {
    const marker = activeDbMarkerPath()
    const markedPath = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : ''
    const userData = resolve(app.getPath('userData'))
    const resolvedPath = resolve(markedPath)
    if (markedPath && resolvedPath.startsWith(userData) && fs.existsSync(resolvedPath)) return resolvedPath
  } catch {
    /* ignore invalid marker */
  }
  return defaultDatabasePath()
}

function rememberActiveDbPath(dbPath: string): void {
  try {
    const marker = activeDbMarkerPath()
    if (resolve(dbPath) === resolve(defaultDatabasePath())) {
      if (fs.existsSync(marker)) fs.rmSync(marker)
    } else {
      fs.writeFileSync(marker, dbPath)
    }
  } catch {
    /* marker is best-effort */
  }
}

function backupDirectory(): string {
  return join(app.getPath('userData'), 'backups')
}

const LAUNCH_SNAPSHOT_PREFIX = 'marcat-auto-'
const SNAPSHOTS_KEPT_BY_COUNT = 5
const SNAPSHOTS_KEPT_DAYS = 21

/** When the app last switched which file is the live database, if it ever did. */
function activeDatabaseSwitchedAt(): number | undefined {
  try {
    const marker = activeDbMarkerPath()
    return fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : undefined
  } catch {
    return undefined
  }
}

/**
 * Rotation exists to bound disk use, and it must never be the thing that closes
 * the last door out of an incident. Three rules keep it honest:
 *
 *  - keep the N most recent AND everything from the last few weeks, so a problem
 *    noticed late still has a snapshot from before it started;
 *  - never drop a snapshot older than the moment the active database last
 *    changed - after a switch, the old snapshots are the evidence, and the new
 *    ones are snapshots of whatever replaced it;
 *  - do not rotate at all on a launch that is recovering from corruption.
 */
function pruneLaunchSnapshots(dir: string): void {
  if (startupRecoveryMessage) return
  const switchedAt = activeDatabaseSwitchedAt()
  const cutoff = Date.now() - SNAPSHOTS_KEPT_DAYS * 24 * 60 * 60 * 1000
  const snapshots = listDatabaseSnapshots(dir, (name) => name.startsWith(LAUNCH_SNAPSHOT_PREFIX))
  for (const [index, snapshot] of snapshots.entries()) {
    const takenAt = snapshot.takenAt.getTime()
    if (index < SNAPSHOTS_KEPT_BY_COUNT) continue
    if (takenAt >= cutoff) continue
    if (switchedAt !== undefined && takenAt <= switchedAt) continue
    try {
      fs.rmSync(snapshot.path)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Rotating snapshot taken at every launch (after the WAL is flushed) so a corrupted
 * session or accidental wipe is always recoverable.
 */
async function backupOnLaunch(database: DB, dbPath: string): Promise<void> {
  try {
    if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size < 4096) return
    const dir = backupDirectory()
    fs.mkdirSync(dir, { recursive: true })
    const reclaimed = await cleanupBackupStaging(dir, appendStartupLog)
    if (reclaimed > 0) {
      appendStartupLog(`Reclaimed ${Math.round(reclaimed / 1_048_576)} MB of leftover snapshot files.`)
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await createVerifiedBackup(database, join(dir, `${LAUNCH_SNAPSHOT_PREFIX}${stamp}.db`), appendStartupLog)
    pruneLaunchSnapshots(dir)
  } catch {
    /* backups are best-effort; never block startup */
  }
}

async function hasPendingMigrations(client: ReturnType<typeof createDb>['client'], folder: string): Promise<boolean> {
  const available = fs.existsSync(folder)
    ? fs.readdirSync(folder).filter((name) => /^\d+_.+\.sql$/.test(name)).length
    : 0
  if (!available) return false
  try {
    const result = await client.execute('SELECT count(*) AS count FROM __drizzle_migrations')
    const applied = Number(result.rows[0]?.count ?? 0)
    return applied < available
  } catch {
    // A real pre-migration database may predate Drizzle's journal table.
    return true
  }
}

function copyIfPresent(src: string, dest: string): void {
  if (!fs.existsSync(src)) return
  fs.copyFileSync(src, dest)
}

/**
 * Migrations are the one moment when an automatic launch backup is too late.
 * Snapshot the active DB and user-owned renderer/secrets state before the first
 * schema statement executes. The old app + this snapshot are a complete rollback.
 */
async function backupBeforeMigrations(
  dbPath: string,
  database: DB,
  client: ReturnType<typeof createDb>['client'],
  folder: string,
): Promise<void> {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size < 4096) return
  if (!(await hasPendingMigrations(client, folder))) return

  const integrity = await client.execute('PRAGMA integrity_check')
  if (String(integrity.rows[0]?.integrity_check ?? '') !== 'ok') {
    throw new Error('Database integrity check failed before migration')
  }
  const backupDir = join(app.getPath('userData'), 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dbBackup = join(backupDir, `marcat-pre-migration-${stamp}.db`)
  await createVerifiedBackup(database, dbBackup)

  const stateDir = join(backupDir, `state-pre-migration-${stamp}`)
  fs.mkdirSync(stateDir, { recursive: true })
  copyIfPresent(activeDbMarkerPath(), join(stateDir, 'active-db-path.txt'))
  copyIfPresent(join(app.getPath('userData'), 'Preferences'), join(stateDir, 'Preferences'))
  for (const name of fs.readdirSync(app.getPath('userData')).filter((name) => /^secret-.+\.bin$/.test(name))) {
    copyIfPresent(join(app.getPath('userData'), name), join(stateDir, name))
  }
  const localStorage = join(app.getPath('userData'), 'Local Storage', 'leveldb')
  if (fs.existsSync(localStorage)) {
    fs.cpSync(localStorage, join(stateDir, 'local-storage-leveldb'), { recursive: true })
  }
  appendStartupLog(`Pre-migration snapshot created: ${dbBackup}`)
}

function migrationsFolder(): string {
  // Packaged: copied via electron-builder extraResources -> resources/migrations.
  // Dev: read straight from the @marcat/db package in the monorepo.
  return app.isPackaged
    ? join(process.resourcesPath, 'migrations')
    : join(app.getAppPath(), '..', '..', 'packages', 'db', 'migrations')
}

const YOUTUBE_STORAGE_MAINTENANCE_KEY = 'maintenance.youtube_storage_v1'

/** Reclaim the pages released when legacy raw YouTube payloads are dropped. */
async function compactMigratedYoutubeStorage(client: ReturnType<typeof createDb>['client']): Promise<void> {
  const marker = await client.execute({
    sql: 'SELECT value FROM settings WHERE key = ? LIMIT 1',
    args: [YOUTUBE_STORAGE_MAINTENANCE_KEY],
  })
  if (marker.rows[0]?.value !== 'pending') return
  try {
    const pageSizeResult = await client.execute('PRAGMA page_size')
    const pageCountResult = await client.execute('PRAGMA page_count')
    const freeListResult = await client.execute('PRAGMA freelist_count')
    const pageSize = Number(pageSizeResult.rows[0]?.page_size ?? 0)
    const pageCount = Number(pageCountResult.rows[0]?.page_count ?? 0)
    const freePages = Number(freeListResult.rows[0]?.freelist_count ?? 0)
    const freeBytes = pageSize * freePages
    appendStartupLog(
      `YouTube storage migration released ${Math.round(freeBytes / 1_048_576)} MB across ${freePages}/${pageCount} pages`,
    )
    if (freeBytes >= 8 * 1_048_576) {
      await checkpoint(client, 'TRUNCATE')
      await client.execute('VACUUM')
      appendStartupLog('YouTube storage migration compacted the database')
    }
    await client.execute({
      sql: 'UPDATE settings SET value = ?, updated_at = ? WHERE key = ?',
      args: ['completed', new Date().toISOString(), YOUTUBE_STORAGE_MAINTENANCE_KEY],
    })
  } catch (error) {
    // The logical migration is already complete and freed pages remain reusable.
    // Keep the marker pending so a later clean startup can retry compaction.
    appendStartupLog('YouTube storage compaction deferred', error)
  }
}

function iconPath(): string {
  // Sets the taskbar/window icon (works without rcedit/exe-editing).
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png')
}

function changelogPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'CHANGELOG.md')
    : join(app.getAppPath(), '..', '..', 'CHANGELOG.md')
}

function publicFestivalSeedPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'steam-festivals.json')
    : join(app.getAppPath(), '..', '..', 'release-data', 'steam-festivals.json')
}

function mcpServerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'mcp', 'index.cjs')
    : join(app.getAppPath(), '..', '..', 'packages', 'mcp-server', 'dist', 'index.cjs')
}

async function openPreparedDb(dbPath: string): Promise<ReturnType<typeof createDb>> {
  const created = createDb(fileUrlFromPath(dbPath))
  try {
    await configureConnection(created.client) // WAL durability + keep the main .db file current
    const folder = migrationsFolder()
    await backupBeforeMigrations(dbPath, created.db, created.client, folder)
    await runMigrations(created.db, created.client, folder)
    await compactMigratedYoutubeStorage(created.client)
    const publicFestivals = JSON.parse(fs.readFileSync(publicFestivalSeedPath(), 'utf8')) as unknown
    await seedPublicFestivalCatalogue(created.client, publicFestivals)
    await backfillTaskKeys(created.db) // assign project keys + per-game task seq for pre-existing data
    await backfillTaskDescriptionMarkdown(created.db) // keep Markdown as the canonical task-description format
    await checkpoint(created.client, 'PASSIVE')
    return created
  } catch (error) {
    try {
      created.client.close()
    } catch {
      /* ignore */
    }
    throw error
  }
}

interface DatabaseRecovery {
  dbPath: string
  summary: string
}

/** The user declined to replace a damaged database. Quitting is the requested outcome, not a failure. */
class StartupCancelled extends Error {}

const SALVAGE_TIME_BUDGET_MS = 5 * 60_000

/** A fresh, never-used path for the database that takes over from a damaged one. */
function replacementDatabasePath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(app.getPath('userData'), `marcat-recovered-${stamp}.db`)
}

function describeAge(takenAt: Date): string {
  const hours = Math.round((Date.now() - takenAt.getTime()) / 3_600_000)
  if (hours < 1) return 'less than an hour ago'
  if (hours < 48) return `${hours} hours ago`
  return `${Math.round(hours / 24)} days ago`
}

type RecoveryChoice = 'snapshot' | 'salvage' | 'empty' | 'quit'

/**
 * Replacing the user's database is their decision, not ours. Every branch leaves
 * the damaged file exactly where it is, so closing this dialog is a safe answer:
 * nothing on disk changes and the data is still there next launch.
 */
function askRecoveryChoice(corruptPath: string, snapshot: DatabaseSnapshot | undefined): RecoveryChoice {
  const actions: RecoveryChoice[] = []
  const buttons: string[] = []
  if (snapshot) {
    actions.push('snapshot')
    buttons.push(`Restore the backup from ${snapshot.takenAt.toLocaleString()}`)
  }
  actions.push('salvage')
  buttons.push('Recover what can still be read from the damaged file')
  actions.push('empty')
  buttons.push('Start with an empty database')
  actions.push('quit')
  buttons.push('Quit and change nothing')

  const index = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'MarCat database is damaged',
    message: 'MarCat could not open its database.',
    detail: [
      `Damaged file, left untouched:\n${corruptPath}`,
      snapshot
        ? `Newest backup that passes a full integrity check, taken ${describeAge(snapshot.takenAt)}:\n${snapshot.path}`
        : 'No backup in the backups folder passes an integrity check.',
      'Nothing is deleted whichever option you choose.',
    ].join('\n\n'),
    buttons,
    defaultId: 0,
    cancelId: actions.length - 1,
    noLink: true,
  })
  return actions[index] ?? 'quit'
}

/**
 * Corruption in SQLite is damage to some pages, not to the file as a whole, so
 * treating it as a total loss throws away data that is still there. The ladder
 * is: a verified backup first, then whatever can be read out of the damaged file
 * itself, and an empty database only if the user explicitly asks for one.
 *
 * The damaged file is never moved, copied over, or deleted in any branch.
 */
async function recoverFromCorruptDatabase(corruptPath: string, error: unknown): Promise<DatabaseRecovery> {
  appendStartupLog(`Database is corrupt. It will be left in place at ${corruptPath}.`, error)
  const snapshot = await findVerifiedSnapshot(backupDirectory(), { onWarning: appendStartupLog })
  if (!snapshot) appendStartupLog('No verified snapshot is available for recovery.')

  const preserved = `The damaged database was left untouched at:\n${corruptPath}`
  for (;;) {
    const choice = askRecoveryChoice(corruptPath, snapshot)
    if (choice === 'quit') {
      appendStartupLog('Startup cancelled by the user; nothing was changed.')
      throw new StartupCancelled('The damaged database was left in place.')
    }

    const target = replacementDatabasePath()
    if (choice === 'snapshot' && snapshot) {
      try {
        fs.copyFileSync(snapshot.path, target)
        await verifyDatabaseFile(target)
        appendStartupLog(`Restored ${snapshot.path} into ${target}.`)
        return {
          dbPath: target,
          summary: [
            preserved,
            `MarCat restored the backup taken ${describeAge(snapshot.takenAt)} into:\n${target}`,
            'Anything changed after that backup is not in it. The damaged file can still be salvaged later.',
          ].join('\n\n'),
        }
      } catch (restoreError) {
        fs.rmSync(target, { force: true })
        appendStartupLog('Restoring the snapshot failed; returning to the recovery options.', restoreError)
        continue
      }
    }

    if (choice === 'salvage') {
      try {
        const report = await salvageDatabase(corruptPath, target, { timeBudgetMs: SALVAGE_TIME_BUDGET_MS })
        appendStartupLog(`Salvage finished.\n${formatSalvageReport(report)}`)
        await verifyDatabaseFile(target)
        return {
          dbPath: target,
          summary: [
            preserved,
            `MarCat recovered what could be read into:\n${target}`,
            formatSalvageReport(report),
          ].join('\n\n'),
        }
      } catch (salvageError) {
        fs.rmSync(target, { force: true })
        appendStartupLog('Salvage failed; returning to the recovery options.', salvageError)
        continue
      }
    }

    appendStartupLog(`Starting with an empty database at ${target}.`)
    return {
      dbPath: target,
      summary: [
        preserved,
        `MarCat is starting with an empty database at:\n${target}`,
        'The damaged file is still on disk and can be salvaged later.',
      ].join('\n\n'),
    }
  }
}

async function initDb(): Promise<DB> {
  let dbPath = readActiveDbPath()
  activeDbPath = dbPath
  // A staged restore (from Settings → Backups) is swapped in here, before the DB opens.
  const restore = join(app.getPath('userData'), 'marcat.restore')
  if (fs.existsSync(restore)) {
    try {
      await verifyDatabaseFile(restore)
      const swap = `${dbPath}.restore-swap`
      const previous = `${dbPath}.restore-previous`
      fs.copyFileSync(restore, swap)
      fs.rmSync(previous, { force: true })
      if (fs.existsSync(dbPath)) fs.renameSync(dbPath, previous)
      try {
        fs.renameSync(swap, dbPath)
      } catch (error) {
        if (fs.existsSync(previous)) fs.renameSync(previous, dbPath)
        throw error
      }
      fs.rmSync(previous, { force: true })
      fs.rmSync(`${dbPath}-wal`, { force: true })
      fs.rmSync(`${dbPath}-shm`, { force: true })
      fs.rmSync(restore)
    } catch (error) {
      appendStartupLog('Staged database restore failed verification; current database was kept.', error)
      /* leave the current DB if the swap fails */
    }
  }

  let opened: Awaited<ReturnType<typeof openPreparedDb>>
  try {
    opened = await openPreparedDb(dbPath)
  } catch (error) {
    if (!isCorruptDatabaseError(error)) throw error
    const recovered = await recoverFromCorruptDatabase(dbPath, error)
    dbPath = recovered.dbPath
    activeDbPath = recovered.dbPath
    rememberActiveDbPath(recovered.dbPath)
    startupRecoveryMessage = recovered.summary
    opened = await openPreparedDb(dbPath)
  }

  const { db: d, client } = opened
  dbClient = client
  db = d
  await d
    .update(aiRuns)
    .set({
      status: 'error',
      summary: 'Interrupted by application restart',
      error: 'Interrupted by application restart',
      finishedAt: new Date().toISOString(),
    })
    .where(eq(aiRuns.status, 'running'))
  await backupOnLaunch(d, dbPath)
  return d
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: iconPath(),
    backgroundColor: '#16161A',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  createIPCHandler({
    router: appRouter,
    windows: [win],
    createContext: async () => {
      if (!db) throw new Error('Database not initialized')
      return {
        db,
        workspace,
        agent,
        secrets,
        appPaths: {
          dbPath: activeDbPath || defaultDatabasePath(),
          mcpServerPath: mcpServerPath(),
          mcpUrl: MARCAT_MCP_HTTP_URL,
          appVersion: app.getVersion(),
          changelogPath: changelogPath(),
        },
        wakeCreatorDiscovery: () => youtubeDiscoveryWorker?.wake(),
        wakeCreatorPromotion: () => creatorPromotionWorker?.wake(),
      }
    },
  })

  const rendererRecoveryAttempts: number[] = []
  let rendererReloadTimer: NodeJS.Timeout | undefined
  const scheduleRendererRecovery = (reason: string): void => {
    const now = Date.now()
    while (rendererRecoveryAttempts.length > 0 && now - rendererRecoveryAttempts[0]! > 60_000) {
      rendererRecoveryAttempts.shift()
    }
    if (rendererRecoveryAttempts.length >= 3) {
      appendStartupLog(`Renderer auto-recovery suppressed after repeated failures: ${reason}.`)
      if (!win.isDestroyed() && !win.isVisible()) win.show()
      return
    }
    rendererRecoveryAttempts.push(now)
    if (rendererReloadTimer) clearTimeout(rendererReloadTimer)
    rendererReloadTimer = setTimeout(() => {
      rendererReloadTimer = undefined
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      appendStartupLog(`Reloading renderer after failure: ${reason}.`)
      win.webContents.reload()
    }, 300)
  }

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('close', () => {
    appendStartupLog('Main window close requested.')
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    appendStartupLog(`Renderer failed to load ${validatedURL}: ${errorCode} ${errorDescription}`)
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    appendStartupLog(`Renderer preload failed: ${preloadPath}.`, error)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    appendStartupLog(`Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}.`)
    if (details.reason !== 'clean-exit') scheduleRendererRecovery(`${details.reason}/${details.exitCode}`)
  })
  win.webContents.on('unresponsive', () => {
    appendStartupLog('Renderer became unresponsive.')
  })
  win.webContents.on('responsive', () => {
    appendStartupLog('Renderer became responsive again.')
  })
  win.on('closed', () => {
    if (rendererReloadTimer) clearTimeout(rendererReloadTimer)
    appendStartupLog('Main window closed.')
    if (mainWindow === win) mainWindow = undefined
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const isTrustedRendererUrl = (url: string): boolean => {
    try {
      if (rendererUrl) return new URL(url).origin === new URL(rendererUrl).origin
      return (
        new URL(url).protocol === 'file:' &&
        resolve(fileURLToPath(url)) === resolve(join(__dirname, '../renderer/index.html'))
      )
    } catch {
      return false
    }
  }
  const openExternalIfSafe = (url: string): void => {
    try {
      const protocol = new URL(url).protocol
      if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url)
    } catch {
      /* ignore malformed and non-web URLs */
    }
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return
    event.preventDefault()
    openExternalIfSafe(url)
  })

  const loaded = rendererUrl ? win.loadURL(rendererUrl) : win.loadFile(join(__dirname, '../renderer/index.html'))
  void loaded.catch((error) => {
    appendStartupLog('Renderer load failed.', error)
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  })
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 3000)

  mainWindow = win
  return win
}

process.on('uncaughtException', (error) => {
  appendStartupLog('Uncaught exception.', error)
})

process.on('unhandledRejection', (error) => {
  appendStartupLog('Unhandled rejection.', error)
})

process.on('exit', (code) => {
  appendStartupLog(`Main process exit event: code ${code}.`)
})

app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit') return
  appendStartupLog(
    `Child process gone: type=${details.type}, name=${details.name ?? 'unknown'}, reason=${details.reason}, exitCode=${details.exitCode}.`,
  )
})

// Single-instance: a second launch focuses the existing window instead of
// opening a duplicate (duplicate/stale windows steal focus and clicks).
if (!app.requestSingleInstanceLock()) {
  appendStartupLog('Exiting duplicate application instance.')
  app.quit()
} else {
  app.on('second-instance', () => {
    appendStartupLog('Second launch requested; focusing the existing window.')
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // Renderer → main helpers (Settings backups, MCP folder reveal).
  const isTrustedIpcSender = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
    Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents)

  ipcMain.on('marcat:renderer-error', (event, report: unknown) => {
    if (!isTrustedIpcSender(event)) return
    appendRendererLog(report, event.sender.getURL())
  })

  ipcMain.on('marcat:relaunch', (event) => {
    if (!isTrustedIpcSender(event)) return
    appendStartupLog('Application relaunch requested from Settings.')
    app.relaunch()
    app.exit(0)
  })
  ipcMain.on('marcat:openBackupsFolder', (event) => {
    if (!isTrustedIpcSender(event)) return
    const dbPath = activeDbPath || defaultDatabasePath()
    const path = join(dirname(dbPath), 'backups')
    fs.mkdirSync(path, { recursive: true })
    void shell.openPath(path)
  })
  ipcMain.handle('marcat:chooseProjectFolder', async (event) => {
    if (!isTrustedIpcSender(event)) return null
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose project folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length !== 1) return null
    try {
      const selected = fs.realpathSync(result.filePaths[0]!)
      return isAbsolute(selected) && fs.statSync(selected).isDirectory() ? selected : null
    } catch {
      return null
    }
  })
  ipcMain.handle('marcat:openLocalPath', async (event, requestedPath: unknown) => {
    if (!isTrustedIpcSender(event) || typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) {
      return { ok: false as const, error: 'Invalid local path' }
    }
    try {
      const canonicalPath = fs.realpathSync(requestedPath)
      const info = fs.statSync(canonicalPath)
      if (info.isDirectory()) {
        const error = await shell.openPath(canonicalPath)
        return error ? { ok: false as const, error } : { ok: true as const }
      }
      if (info.isFile()) {
        shell.showItemInFolder(canonicalPath)
        return { ok: true as const }
      }
      return { ok: false as const, error: 'Path is not a regular file or directory' }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.on('marcat:showFileContextMenu', (event, request: unknown) => {
    if (!isTrustedIpcSender(event) || !request || typeof request !== 'object') return
    const value = request as Record<string, unknown>
    const requestedPath = typeof value.path === 'string' && isAbsolute(value.path) ? value.path : null
    let isFile = false
    try {
      isFile = Boolean(requestedPath && fs.statSync(requestedPath).isFile())
    } catch {
      // A stale or inaccessible source path stays visible as a disabled menu item.
    }
    const openLabel = typeof value.openLabel === 'string' ? value.openLabel.slice(0, 100) : 'Open file location'
    const missingLabel =
      typeof value.missingLabel === 'string' ? value.missingLabel.slice(0, 100) : 'No local file specified'

    Menu.buildFromTemplate([
      {
        label: isFile ? openLabel : missingLabel,
        enabled: isFile,
        click: () => {
          if (requestedPath) shell.showItemInFolder(requestedPath)
        },
      },
    ]).popup({ window: mainWindow })
  })

  void app
    .whenReady()
    .then(async () => {
      const database = await initDb()
      workspace = new MarkdownWorkspaceCoordinator(new DrizzleWorkspaceRepository(database), {
        onError: (error) => appendStartupLog('Markdown workspace synchronization failed.', error),
      })
      await workspace.start()
      secrets = createSecrets()
      // Wire the embedded AI agent to the selected subscription-backed CLI.
      const aiCliAvailability = { claude: claudeAvailable(), codex: codexAvailable() }
      agent =
        aiCliAvailability.claude || aiCliAvailability.codex
          ? createAgentRunner(
              () => secrets?.getClaudeToken(),
              () => secrets?.getAiProvider(),
              aiCliAvailability,
            )
          : undefined
      createWindow()
      mcpHttpWorker = setupMcpHttpWorker(activeDbPath ?? defaultDatabasePath(), mcpServerPath(), appendStartupLog)
      if (startupRecoveryMessage) {
        dialog
          .showMessageBox({
            type: 'warning',
            title: 'MarCat database recovered',
            message: 'MarCat recovered from a corrupt database.',
            detail: startupRecoveryMessage,
          })
          .catch(() => {})
      }
      setupSteamWatchers(database, secrets)
      setupGmassWorker(database, secrets)
      youtubeDiscoveryWorker = setupYoutubeDiscoveryWorker(
        database,
        activeDbPath ?? defaultDatabasePath(),
        secrets,
        workspace,
        appendStartupLog,
      )
      creatorPromotionWorker = setupCreatorPromotionWorker(
        database,
        activeDbPath ?? defaultDatabasePath(),
        workspace,
        appendStartupLog,
      )
      setupFeedbackWorker(database, secrets)
      const syncFinancials = () => {
        const key = secrets?.getApiKey('steamfinancial')
        if (key) void syncSteamFinancials(database, key).catch(() => {})
      }
      syncFinancials()
      setInterval(syncFinancials, 6 * 60 * 60 * 1_000)

      // Periodically flush the WAL into the main file so the durable DB stays current
      // even if the app is killed abruptly.
      setInterval(() => {
        if (dbClient) void checkpoint(dbClient, 'PASSIVE')
      }, 60_000)

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error) => {
      if (error instanceof StartupCancelled) {
        app.exit(0)
        return
      }
      appendStartupLog('MarCat failed to start.', error)
      dialog.showErrorBox('MarCat failed to start', formatError(error))
      app.quit()
    })

  // Final flush on quit so nothing is left stranded in the WAL.
  let shuttingDown = false
  app.on('before-quit', () => {
    appendStartupLog('Application quit requested.')
  })
  app.on('will-quit', (e) => {
    if (shuttingDown || !dbClient) return
    shuttingDown = true
    e.preventDefault()
    void (async () => {
      agent?.cancelAll?.()
      youtubeDiscoveryWorker?.stop()
      creatorPromotionWorker?.stop()
      mcpHttpWorker?.stop()
      await workspace?.stop()
      await checkpoint(dbClient, 'TRUNCATE')
      try {
        dbClient.close()
      } catch {
        /* ignore */
      }
      app.exit(0)
    })()
  })

  app.on('window-all-closed', () => {
    appendStartupLog('All application windows closed.')
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('quit', (_event, exitCode) => {
    appendStartupLog(`Application exited with code ${exitCode}.`)
  })
}
