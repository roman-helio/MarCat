import { migrate } from 'drizzle-orm/libsql/migrator'
import type { Client } from '@libsql/client'
import type { DB } from './client'

/**
 * Apply pending migrations and enable WAL (so the desktop app, the embedded AI
 * agent, and external MCP clients can read concurrently against one file).
 */
export async function runMigrations(db: DB, client: Client, migrationsFolder: string): Promise<void> {
  await client.execute('PRAGMA journal_mode = WAL;')
  await client.execute('PRAGMA foreign_keys = ON;')
  await migrate(db, { migrationsFolder })
}
