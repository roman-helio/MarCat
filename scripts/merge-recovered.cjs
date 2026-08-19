/*
 * Merge rows that survive in older databases back into the current one.
 *
 * Recovery leaves data scattered: the live database has everything done since
 * the incident, while the last pre-incident snapshot still holds rows the
 * incident destroyed. Neither is a superset of the other, so restoring a backup
 * loses recent work and keeping the live file loses the rest.
 *
 * This tool is strictly additive. It copies the live database, inserts only rows
 * whose identity is absent from that copy, and never updates or deletes
 * anything. The live database itself is opened read-only and is never written.
 *
 * Usage:
 *   node scripts/merge-recovered.cjs --live <db> --source <db> [--source <db>...] --out <db>
 *   node scripts/merge-recovered.cjs --live <db> --source <db> --report
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

/** Tables whose rows are derived, transient or machine-regenerated. */
const SKIP_TABLES = new Set([
  '__drizzle_migrations',
  '_salvage_unplaced',
  'change_log',
  'sync_runs',
  'workspace_outbox',
  'workspace_files',
  'workspace_sync_issues',
  'ai_runs',
  'ai_messages',
  'ai_proposal_changes',
  'background_operations',
  'background_operation_items',
  'creator_discovery_api_requests',
  'youtube_api_requests',
  'youtube_quota_usage',
  'settings',
  'task_counters',
])

function parseArgs(argv) {
  const args = { sources: [], report: false }
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--live') args.live = argv[++i]
    else if (flag === '--source') args.sources.push(argv[++i])
    else if (flag === '--out') args.out = argv[++i]
    else if (flag === '--report') args.report = true
    else throw new Error(`Unknown argument: ${flag}`)
  }
  if (!args.live) throw new Error('--live is required')
  if (!args.sources.length) throw new Error('at least one --source is required')
  if (!args.out && !args.report) throw new Error('--out is required unless --report is given')
  return args
}

function openReadOnly(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  return db
}

const tablesOf = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name)

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all()

const foreignKeysOf = (db, table) => {
  try {
    return db.prepare(`PRAGMA foreign_key_list("${table}")`).all()
  } catch {
    return []
  }
}

/**
 * What makes a row "the same row" as one already present. Declared primary keys
 * first, then a unique index, and finally every column - link tables such as
 * task_tag_links declare no primary key at all, and comparing whole rows is the
 * only correct answer for them.
 */
function identityColumns(db, table) {
  const columns = columnsOf(db, table)
  const primary = columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name)
  if (primary.length) return { columns: primary, kind: 'primary key' }

  for (const index of db.prepare(`PRAGMA index_list("${table}")`).all()) {
    if (!index.unique) continue
    const parts = db
      .prepare(`PRAGMA index_info("${index.name}")`)
      .all()
      .map((row) => row.name)
      .filter(Boolean)
    if (parts.length) return { columns: parts, kind: `unique index ${index.name}` }
  }
  return { columns: columns.map((column) => column.name), kind: 'whole row' }
}

/** Parents before children, so a restored row never lands before what it points at. */
function inDependencyOrder(db, tables) {
  const pending = new Set(tables)
  const ordered = []
  for (let pass = 0; pass < tables.length + 1 && pending.size; pass += 1) {
    let progressed = false
    for (const table of [...pending]) {
      const parents = foreignKeysOf(db, table)
        .map((fk) => fk.table)
        .filter((parent) => parent !== table && pending.has(parent))
      if (parents.length) continue
      ordered.push(table)
      pending.delete(table)
      progressed = true
    }
    if (!progressed) break
  }
  return [...ordered, ...pending]
}

// NUL stands in for SQL NULL and 0x1F separates the parts, so no combination of
// real column values can collide with a different combination.
const identityOf = (row, columns) =>
  columns.map((column) => (row[column] === null ? '\u0000' : String(row[column]))).join('\u001f')

function main() {
  const args = parseArgs(process.argv)
  if (!fs.existsSync(args.live)) throw new Error(`Live database not found: ${args.live}`)
  const scratch = args.report ? fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-merge-')) : null
  try {
    return merge(args, scratch)
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
  }
}

