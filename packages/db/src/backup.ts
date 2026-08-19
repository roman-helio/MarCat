import fs from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { fileUrlFromPath, type DB } from './client'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Subdirectory for in-flight snapshots, so a half-written file is never mistaken for a backup. */
const STAGING_DIR = '.staging'

export type BackupWarning = (message: string, error?: unknown) => void

async function retryWindowsFileOp(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await operation()
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      await wait(20 * (attempt + 1))
    }
  }
  throw lastError
}

async function removeIfPresent(path: string, onWarning?: BackupWarning): Promise<void> {
  try {
    await retryWindowsFileOp(() => fs.promises.rm(path, { force: true }))
  } catch (error) {
    // Cleanup must never hide the snapshot/verification error that caused it,
    // but it must not vanish either: silently failing here once per launch is
    // how a backups folder grows to gigabytes of leftovers unnoticed.
    onWarning?.(`Could not delete ${path}`, error)
  }
}

function stagingDir(destination: string): string {
  return join(dirname(destination), STAGING_DIR)
}

/** Verify that a standalone SQLite file opens and passes a full integrity check. */
export async function verifyDatabaseFile(path: string): Promise<void> {
  if (!fs.existsSync(path) || fs.statSync(path).size < 4096) throw new Error('Database snapshot is empty')
  const client = createClient({ url: fileUrlFromPath(path) })
  try {
    const result = await client.execute('PRAGMA integrity_check')
    if (String(result.rows[0]?.integrity_check ?? '') !== 'ok') {
      throw new Error('Database snapshot failed integrity check')
    }
  } finally {
    client.close()
    // libsql's native worker releases the Windows file handle just after close().
    await wait(20)
  }
}

/**
 * Create a transactionally consistent standalone snapshot while writers may be active.
 * VACUUM INTO is SQLite's online snapshot primitive and includes committed WAL pages.
 *
 * The working copy is written to a staging subdirectory rather than next to the
 * finished snapshots: libsql on Windows can hold the file handle past
 * integrity_check, and a delete that loses that race must not leave a full-size
 * file where snapshot listing and rotation will never look at it.
 */
export async function createVerifiedBackup(db: DB, destination: string, onWarning?: BackupWarning): Promise<void> {
  const staging = stagingDir(destination)
  const partial = join(staging, `${basename(destination)}.partial`)
  fs.mkdirSync(dirname(destination), { recursive: true })
  fs.mkdirSync(staging, { recursive: true })
  await removeIfPresent(partial, onWarning)
  try {
    const quoted = partial.replace(/'/g, "''")
    await db.run(sql.raw(`VACUUM INTO '${quoted}'`))
    await verifyDatabaseFile(partial)
    await removeIfPresent(destination, onWarning)
    // libsql can retain a short-lived read handle after integrity_check on Windows.
    // Copying the verified immutable snapshot avoids renaming that locked file.
    await fs.promises.copyFile(partial, destination)
    await verifyDatabaseFile(destination)
    await removeIfPresent(partial, onWarning)
  } catch (error) {
    await removeIfPresent(partial, onWarning)
    throw error
  }
}

/**
 * Reclaim staged files that are provably redundant, and nothing else.
 *
 * A `.partial` left next to a finished snapshot of the same size is a duplicate
 * of a file that already exists, so deleting it loses nothing. A `.partial`
 * with no finished counterpart is the opposite: the cleanup step failed after
 * the snapshot was verified but before it was copied, or the finished copy was
 * rotated away later, which makes the leftover the only surviving copy of that
 * snapshot. Those are kept and reported, never swept.
 */
export async function cleanupBackupStaging(backupDir: string, onWarning?: BackupWarning): Promise<number> {
  let reclaimed = 0
  const remove = async (path: string): Promise<void> => {
    try {
      const size = fs.statSync(path).size
      await retryWindowsFileOp(() => fs.promises.rm(path, { force: true }))
      reclaimed += size
    } catch (error) {
      onWarning?.(`Could not remove leftover snapshot ${path}`, error)
    }
  }

  const staging = join(backupDir, STAGING_DIR)
  if (fs.existsSync(staging)) {
    for (const name of fs.readdirSync(staging)) await remove(join(staging, name))
  }

  if (!fs.existsSync(backupDir)) return reclaimed
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.endsWith('.partial')) continue
    const path = join(backupDir, name)
    const finished = join(backupDir, name.slice(0, -'.partial'.length))
    try {
      if (!fs.existsSync(finished)) continue
      if (fs.statSync(finished).size !== fs.statSync(path).size) continue
    } catch {
      continue
    }
    await remove(path)
  }
  return reclaimed
}

/**
 * Leftover `.partial` files that no finished snapshot duplicates. Each one is a
 * complete, verified database that simply never got its final name.
 */
export function listOrphanedPartials(backupDir: string): DatabaseSnapshot[] {
  if (!fs.existsSync(backupDir)) return []
  const orphans: DatabaseSnapshot[] = []
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.endsWith('.db.partial')) continue
    const path = join(backupDir, name)
    if (fs.existsSync(join(backupDir, name.slice(0, -'.partial'.length)))) continue
    try {
      const stats = fs.statSync(path)
      if (stats.isFile() && stats.size >= 4096) orphans.push({ path, takenAt: stats.mtime, size: stats.size })
    } catch {
      /* unreadable entry */
    }
  }
  return orphans.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())
}

export interface DatabaseSnapshot {
  path: string
  takenAt: Date
  size: number
}

/**
 * Finished snapshots in `backupDir`, newest first. Staged and partial files are
 * excluded by construction: they never carry a plain `.db` suffix.
 */
export function listDatabaseSnapshots(backupDir: string, match?: (name: string) => boolean): DatabaseSnapshot[] {
  if (!fs.existsSync(backupDir)) return []
  const snapshots: DatabaseSnapshot[] = []
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.endsWith('.db')) continue
    if (match && !match(name)) continue
    const path = join(backupDir, name)
    try {
      const stats = fs.statSync(path)
      if (!stats.isFile()) continue
      snapshots.push({ path, takenAt: stats.mtime, size: stats.size })
    } catch {
      /* unreadable entry */
    }
  }
  return snapshots.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())
}

/**
 * The newest snapshot that actually opens and passes integrity_check, walking
 * back through older ones until one does. A snapshot is only worth anything if
 * it has been verified at the moment it is needed, not at the moment it was
 * taken.
 */
export async function findVerifiedSnapshot(
  backupDir: string,
  options: { match?: (name: string) => boolean; onWarning?: BackupWarning } = {},
): Promise<DatabaseSnapshot | undefined> {
  // Orphaned `.partial` files are candidates too: they are finished, verified
  // snapshots that only lack their final name, and refusing to look at them
  // would be discarding real backups over a filename.
  const candidates = [...listDatabaseSnapshots(backupDir, options.match), ...listOrphanedPartials(backupDir)].sort(
    (a, b) => b.takenAt.getTime() - a.takenAt.getTime(),
  )
  for (const snapshot of candidates) {
    try {
      await verifyDatabaseFile(snapshot.path)
      return snapshot
    } catch (error) {
      options.onWarning?.(`Snapshot rejected by integrity check: ${snapshot.path}`, error)
    }
  }
  return undefined
}
