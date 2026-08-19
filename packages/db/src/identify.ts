import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { fileUrlFromPath } from './client'

/**
 * Telling two MarCat databases apart by eye is not possible: a stale one can
 * differ from the live one by a handful of rows out of thousands, and the
 * difference that matters (a lost pipeline entry, a missing wishlist point) is
 * invisible in the UI until someone goes looking for it.
 *
 * So the app never asks a person to judge. It reads both files and states the
 * facts that actually separate them - how much is in each, and when each was
 * last changed.
 */

/** Tables whose size and freshness identify a database at a glance. */
const IDENTITY_TABLES = [
  'games',
  'creators',
  'creator_picks',
  'tasks',
  'events',
  'insights',
  'wishlist_points',
  'tags',
  'utm_links',
  'industry_events',
] as const

export interface DatabaseSummary {
  path: string
  sizeBytes: number
  /** Filesystem timestamp - useful, but a copy inherits it, so never decisive on its own. */
  modifiedAt: Date
  /** True when the file opens and passes a quick structural check. */
  readable: boolean
  migrations: number
  counts: Record<string, number>
  totalRows: number
  /** Newest `updated_at`/`created_at` found in the data itself. */
  newestChange?: string
  error?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read a candidate without touching it. Opening a WAL database checkpoints it,
 * which rewrites a file that may be someone's only backup, so every read happens
 * against a private copy.
 */
async function withCopy<T>(source: string, run: (copy: string) => Promise<T>): Promise<T> {
  // Deliberately not beside the source: a working copy dropped into the data
  // folder is a database-shaped file that the next scan would find and rank.
  const dir = fs.mkdtempSync(join(tmpdir(), 'marcat-identify-'))
  const copy = join(dir, 'candidate.db')
  try {
    fs.copyFileSync(source, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${source}${suffix}`)) fs.copyFileSync(`${source}${suffix}`, `${copy}${suffix}`)
    }
    return await run(copy)
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* reclaimed later */
    }
  }
}

async function newestChangeIn(client: Client, tables: string[]): Promise<string | undefined> {
  let newest: string | undefined
  for (const table of tables) {
    for (const column of ['updated_at', 'created_at']) {
      try {
        const result = await client.execute(`SELECT max("${column}") AS newest FROM "${table}"`)
        const value = result.rows[0]?.newest
        if (typeof value === 'string' && (!newest || value > newest)) newest = value
      } catch {
        // Column or table absent in this schema version.
      }
    }
  }
  return newest
}

/** Everything needed to say which of two databases is the one to keep working in. */
export async function summarizeDatabase(path: string): Promise<DatabaseSummary> {
  const stats = fs.existsSync(path) ? fs.statSync(path) : undefined
  const summary: DatabaseSummary = {
    path,
    sizeBytes: stats?.size ?? 0,
    modifiedAt: stats?.mtime ?? new Date(0),
    readable: false,
    migrations: 0,
    counts: {},
    totalRows: 0,
  }
  if (!stats?.isFile()) {
    summary.error = 'file not found'
    return summary
  }

  try {
    await withCopy(path, async (copy) => {
      const client = createClient({ url: fileUrlFromPath(copy) })
      try {
        const present = new Set(
          (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((row) =>
            String(row.name),
          ),
        )
        const tables = IDENTITY_TABLES.filter((table) => present.has(table))
        for (const table of tables) {
          try {
            const result = await client.execute(`SELECT count(*) AS n FROM "${table}"`)
            const count = Number(result.rows[0]?.n ?? 0)
            summary.counts[table] = count
            summary.totalRows += count
          } catch {
            // A damaged table still leaves the rest of the summary usable.
          }
        }
        if (present.has('__drizzle_migrations')) {
          const applied = await client.execute('SELECT count(*) AS n FROM __drizzle_migrations')
          summary.migrations = Number(applied.rows[0]?.n ?? 0)
        }
        summary.newestChange = await newestChangeIn(client, tables)
        summary.readable = true
      } finally {
        try {
          client.close()
        } catch {
          /* ignore */
        }
      }
    })
  } catch (error) {
    summary.error = errorText(error)
  }
  return summary
}

/**
 * Below this share of the fuller database's rows, a candidate is not a slightly
 * older version of it - it is a different, far emptier database.
 */
const SUBSTANTIALLY_POORER = 0.5

/**
 * Which database a person would pick if they could see inside both.
 *
 * Recency alone is a trap: a database the app created from scratch minutes ago
 * has the newest timestamps in the world and almost nothing in it, and ranking
 * it first would recommend the empty file over the real work. So a candidate
 * holding less than half the rows of another loses outright, and only among
 * comparably full databases does recency decide. File timestamps come last,
 * because copying a backup makes it look new.
 */
export function compareDatabases(a: DatabaseSummary, b: DatabaseSummary): number {
  if (a.readable !== b.readable) return a.readable ? -1 : 1

  const fullest = Math.max(a.totalRows, b.totalRows)
  if (fullest > 0) {
    const aShare = a.totalRows / fullest
    const bShare = b.totalRows / fullest
    if (aShare < SUBSTANTIALLY_POORER && bShare >= SUBSTANTIALLY_POORER) return 1
    if (bShare < SUBSTANTIALLY_POORER && aShare >= SUBSTANTIALLY_POORER) return -1
  }

  if (a.newestChange !== b.newestChange) {
    if (!a.newestChange) return 1
    if (!b.newestChange) return -1
    return a.newestChange > b.newestChange ? -1 : 1
  }
  if (a.totalRows !== b.totalRows) return b.totalRows - a.totalRows
  return b.modifiedAt.getTime() - a.modifiedAt.getTime()
}

/** One compact block per database, meant to be read side by side in a dialog. */
export function describeDatabase(summary: DatabaseSummary, label?: string): string {
  const head = label ? `${label}\n${summary.path}` : summary.path
  if (!summary.readable) return `${head}\n  cannot be read${summary.error ? `: ${summary.error}` : ''}`
  const highlights = ['creators', 'creator_picks', 'tasks', 'events', 'wishlist_points']
    .filter((table) => table in summary.counts)
    .map((table) => `${table.replace(/_/g, ' ')} ${summary.counts[table]}`)
    .join(', ')
  return [
    head,
    `  last change in the data: ${summary.newestChange ?? 'unknown'}`,
    `  ${summary.totalRows} rows total${highlights ? ` — ${highlights}` : ''}`,
    `  ${(summary.sizeBytes / 1_048_576).toFixed(1)} MB, file modified ${summary.modifiedAt.toISOString()}`,
  ].join('\n')
}

/**
 * How much poorer one database is than another, as a plain sentence, or
 * undefined when it is not meaningfully poorer. Used to turn "is this the right
 * database?" into a statement instead of a question.
 */
export function describeShortfall(chosen: DatabaseSummary, best: DatabaseSummary): string | undefined {
  if (!chosen.readable || !best.readable) return undefined
  const losses: string[] = []
  for (const [table, count] of Object.entries(best.counts)) {
    const mine = chosen.counts[table] ?? 0
    if (count > mine) losses.push(`${count - mine} fewer ${table.replace(/_/g, ' ')}`)
  }
  if (!losses.length) return undefined
  return losses.join(', ')
}
