import { createClient, type Client } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import * as schema from './schema'

export type DB = LibSQLDatabase<typeof schema>

export interface CreateDbResult {
  db: DB
  client: Client
}

/**
 * Open (or create) a local libsql/SQLite database.
 *
 * @param fileUrl A libsql URL. For a local file pass `file:` + an absolute path,
 *                e.g. `file:C:/Users/you/AppData/Roaming/MarCat/marcat.db`.
 */
export function createDb(fileUrl: string): CreateDbResult {
  const client = createClient({ url: fileUrl })
  const db = drizzle(client, { schema })
  return { db, client }
}

/**
 * Durability + concurrency pragmas for the long-lived desktop/MCP connection.
 * WAL keeps readers and writers independent. A moderate auto-checkpoint avoids
 * checkpointing almost every commit while keeping the WAL bounded.
 */
export async function configureConnection(client: Client): Promise<void> {
  await client.execute('PRAGMA journal_mode=WAL')
  // FULL = fsync every commit (durable across power loss / hard crash, not just a process kill).
  await client.execute('PRAGMA synchronous=FULL')
  await client.execute('PRAGMA foreign_keys=ON')
  await client.execute('PRAGMA busy_timeout=5000')
  await client.execute('PRAGMA wal_autocheckpoint=256')
}

/** Best-effort flush of the WAL into the main file (call periodically + on quit). */
export async function checkpoint(client: Client, mode: 'PASSIVE' | 'TRUNCATE' = 'PASSIVE'): Promise<void> {
  try {
    await client.execute(`PRAGMA wal_checkpoint(${mode})`)
  } catch {
    /* best effort — a busy checkpoint is retried on the next tick */
  }
}

/** Build a libsql `file:` URL from an absolute filesystem path (cross-platform). */
export function fileUrlFromPath(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/')
  return `file:${normalized}`
}
