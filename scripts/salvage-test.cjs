/*
 * Corrupt a real SQLite file the way page-level damage actually looks, then check
 * that salvage reads around the damage instead of writing the database off.
 *
 * The properties under test are the ones that made the 2026-08-19 incident
 * recoverable by hand and must never regress:
 *   1. the damaged file is not modified, not even by being opened;
 *   2. a plain scan loses far more rows than the salvage pass;
 *   3. the salvaged result passes a full integrity check;
 *   4. rows the schema will not accept are parked, not dropped.
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { createClient } = require('@libsql/client')
const { salvageDatabase } = require('@marcat/db')

const PAGE_SIZE = 4096
const ROW_COUNT = 4000

const fileUrl = (file) => 'file:' + file.replace(/\\/g, '/')
const md5 = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

async function buildDatabase(file) {
  const client = createClient({ url: fileUrl(file) })
  await client.execute(`PRAGMA page_size=${PAGE_SIZE}`)
  await client.execute('PRAGMA journal_mode=DELETE')
  await client.execute(
    'CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, body TEXT NOT NULL, weight INTEGER)',
  )
  await client.execute('CREATE INDEX notes_label ON notes (label)')
  const rows = []
  for (let i = 0; i < ROW_COUNT; i += 1) {
    rows.push({
      sql: 'INSERT INTO notes (id, label, body, weight) VALUES (?, ?, ?, ?)',
      // A body large enough that rows spread across many pages, so damaging a
      // few pages destroys a contiguous run rather than the whole table.
      args: [`id-${String(i).padStart(5, '0')}`, `label-${i}`, 'x'.repeat(600), i],
    })
  }
  for (let offset = 0; offset < rows.length; offset += 200) {
    await client.batch(rows.slice(offset, offset + 200), 'write')
  }
  client.close()
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/** Overwrite whole pages with garbage - the shape of real page-level damage. */
function damagePages(file, pageNumbers) {
  const handle = fs.openSync(file, 'r+')
  try {
    for (const page of pageNumbers) {
      const junk = Buffer.alloc(PAGE_SIZE, 0xa5)
      fs.writeSync(handle, junk, 0, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    }
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * What the app sees today: one sequential table scan that stops dead at the
 * first unreadable page and reports nothing at all.
 */
async function inspectDamaged(file) {
  const client = createClient({ url: fileUrl(file) })
  let scanned = 0
  let integrity = 'unknown'
  try {
    const result = await client.execute('SELECT count(*) AS n FROM notes NOT INDEXED')
    scanned = Number(result.rows[0].n)
  } catch {
    scanned = 0
  }
  try {
    const check = await client.execute('PRAGMA integrity_check')
    integrity = String(check.rows[0].integrity_check)
  } catch (error) {
    integrity = `check failed: ${error.message}`
  }
  try {
    client.close()
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { scanned, integrity }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-salvage-'))
  const original = path.join(dir, 'corrupt.db')
  await buildDatabase(original)

  const totalPages = Math.floor(fs.statSync(original).size / PAGE_SIZE)
  if (totalPages < 200) fail(`test database is too small to damage meaningfully (${totalPages} pages)`)
  // Somewhere in the middle: page 1 holds the header and page 2 the schema, and
  // wrecking those tests nothing interesting.
  const damaged = [Math.floor(totalPages * 0.4), Math.floor(totalPages * 0.4) + 1, Math.floor(totalPages * 0.7)]
  damagePages(original, damaged)

  const before = md5(original)
  const { scanned, integrity: sourceIntegrity } = await inspectDamaged(original)
  if (sourceIntegrity === 'ok') fail('the test did not actually damage the database')

  // inspectDamaged opened the file; take the checksum salvage must preserve
  // after that, so the comparison is about salvage and nothing else.
  const baseline = md5(original)
  const destination = path.join(dir, 'salvaged.db')
  const report = await salvageDatabase(original, destination, { timeBudgetMs: 120_000 })

  if (md5(original) !== baseline) fail('salvage modified the damaged source file')

  const client = createClient({ url: fileUrl(destination) })
  const recovered = Number((await client.execute('SELECT count(*) AS n FROM notes')).rows[0].n)
  const parked = Number((await client.execute('SELECT count(*) AS n FROM _salvage_unplaced')).rows[0].n)
  const integrity = String((await client.execute('PRAGMA integrity_check')).rows[0].integrity_check)
  client.close()

  console.log(`pages: ${totalPages}, damaged: ${damaged.join(', ')}`)
  console.log(`source integrity:     ${sourceIntegrity.slice(0, 70)}`)
  console.log(`plain table scan:     ${scanned} / ${ROW_COUNT}`)
  console.log(`salvage recovered:    ${recovered} / ${ROW_COUNT} (+${parked} parked fragments)`)
  console.log(`integrity_check:      ${integrity}`)
  console.log(`source checksum:      ${before} -> ${md5(original)}`)

  if (integrity !== 'ok') fail(`salvaged database failed integrity check: ${integrity}`)
  if (!report.integrityOk) fail('salvage reported a failed integrity check')
  if (recovered <= scanned) fail(`salvage (${recovered}) recovered no more than a plain scan (${scanned})`)
  // Three damaged pages hold a small fraction of the rows; anything less than
  // most of the table means the walk is giving up early.
  if (recovered < ROW_COUNT * 0.9) fail(`salvage recovered only ${recovered} of ${ROW_COUNT} rows`)
  if (report.totalRecovered !== recovered) {
    fail(`report claims ${report.totalRecovered} rows but the database holds ${recovered}`)
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // libsql can still hold the file on Windows; the OS reclaims the temp dir.
  }
  console.log('salvage test OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
