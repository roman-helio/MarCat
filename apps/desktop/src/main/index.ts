import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import fs from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIPCHandler } from 'electron-trpc/main'
import {
  appRouter,
  backfillTaskDescriptionMarkdown,
  DrizzleWorkspaceRepository,
  MarkdownWorkspaceCoordinator,
  syncSteamFinancials,
  type AgentRunner,
  type SecretsStore,
} from '@marcat/core'
import {
  aiRuns,
  backfillTaskKeys,
  checkpoint,
  configureConnection,
  createDb,
  createVerifiedBackup,
  fileUrlFromPath,
  runMigrations,
  seedPublicFestivalCatalogue,
  verifyDatabaseFile,
  type DB,
} from '@marcat/db'
import { eq } from 'drizzle-orm'
import { claudeAvailable, codexAvailable, createAgentRunner } from './agent'
import { createSecrets } from './secrets'
import { setupFeedbackWorker, setupGmassWorker, setupSteamWatchers } from './watchers'

// Set the app name early so getPath('userData') resolves to %APPDATA%/MarCat.
app.setName('MarCat')

let db: DB | undefined
let dbClient: ReturnType<typeof createDb>['client'] | undefined
let agent: AgentRunner | undefined
let secrets: SecretsStore | undefined
let mainWindow: BrowserWindow | undefined
let startupRecoveryMessage: string | undefined
let activeDbPath: string | undefined
let workspace: MarkdownWorkspaceCoordinator | undefined

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message
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

function isCorruptDatabaseError(error: unknown): boolean {
  const text = formatError(error)
  return /SQLITE_CORRUPT|malformed database schema|database disk image is malformed|file is not a database/i.test(text)
}

interface QuarantineResult {
  dest?: string
  existed: boolean
  removedOriginal: boolean
}

function quarantineFile(src: string, dest: string): QuarantineResult {
  if (!fs.existsSync(src)) return { existed: false, removedOriginal: true }
  fs.mkdirSync(join(app.getPath('userData'), 'corrupt'), { recursive: true })
  try {
    fs.renameSync(src, dest)
    return { dest, existed: true, removedOriginal: true }
  } catch (renameError) {
    fs.copyFileSync(src, dest)
    try {
      fs.rmSync(src)
      return { dest, existed: true, removedOriginal: true }
    } catch (removeError) {
      appendStartupLog(`Copied corrupt database file but could not remove locked original: ${src}`, removeError)
      appendStartupLog('Original rename error.', renameError)
      return { dest, existed: true, removedOriginal: false }
    }
  }
}

function quarantineDatabaseFiles(dbPath: string): QuarantineResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = join(app.getPath('userData'), 'corrupt', `marcat-${stamp}.db`)
  const main = quarantineFile(dbPath, base)
  quarantineFile(`${dbPath}-wal`, `${base}-wal`)
  quarantineFile(`${dbPath}-shm`, `${base}-shm`)
  return main
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

function recoveryDatabasePath(currentDbPath: string): string {
  const userData = app.getPath('userData')
  const stable = join(userData, 'marcat-recovered.db')
  if (resolve(currentDbPath) !== resolve(stable)) return stable
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(userData, `marcat-recovered-${stamp}.db`)
}

/**
 * Rotating snapshot taken at every launch (after the WAL is flushed) so a corrupted
 * session or accidental wipe is always recoverable. Keeps the 5 most recent.
 */
async function backupOnLaunch(database: DB, dbPath: string): Promise<void> {
  try {
    if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size < 4096) return
    const dir = join(app.getPath('userData'), 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await createVerifiedBackup(database, join(dir, `marcat-auto-${stamp}.db`))
    const autos = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('marcat-auto-') && f.endsWith('.db'))
      .sort()
    for (const f of autos.slice(0, Math.max(0, autos.length - 5))) {
      try {
        fs.rmSync(join(dir, f))
      } catch {
        /* ignore */
      }
    }
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

    appendStartupLog('Database is corrupt; moving it aside and creating a fresh database.', error)
    const quarantine = quarantineDatabaseFiles(dbPath)
    const nextDbPath = quarantine.removedOriginal ? dbPath : recoveryDatabasePath(dbPath)
    dbPath = nextDbPath
    activeDbPath = nextDbPath
    rememberActiveDbPath(nextDbPath)
    startupRecoveryMessage = quarantine.dest
      ? `The previous database was corrupt and has been copied to:\n${quarantine.dest}\n\nMarCat is now using:\n${nextDbPath}`
      : `The previous database was corrupt. MarCat is now using:\n${nextDbPath}`
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
          appVersion: app.getVersion(),
          changelogPath: changelogPath(),
        },
      }
    },
  })

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    appendStartupLog(`Renderer failed to load ${validatedURL}: ${errorCode} ${errorDescription}`)
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  })
  win.on('closed', () => {
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

// Single-instance: a second launch focuses the existing window instead of
// opening a duplicate (duplicate/stale windows steal focus and clicks).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // Renderer → main helpers (Settings backups, MCP folder reveal).
  const isTrustedIpcSender = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
    Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents)

  ipcMain.on('marcat:relaunch', (event) => {
    if (!isTrustedIpcSender(event)) return
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
      appendStartupLog('MarCat failed to start.', error)
      dialog.showErrorBox('MarCat failed to start', formatError(error))
      app.quit()
    })

  // Final flush on quit so nothing is left stranded in the WAL.
  let shuttingDown = false
  app.on('will-quit', (e) => {
    if (shuttingDown || !dbClient) return
    shuttingDown = true
    e.preventDefault()
    void (async () => {
      agent?.cancelAll?.()
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
    if (process.platform !== 'darwin') app.quit()
  })
}
