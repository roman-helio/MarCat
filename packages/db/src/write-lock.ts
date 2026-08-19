import fs from 'node:fs'
import os from 'node:os'
import { resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

export interface DatabaseWriteLockOptions {
  acquireTimeoutMs?: number
  staleAfterMs?: number
  heartbeatMs?: number
}

export interface DatabaseWriteLockOwner {
  token: string
  pid: number
  host: string
  acquiredAt: string
  purpose: string
}

export class DatabaseWriteLockTimeoutError extends Error {
  readonly code = 'MARCAT_DB_WRITE_LOCK_TIMEOUT'

  constructor(
    readonly lockPath: string,
    readonly waitedMs: number,
    readonly owner: DatabaseWriteLockOwner | null,
  ) {
    const ownerDescription = owner ? ` (owner pid ${owner.pid}, ${owner.purpose})` : ''
    super(`MarCat database write queue timed out after ${waitedMs}ms${ownerDescription}`)
    this.name = 'DatabaseWriteLockTimeoutError'
  }
}

const wait = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms))
const writePurpose = new AsyncLocalStorage<string>()

/** Attach a human-readable owner to every nested database write without holding the lock between writes. */
export function withDatabaseWritePurpose<T>(purpose: string, operation: () => T): T {
  return writePurpose.run(purpose, operation)
}

export function currentDatabaseWritePurpose(fallback: string): string {
  return writePurpose.getStore() ?? fallback
}

function databasePathFromFileUrl(fileUrl: string): string | null {
  if (!fileUrl.toLowerCase().startsWith('file:')) return null
  let path = decodeURIComponent(fileUrl.slice('file:'.length))
  if (process.platform === 'win32') {
    path = path.replace(/^\/+([a-zA-Z]:)/, '$1').replace(/\//g, sep)
  }
  return resolve(path)
}

function readOwner(lockPath: string): DatabaseWriteLockOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<DatabaseWriteLockOwner>
    return typeof value.token === 'string' && typeof value.pid === 'number'
      ? {
          token: value.token,
          pid: value.pid,
          host: typeof value.host === 'string' ? value.host : 'unknown',
          acquiredAt: typeof value.acquiredAt === 'string' ? value.acquiredAt : 'unknown',
          purpose: typeof value.purpose === 'string' ? value.purpose : 'database write',
        }
      : null
  } catch {
    return null
  }
}

function ownerProcessState(owner: DatabaseWriteLockOwner | null): 'alive' | 'gone' | 'unknown' {
  if (!owner || owner.host !== os.hostname()) return 'unknown'
  if (owner.pid === process.pid) return 'alive'
  try {
    process.kill(owner.pid, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'
  }
}

/**
 * Cross-process cooperative lock for the one writer supported by local SQLite.
 *
 * The lock file is created with O_EXCL, which is atomic across MarCat's Electron,
 * MCP and worker processes. A heartbeat makes abandoned locks recoverable after a
 * crash without stealing a lock from a long but healthy transaction.
 */
export class DatabaseWriteLock {
  readonly databasePath: string
  readonly lockPath: string
  private readonly acquireTimeoutMs: number
  private readonly staleAfterMs: number
  private readonly heartbeatMs: number

  constructor(databasePath: string, options: DatabaseWriteLockOptions = {}) {
    this.databasePath = resolve(databasePath)
    this.lockPath = `${this.databasePath}.marcat-write-lock`
    this.acquireTimeoutMs = Math.max(1_000, options.acquireTimeoutMs ?? 60_000)
    this.staleAfterMs = Math.max(30_000, options.staleAfterMs ?? 5 * 60_000)
    this.heartbeatMs = Math.max(1_000, Math.min(options.heartbeatMs ?? 2_000, this.staleAfterMs / 3))
  }

  private async breakAbandonedLock(): Promise<boolean> {
    const owner = readOwner(this.lockPath)
    let firstMtime: number
    try {
      firstMtime = fs.statSync(this.lockPath).mtimeMs
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
    const ownerState = ownerProcessState(owner)
    // A live local process may have a blocked event loop and miss heartbeats; never
    // create two writers merely because its transaction is unusually slow.
    if (ownerState === 'alive') return false
    if (ownerState !== 'gone' && Date.now() - firstMtime <= this.staleAfterMs) return false

    // Recheck after a heartbeat window. Never steal a lock that became live again.
    await wait(Math.min(50, this.heartbeatMs))
    let secondMtime: number
    try {
      secondMtime = fs.statSync(this.lockPath).mtimeMs
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
    if (secondMtime !== firstMtime || (ownerState !== 'gone' && Date.now() - secondMtime <= this.staleAfterMs))
      return false

    const abandonedPath = `${this.lockPath}.abandoned-${process.pid}-${randomUUID()}`
    try {
      fs.renameSync(this.lockPath, abandonedPath)
      fs.rmSync(abandonedPath, { force: true })
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return false
      throw error
    }
  }

  async acquire(purpose = 'database write'): Promise<() => void> {
    const startedAt = Date.now()
    const token = randomUUID()
    const owner: DatabaseWriteLockOwner = {
      token,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
      purpose,
    }

    while (true) {
      let fd: number | null = null
      try {
        fd = fs.openSync(this.lockPath, 'wx')
        fs.writeFileSync(fd, JSON.stringify(owner), 'utf8')
        const heartbeat = setInterval(() => {
          try {
            const now = new Date()
            fs.utimesSync(this.lockPath, now, now)
          } catch {
            // A missing/replaced lock is detected by the token check on release.
          }
        }, this.heartbeatMs)
        heartbeat.unref?.()

        let released = false
        return () => {
          if (released) return
          released = true
          clearInterval(heartbeat)
          try {
            if (fd != null) fs.closeSync(fd)
          } finally {
            // A stale-lock recovery may have replaced the path. Only remove ours.
            if (readOwner(this.lockPath)?.token === token) {
              try {
                fs.rmSync(this.lockPath, { force: true })
              } catch {
                // A later acquisition will recover the stale lock if cleanup fails.
              }
            }
          }
        }
      } catch (error) {
        if (fd != null) {
          try {
            fs.closeSync(fd)
          } catch {
            // Best-effort cleanup after a partially-created lock file.
          }
          try {
            fs.rmSync(this.lockPath, { force: true })
          } catch {
            // A later acquisition can recover the incomplete lock file.
          }
        }
        const code = (error as NodeJS.ErrnoException).code
        if (!['EEXIST', 'EACCES', 'EPERM', 'EBUSY'].includes(code ?? '')) throw error
        await this.breakAbandonedLock()
        const waitedMs = Date.now() - startedAt
        if (waitedMs >= this.acquireTimeoutMs) {
          throw new DatabaseWriteLockTimeoutError(this.lockPath, waitedMs, readOwner(this.lockPath))
        }
        const delay = Math.min(100, 10 + Math.floor(waitedMs / 250)) + Math.floor(Math.random() * 10)
        await wait(delay)
      }
    }
  }

  async run<T>(operation: () => Promise<T>, purpose?: string): Promise<T> {
    const release = await this.acquire(purpose)
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export function databaseWriteLockForUrl(fileUrl: string, options?: DatabaseWriteLockOptions): DatabaseWriteLock | null {
  const databasePath = databasePathFromFileUrl(fileUrl)
  return databasePath ? new DatabaseWriteLock(databasePath, options) : null
}
