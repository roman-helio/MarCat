import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { createClient, type Client, type Row, type Value } from '@libsql/client'
import { fileUrlFromPath } from './client'

/**
 * Page-level SQLite damage almost never destroys a whole database: it destroys a
 * handful of pages. A plain `SELECT * FROM t` stops at the first unreadable page
 * and reports nothing beyond it, which is why a corrupt file looks like a total
 * loss. These routines read around the damage instead, and form the last tier of
 * the startup recovery ladder - used only when no verified snapshot exists.
 */

const ROWID = '__marcat_salvage_rowid'
const BATCH_SIZE = 200
/** Consecutive failed probes before a hole is declared too large to step over. */
const MAX_PROBES_PER_HOLE = 200
/** Bounded so a badly damaged table cannot stall startup indefinitely. */
const MAX_SKIP_PROBES_PER_TABLE = 2_000
const MAX_SKIP_STEP = 32
/** Rowids fetched per statement in the index-assisted pass. */
const FETCH_CHUNK = 100

export type SalvageMethod = 'scan' | 'rowid-walk' | 'index-walk' | 'failed'

export interface SalvagedTable {
  table: string
  /** Rows written to the salvaged database. */
  recovered: number
  /** Rows rebuilt from index entries only, so non-indexed columns are missing. */
  partial: number
  /** Rowid positions stepped over because the page holding them is unreadable. */
  skipped: number
  /** Fragments parked in `_salvage_unplaced` because the table would not accept them. */
  unplaced: number
  method: SalvageMethod
  error?: string
}

export interface SalvageReport {
  source: string
  destination: string
  tables: SalvagedTable[]
  totalRecovered: number
  totalPartial: number
  /** Rows preserved in `_salvage_unplaced` rather than in their own table. */
  totalUnplaced: number
  /** Rows kept even though they reference data that could not be recovered. */
  danglingRows: number
  integrityOk: boolean
  durationMs: number
  timedOut: boolean
}

export interface SalvageOptions {
  /** Wall-clock budget; tables not reached in time are reported as failed. */
  timeBudgetMs?: number
  onProgress?: (table: string, recovered: number) => void
}

