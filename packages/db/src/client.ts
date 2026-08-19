import { createClient, type Client, type InStatement, type Transaction, type TransactionMode } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import * as schema from './schema'
import { withSqliteBusyRetry } from './retry'
import { currentDatabaseWritePurpose, databaseWriteLockForUrl, type DatabaseWriteLock } from './write-lock'

export type DB = LibSQLDatabase<typeof schema>

export interface CreateDbResult {
  db: DB
  client: Client
  writeLock: DatabaseWriteLock | null
}

function statementSql(statement: InStatement): string {
  return typeof statement === 'string' ? statement : statement.sql
}

function sqlKeyword(sql: string): string {
  const withoutLeadingComments = sql.replace(/^\s*(?:(?:--[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/))\s*/g, '')
  return (
    withoutLeadingComments
      .trimStart()
      .match(/^([a-zA-Z]+)/)?.[1]
      ?.toUpperCase() ?? 'SQL'
  )
}

function isReadOnlyStatement(statement: InStatement): boolean {
  return ['SELECT', 'EXPLAIN', 'VALUES'].includes(sqlKeyword(statementSql(statement)))
}

function needsExplicitCommit(statement: InStatement): boolean {
  return ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH'].includes(sqlKeyword(statementSql(statement)))
}

/**
 * SQLite RETURNING can yield rows before the implicit autocommit is finalized.
 * Await an explicit commit so callers never observe a write that is later rolled
 * back when an older/external process holds the database lock.
 */
async function inCommittedWriteTransaction<T>(client: Client, operation: (transaction: Transaction) => Promise<T>) {
  const transaction = await client.transaction('write')
  try {
    const result = await operation(transaction)
    await transaction.commit()
    return result
  } catch (error) {
    if (!transaction.closed) {
      try {
        await transaction.rollback()
      } catch {
        // Preserve the original write/commit error for retry classification.
      }
    }
    throw error
  } finally {
    if (!transaction.closed) transaction.close()
  }
}

function lockedTransaction(transaction: Transaction, release: () => void): Transaction {
  let released = false
  const releaseOnce = () => {
    if (released) return
    released = true
    release()
  }
  return {
    execute: (statement) => transaction.execute(statement),
    batch: (statements) => transaction.batch(statements),
    executeMultiple: (sql) => transaction.executeMultiple(sql),
    async rollback() {
      try {
        await transaction.rollback()
      } finally {
        releaseOnce()
      }
    },
    async commit() {
      await transaction.commit()
      releaseOnce()
    },
    close() {
      try {
        transaction.close()
      } finally {
        releaseOnce()
      }
    },
    get closed() {
      return transaction.closed
    },
  }
}

function coordinateLocalWrites(client: Client, writeLock: DatabaseWriteLock | null): Client {
  if (!writeLock) return client
  const runWrite = <T>(operation: () => Promise<T>, purpose: string) =>
    writeLock.run(() => withSqliteBusyRetry(operation), currentDatabaseWritePurpose(purpose))

  return {
    execute: (statement) =>
      isReadOnlyStatement(statement)
        ? client.execute(statement)
        : runWrite(
            () =>
              needsExplicitCommit(statement)
                ? inCommittedWriteTransaction(client, (transaction) => transaction.execute(statement))
                : client.execute(statement),
            `SQL ${sqlKeyword(statementSql(statement))}`,
          ),
    batch: (statements, mode) =>
      statements.every(isReadOnlyStatement) && mode !== 'write'
        ? client.batch(statements, mode)
        : runWrite(
            () => inCommittedWriteTransaction(client, (transaction) => transaction.batch(statements)),
            'SQL batch',
          ),
    migrate: (statements) => runWrite(() => client.migrate(statements), 'database migration'),
    async transaction(mode?: TransactionMode) {
      const effectiveMode = mode ?? 'write'
      if (effectiveMode === 'read') return client.transaction(effectiveMode)
      const release = await writeLock.acquire(currentDatabaseWritePurpose(`SQL transaction (${effectiveMode})`))
      try {
        const transaction = await withSqliteBusyRetry(() => client.transaction(effectiveMode))
        return lockedTransaction(transaction, release)
      } catch (error) {
        release()
        throw error
      }
    },
    executeMultiple: (sql) => runWrite(() => client.executeMultiple(sql), 'SQL script'),
    sync: () => runWrite(() => client.sync(), 'database sync'),
    close: () => client.close(),
    get closed() {
      return client.closed
    },
    get protocol() {
      return client.protocol
    },
  }
}

/**
 * Open (or create) a local libsql/SQLite database.
 *
 * @param fileUrl A libsql URL. For a local file pass `file:` + an absolute path,
 *                e.g. `file:C:/Users/you/AppData/Roaming/MarCat/marcat.db`.
 */
export function createDb(fileUrl: string): CreateDbResult {
  const writeLock = databaseWriteLockForUrl(fileUrl)
  const client = coordinateLocalWrites(createClient({ url: fileUrl }), writeLock)
  const db = drizzle(client, { schema })
  return { db, client, writeLock }
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