function merge(args, scratch) {
  // Work on a copy from the very first step: the live file is never opened for
  // writing, so a failure here cannot damage the database in use. A dry run
  // builds its copy in the system temp directory, never beside the real
  // database - a crashed run must not leave a stray database in the folder the
  // app scans.
  const target = scratch ? path.join(scratch, 'merged.db') : args.out
  if (!args.report && fs.existsSync(target)) throw new Error(`Refusing to overwrite an existing file: ${target}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(args.live, target)
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${args.live}${suffix}`)) fs.copyFileSync(`${args.live}${suffix}`, `${target}${suffix}`)
  }

  const merged = new DatabaseSync(target)
  merged.exec('PRAGMA journal_mode=DELETE')
  merged.exec('PRAGMA foreign_keys=OFF')

  const targetTables = new Set(tablesOf(merged))
  const order = inDependencyOrder(
    merged,
    [...targetTables].filter((table) => !SKIP_TABLES.has(table)),
  )

  const added = new Map()
  const skippedByFk = new Map()
  const details = []

  const unreadable = []
  for (const source of args.sources) {
    if (!fs.existsSync(source)) throw new Error(`Source not found: ${source}`)
    const label = path.basename(source)
    // Some of these files are themselves damaged - that is why they are being
    // merged in the first place. One unreadable source must not abandon the rest.
    let from
    let sourceTables
    try {
      from = openReadOnly(source)
      sourceTables = new Set(tablesOf(from))
    } catch (error) {
      unreadable.push(`${label}: ${error.message}`)
      try {
        from?.close()
      } catch {
        /* ignore */
      }
      continue
    }

    for (const table of order) {
      if (!sourceTables.has(table)) continue
      const targetColumns = columnsOf(merged, table).map((column) => column.name)
      const sourceColumns = new Set(columnsOf(from, table).map((column) => column.name))
      const shared = targetColumns.filter((column) => sourceColumns.has(column))
      if (!shared.length) continue

      const identity = identityColumns(merged, table)
      if (!identity.columns.every((column) => sourceColumns.has(column))) continue

      let existing
      let rows
      try {
        existing = new Set(
          merged
            .prepare(`SELECT ${identity.columns.map((c) => `"${c}"`).join(', ')} FROM "${table}"`)
            .all()
            .map((row) => identityOf(row, identity.columns)),
        )
        rows = from.prepare(`SELECT ${shared.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).all()
      } catch {
        continue
      }

      const candidates = rows.filter((row) => !existing.has(identityOf(row, identity.columns)))
      if (!candidates.length) continue

      // A restored row whose parent was not itself recovered would leave the
      // database referentially broken. Report those rather than inserting them.
      const parentChecks = foreignKeysOf(merged, table)
        .filter((fk) => shared.includes(fk.from) && targetTables.has(fk.table))
        .map((fk) => ({
          column: fk.from,
          check: merged.prepare(`SELECT 1 FROM "${fk.table}" WHERE "${fk.to ?? 'id'}" = ? LIMIT 1`),
          parent: fk.table,
        }))

      const insert = merged.prepare(
        `INSERT OR IGNORE INTO "${table}" (${shared.map((c) => `"${c}"`).join(', ')})` +
          ` VALUES (${shared.map(() => '?').join(', ')})`,
      )

      let inserted = 0
      let orphaned = 0
      for (const row of candidates) {
        const missingParent = parentChecks.find(
          (parent) => row[parent.column] !== null && !parent.check.get(row[parent.column]),
        )
        if (missingParent) {
          orphaned += 1
          continue
        }
        try {
          const result = insert.run(...shared.map((column) => row[column] ?? null))
          if (result.changes > 0) {
            inserted += 1
            details.push({ table, source: label, row })
          }
        } catch {
          orphaned += 1
        }
      }
      if (inserted) added.set(table, (added.get(table) ?? 0) + inserted)
      if (orphaned) skippedByFk.set(table, (skippedByFk.get(table) ?? 0) + orphaned)
    }
    from.close()
  }

  merged.exec('PRAGMA foreign_keys=ON')
  const violations = merged.prepare('PRAGMA foreign_key_check').all()
  const integrity = merged.prepare('PRAGMA integrity_check').get().integrity_check
  merged.exec('PRAGMA journal_mode=WAL')
  merged.close()

  if (unreadable.length) {
    console.log('=== sources that could not be opened ===')
    for (const note of unreadable) console.log(`  ${note}`)
    console.log('')
  }

  console.log('=== rows added ===')
  if (!added.size) console.log('  (nothing to add - the live database already holds every source row)')
  for (const [table, count] of [...added].sort((a, b) => b[1] - a[1])) console.log(`  ${table}: +${count}`)

  if (skippedByFk.size) {
    console.log('\n=== rows skipped because what they reference was not recovered ===')
    for (const [table, count] of [...skippedByFk].sort((a, b) => b[1] - a[1])) console.log(`  ${table}: ${count}`)
  }

  console.log('\n=== verification ===')
  console.log(`  integrity_check:    ${integrity}`)
  console.log(`  foreign_key_check:  ${violations.length === 0 ? 'clean' : `${violations.length} violations`}`)

  if (args.report) {
    console.log('\n(report only - no file written)')
  } else {
    console.log(`\nwrote ${target} (${(fs.statSync(target).size / 1048576).toFixed(1)} MB)`)
  }

  return { added, details }
}

module.exports = { main }

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