interface SchemaObject {
  name: string
  sql: string
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function tryExecute(client: Client, sql: string): Promise<void> {
  try {
    await client.execute(sql)
  } catch {
    // Best-effort pragmas: a corrupt source may reject some of them.
  }
}

/**
 * `writable_schema` lets sqlite_master be read even when the schema fails to
 * parse. No read-only pragma is set here on purpose: this is only ever pointed
 * at a private working copy (see `withWorkingCopy`), and letting SQLite recover
 * the WAL normally is what makes committed-but-uncheckpointed rows readable.
 */
async function openSource(path: string): Promise<Client> {
  const client = createClient({ url: fileUrlFromPath(path) })
  await tryExecute(client, 'PRAGMA writable_schema=ON')
  return client
}

/**
 * Salvage never opens the damaged file itself. Merely opening a WAL database
 * checkpoints it, which rewrites the very bytes that may be the last copy of
 * the user's data - `PRAGMA query_only` does not prevent that. So the file and
 * its sidecars are copied first and every read happens against the copy.
 */
async function withWorkingCopy<T>(source: string, near: string, run: (copy: string) => Promise<T>): Promise<T> {
  const workDir = fs.mkdtempSync(join(dirname(near), '.salvage-'))
  const copy = join(workDir, 'source.db')
  try {
    fs.copyFileSync(source, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${source}${suffix}`)) fs.copyFileSync(`${source}${suffix}`, `${copy}${suffix}`)
    }
    return await run(copy)
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* reclaimed by the next startup sweep */
    }
  }
}

async function readSchema(source: Client): Promise<{ tables: SchemaObject[]; rest: SchemaObject[] }> {
  const result = await source.execute(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
  )
  const tables: SchemaObject[] = []
  const rest: SchemaObject[] = []
  for (const row of result.rows) {
    const entry = { name: String(row.name), sql: String(row.sql) }
    if (String(row.type) === 'table') tables.push(entry)
    else rest.push(entry)
  }
  return { tables, rest }
}

async function columnsOf(source: Client, table: string): Promise<string[]> {
  const info = await source.execute(`PRAGMA table_info(${quote(table)})`)
  return info.rows.map((row) => String(row.name))
}

/** Indexes carry their own pages, so they survive damage to the table's own leaves. */
async function indexesOf(source: Client, table: string): Promise<{ name: string; columns: string[] }[]> {
  try {
    const list = await source.execute(`PRAGMA index_list(${quote(table)})`)
    const indexes: { name: string; columns: string[] }[] = []
    for (const row of list.rows) {
      const name = String(row.name)
      // Automatic indexes are kept on purpose: they are the ones backing PRIMARY
      // KEY and UNIQUE, so they carry the identifying columns a reconstructed row
      // needs in order to be insertable at all.
      try {
        const info = await source.execute(`PRAGMA index_info(${quote(name)})`)
        const columns = info.rows
          .map((entry) => String(entry.name ?? ''))
          .filter((column) => column && column !== 'null')
        if (columns.length) indexes.push({ name, columns })
      } catch {
        // Skip indexes whose own definition is unreadable.
      }
    }
    return indexes
  } catch {
    return []
  }
}

function insertStatement(table: string, columns: string[], withRowid: boolean): string {
  const targets = withRowid ? ['rowid', ...columns] : columns
  const names = targets.map(quote).join(', ')
  const placeholders = targets.map(() => '?').join(', ')
  // OR IGNORE lets the index-assisted pass union with the scan pass for free: a
  // rowid already recovered in full is never downgraded to a partial row.
  return `INSERT OR IGNORE INTO ${quote(table)} (${names}) VALUES (${placeholders})`
}

function fieldOf(row: Row, column: string): Value {
  return (row as unknown as Record<string, Value>)[column] ?? null
}

function valuesOf(row: Row, columns: string[]): Value[] {
  return columns.map((column) => fieldOf(row, column))
}

interface PendingRow {
  rowid: number | null
  values: Value[]
}

async function writeRows(destination: Client, table: string, columns: string[], rows: PendingRow[]): Promise<number> {
  if (!rows.length) return 0
  const withRowid = rows[0].rowid !== null
  const sql = insertStatement(table, columns, withRowid)
  const argsOf = (row: PendingRow): Value[] => (withRowid ? [row.rowid as Value, ...row.values] : row.values)
  // OR IGNORE also swallows NOT NULL and UNIQUE violations, so a statement that
  // "succeeded" may have written nothing. Count what the database actually
  // accepted - an inflated recovery number is worse than no number at all.
  try {
    const results = await destination.batch(
      rows.map((row) => ({ sql, args: argsOf(row) })),
      'write',
    )
    return results.reduce((sum, result) => sum + Number(result.rowsAffected ?? 0), 0)
  } catch {
    // One bad row must not discard everything else in the batch.
    let written = 0
    for (const row of rows) {
      try {
        const result = await destination.execute({ sql, args: argsOf(row) })
        written += Number(result.rowsAffected ?? 0)
      } catch {
        /* unrecoverable individual row */
      }
    }
    return written
  }
}

interface RowidWalkResult {
  recovered: number
  skipped: number
  method: SalvageMethod
  rowids: Set<number>
  error?: string
}

/**
 * Walk the table by rowid, stepping over the ranges that live on unreadable
 * pages. Falls back from batched reads to single rows around the damage and
 * widens the step geometrically, so a large hole does not cost one probe per row.
 */
async function walkByRowid(
  source: Client,
  destination: Client,
  table: string,
  columns: string[],
  deadline: number,
): Promise<RowidWalkResult> {
  const rowids = new Set<number>()
  let recovered = 0
  let skipped = 0
  let probes = 0
  let cursor = Number.MIN_SAFE_INTEGER
  let method: SalvageMethod = 'scan'
  let lastError: string | undefined

  const read = (limit: number) =>
    source.execute({
      sql:
        `SELECT rowid AS ${quote(ROWID)}, * FROM ${quote(table)} NOT INDEXED ` +
        `WHERE rowid > ? ORDER BY rowid LIMIT ${limit}`,
      args: [cursor],
    })

  const collect = async (rows: Row[]): Promise<void> => {
    const batch = rows.map((row) => {
      const rowid = Number(fieldOf(row, ROWID))
      rowids.add(rowid)
      return { rowid, values: valuesOf(row, columns) }
    })
    recovered += await writeRows(destination, table, columns, batch)
    cursor = Number(fieldOf(rows[rows.length - 1], ROWID))
  }

  while (Date.now() < deadline) {
    try {
      const result = await read(BATCH_SIZE)
      if (!result.rows.length) break
      await collect(result.rows)
      continue
    } catch (error) {
      lastError = errorText(error)
      method = 'rowid-walk'
    }

    // Damage somewhere in the next BATCH_SIZE rows: narrow to single rows and
    // step past whatever cannot be read. A hole that will not close within a
    // bounded number of probes is left to the index-assisted pass, which
    // addresses rows by exact rowid instead of guessing at the gap width.
    let step = 1
    let hole = 0
    let advanced = false
    for (let attempt = 0; attempt < MAX_PROBES_PER_HOLE; attempt += 1) {
      if (Date.now() >= deadline || probes >= MAX_SKIP_PROBES_PER_TABLE) break
      try {
        const result = await read(1)
        if (!result.rows.length) return { recovered, skipped, method, rowids, error: lastError }
        await collect(result.rows)
        // Only count a gap once it has actually been crossed; an abandoned probe
        // run says nothing about how many rows were really there.
        skipped += hole
        advanced = true
        break
      } catch (error) {
        lastError = errorText(error)
        probes += 1
        cursor += step
        hole += step
        step = Math.min(step * 2, MAX_SKIP_STEP)
      }
    }
    if (!advanced) break
  }

  return { recovered, skipped, method, rowids, error: lastError }
}

/**
 * Second pass for tables whose own pages are damaged: enumerate rowids from the
 * indexes (which live elsewhere in the file), fetch each row by exact rowid, and
 * where even that fails, rebuild the row from the columns the index itself
 * carries. This is what turns "table unreadable" into "table recovered, some
 * columns missing".
 */
async function walkByIndex(
  source: Client,
  destination: Client,
  table: string,
  columns: string[],
  known: Set<number>,
  deadline: number,
): Promise<{ recovered: number; partial: number; unplaced: number }> {
  const indexes = await indexesOf(source, table)
  if (!indexes.length) return { recovered: 0, partial: 0, unplaced: 0 }

  const fragments = new Map<number, Record<string, Value>>()
  for (const index of indexes) {
    if (Date.now() >= deadline) break
    const projection = [...index.columns.map(quote), `rowid AS ${quote(ROWID)}`].join(', ')
    try {
      const result = await source.execute(
        `SELECT ${projection} FROM ${quote(table)} INDEXED BY ${quote(index.name)} ORDER BY ${quote(index.columns[0])}`,
      )
      for (const row of result.rows) {
        const rowid = Number(fieldOf(row, ROWID))
        if (known.has(rowid)) continue
        const fragment = fragments.get(rowid) ?? {}
        for (const column of index.columns) fragment[column] = fieldOf(row, column)
        fragments.set(rowid, fragment)
      }
    } catch {
      // This index is damaged too; the next one may still be readable.
    }
  }
  if (!fragments.size) return { recovered: 0, partial: 0, unplaced: 0 }

  // Sorted so a chunk maps onto as few table pages as possible: one damaged page
  // then spoils one chunk instead of every chunk.
  const entries = [...fragments.entries()].sort((a, b) => a[0] - b[0])
  const full: PendingRow[] = []
  const fetched = new Set<number>()

  const fetchOne = async (rowid: number): Promise<void> => {
    try {
      const result = await source.execute({ sql: `SELECT * FROM ${quote(table)} WHERE rowid = ?`, args: [rowid] })
      if (!result.rows.length) return
      fetched.add(rowid)
      full.push({ rowid, values: valuesOf(result.rows[0], columns) })
    } catch {
      // The row's own page is unreadable; the index fragment is all there is.
    }
  }

  for (let offset = 0; offset < entries.length; offset += FETCH_CHUNK) {
    if (Date.now() >= deadline) break
    const chunk = entries.slice(offset, offset + FETCH_CHUNK).map(([rowid]) => rowid)
    try {
      const result = await source.execute({
        sql:
          `SELECT rowid AS ${quote(ROWID)}, * FROM ${quote(table)} ` +
          `WHERE rowid IN (${chunk.map(() => '?').join(', ')})`,
        args: chunk,
      })
      for (const row of result.rows) {
        const rowid = Number(fieldOf(row, ROWID))
        fetched.add(rowid)
        full.push({ rowid, values: valuesOf(row, columns) })
      }
    } catch {
      for (const rowid of chunk) await fetchOne(rowid)
    }
  }

  const partials = entries.filter(([rowid]) => !fetched.has(rowid)).map(([rowid, fragment]) => ({ rowid, fragment }))

  let recovered = await writeRows(destination, table, columns, full)
  let partial = 0
  let unplaced = 0
  for (const entry of partials) {
    const present = columns.filter((column) => column in entry.fragment)
    if (!present.length) continue
    const written = await writeRows(destination, table, present, [
      { rowid: entry.rowid, values: present.map((column) => entry.fragment[column] ?? null) },
    ])
    if (written) {
      recovered += written
      partial += written
      continue
    }
    // The fragment is real data but too incomplete for the table to accept it -
    // a NOT NULL column the indexes do not cover, typically. Park it where a
    // human or an agent can still see it instead of dropping it on the floor.
    unplaced += await parkUnplacedFragment(destination, table, entry.rowid, entry.fragment)
  }
  return { recovered, partial, unplaced }
}

/** Side table for index fragments that no longer fit their own schema. */
const UNPLACED_TABLE = '_salvage_unplaced'

async function createUnplacedTable(destination: Client): Promise<void> {
  await tryExecute(
    destination,
    `CREATE TABLE IF NOT EXISTS ${quote(UNPLACED_TABLE)} (` +
      'source_table TEXT NOT NULL, source_rowid INTEGER NOT NULL, columns_json TEXT NOT NULL, ' +
      'PRIMARY KEY (source_table, source_rowid))',
  )
}

async function parkUnplacedFragment(
  destination: Client,
  table: string,
  rowid: number,
  fragment: Record<string, Value>,
): Promise<number> {
  try {
    const result = await destination.execute({
      sql: `INSERT OR IGNORE INTO ${quote(UNPLACED_TABLE)} (source_table, source_rowid, columns_json) VALUES (?, ?, ?)`,
      args: [table, rowid, JSON.stringify(fragment)],
    })
    return Number(result.rowsAffected ?? 0)
  } catch {
    return 0
  }
}

/**
 * Some recovered rows point at parent rows that could not be recovered. They are
 * counted and reported but deliberately NOT deleted: a row whose parent is
 * missing is still the user's data, and SQLite only enforces foreign keys on
 * statements it executes, not on rows already at rest. Deciding that recovered
 * data is worthless is the failure mode this whole module exists to undo.
 */
async function countDanglingReferences(destination: Client): Promise<number> {
  try {
    const violations = await destination.execute('PRAGMA foreign_key_check')
    return violations.rows.length
  } catch {
    return 0
  }
}

/**
 * Rebuild as much of `source` as can be read into a brand-new database at
 * `destination`. The source is opened read-only and is never modified.
 */
export async function salvageDatabase(
  source: string,
  destination: string,
  options: SalvageOptions = {},
): Promise<SalvageReport> {
  if (!fs.existsSync(source)) throw new Error(`Nothing to salvage: ${source} does not exist`)
  if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite an existing file: ${destination}`)

  const started = Date.now()
  const deadline = started + (options.timeBudgetMs ?? 10 * 60_000)
  fs.mkdirSync(dirname(destination), { recursive: true })

  const tables: SalvagedTable[] = []
  let danglingRows = 0
  let integrityOk = false

  await withWorkingCopy(source, destination, async (workingCopy) => {
    const src = await openSource(workingCopy)
    const dst = createClient({ url: fileUrlFromPath(destination) })

    try {
      const schema = await readSchema(src)
      await tryExecute(dst, 'PRAGMA journal_mode=WAL')
      await tryExecute(dst, 'PRAGMA foreign_keys=OFF')
      await createUnplacedTable(dst)

      for (const table of schema.tables) {
        try {
          await dst.execute(table.sql)
        } catch (error) {
          tables.push({
            table: table.name,
            recovered: 0,
            partial: 0,
            skipped: 0,
            unplaced: 0,
            method: 'failed',
            error: `schema: ${errorText(error)}`,
          })
        }
      }

      const created = new Set(
        (await dst.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((row) => String(row.name)),
      )

      for (const table of schema.tables) {
        if (!created.has(table.name)) continue
        if (Date.now() >= deadline) {
          tables.push({
            table: table.name,
            recovered: 0,
            partial: 0,
            skipped: 0,
            unplaced: 0,
            method: 'failed',
            error: 'time budget exhausted',
          })
          continue
        }
        try {
          const columns = await columnsOf(src, table.name)
          const walk = await walkByRowid(src, dst, table.name, columns, deadline)
          let recovered = walk.recovered
          let partial = 0
          let unplaced = 0
          let method = walk.method
          if (walk.method !== 'scan') {
            const assisted = await walkByIndex(src, dst, table.name, columns, walk.rowids, deadline)
            unplaced = assisted.unplaced
            if (assisted.recovered) {
              recovered += assisted.recovered
              partial = assisted.partial
              method = 'index-walk'
            }
          }
          tables.push({
            table: table.name,
            recovered,
            partial,
            skipped: walk.skipped,
            unplaced,
            method,
            error: walk.method === 'scan' ? undefined : walk.error,
          })
          options.onProgress?.(table.name, recovered)
        } catch (error) {
          tables.push({
            table: table.name,
            recovered: 0,
            partial: 0,
            skipped: 0,
            unplaced: 0,
            method: 'failed',
            error: errorText(error),
          })
        }
      }

      for (const object of schema.rest) {
        try {
          await dst.execute(object.sql)
        } catch {
          // Indexes/views/triggers are rebuildable; never fail a salvage over them.
        }
      }

      await tryExecute(dst, 'PRAGMA foreign_keys=ON')
      danglingRows = await countDanglingReferences(dst)

      try {
        const check = await dst.execute('PRAGMA integrity_check')
        integrityOk = String(check.rows[0]?.integrity_check ?? '') === 'ok'
      } catch {
        integrityOk = false
      }
    } finally {
      try {
        src.close()
      } catch {
        /* ignore */
      }
      try {
        dst.close()
      } catch {
        /* ignore */
      }
    }
  })

  return {
    source,
    destination,
    tables: tables.sort((a, b) => b.recovered - a.recovered),
    totalRecovered: tables.reduce((sum, table) => sum + table.recovered, 0),
    totalPartial: tables.reduce((sum, table) => sum + table.partial, 0),
    totalUnplaced: tables.reduce((sum, table) => sum + table.unplaced, 0),
    danglingRows,
    integrityOk,
    durationMs: Date.now() - started,
    timedOut: Date.now() >= deadline,
  }
}

/** Human-readable summary for the startup dialog and the startup log. */
export function formatSalvageReport(report: SalvageReport): string {
  const lines = report.tables
    .filter((table) => table.recovered > 0 || table.unplaced > 0 || table.method === 'failed')
    .map((table) => {
      const notes: string[] = []
      if (table.partial) notes.push(`${table.partial} partial`)
      if (table.unplaced) notes.push(`${table.unplaced} parked`)
      if (table.skipped) notes.push(`${table.skipped} rowids unreadable`)
      if (table.method === 'failed') notes.push(table.error ?? 'not recovered')
      return `  ${table.table}: ${table.recovered} rows${notes.length ? ` (${notes.join(', ')})` : ''}`
    })
  const recoveredTables = report.tables.filter((table) => table.recovered > 0).length
  return [
    `Recovered ${report.totalRecovered} rows across ${recoveredTables} tables.`,
    report.totalPartial ? `${report.totalPartial} rows were rebuilt from indexes and are missing some columns.` : '',
    report.totalUnplaced
      ? `${report.totalUnplaced} rows were too incomplete for their own table and are kept in ${UNPLACED_TABLE}.`
      : '',
    report.danglingRows
      ? `${report.danglingRows} recovered rows point at data that was lost; they were kept, not deleted.`
      : '',
    report.timedOut ? 'The salvage pass hit its time budget; some tables may be incomplete.' : '',
    '',
    ...lines,
  ]
    .filter(Boolean)
    .join('\n')
}
