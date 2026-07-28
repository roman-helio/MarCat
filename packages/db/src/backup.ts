import fs from 'node:fs'
import { dirname } from 'node:path'
import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { fileUrlFromPath, type DB } from './client'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function removeIfPresent(path: string): Promise<void> {
  try {
    await retryWindowsFileOp(() => fs.promises.rm(path, { force: true }))
  } catch {
    // Cleanup must never hide the snapshot/verification error that caused it.
  }
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
 */
export async function createVerifiedBackup(db: DB, destination: string): Promise<void> {
  const partial = `${destination}.partial`
  fs.mkdirSync(dirname(destination), { recursive: true })
  await removeIfPresent(partial)
  try {
    const quoted = partial.replace(/'/g, "''")
    await db.run(sql.raw(`VACUUM INTO '${quoted}'`))
    await verifyDatabaseFile(partial)
    await removeIfPresent(destination)
    // libsql can retain a short-lived read handle after integrity_check on Windows.
    // Copying the verified immutable snapshot avoids renaming that locked file.
    await fs.promises.copyFile(partial, destination)
    await verifyDatabaseFile(destination)
    await removeIfPresent(partial)
  } catch (error) {
    await removeIfPresent(partial)
    throw error
  }
}
