/*
 * Two MarCat databases can differ by a handful of rows out of thousands, so the
 * app has to tell them apart itself. What is tested here is exactly that
 * judgement:
 *   1. the database with newer data wins, even when the stale file was touched
 *      more recently on disk (copying a backup makes it look new);
 *   1b. a nearly empty database never wins on recency - a database the app just
 *      created from scratch has the newest timestamps and none of the work;
 *   2. the shortfall is reported in concrete rows, not as a vague warning;
 *   3. an unreadable file never outranks a readable one;
 *   4. reading a candidate does not modify it.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { summarizeDatabase, compareDatabases, describeShortfall, describeDatabase } = require('@marcat/db')

const md5 = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function build(file, { creators, picks, updatedAt }) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys=OFF')
  db.exec('CREATE TABLE games (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, updated_at TEXT)')
  db.exec('CREATE TABLE creators (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, updated_at TEXT)')
  db.exec('CREATE TABLE creator_picks (game_id TEXT NOT NULL, creator_id TEXT NOT NULL, created_at TEXT)')
  db.prepare('INSERT INTO games (id, name, updated_at) VALUES (?, ?, ?)').run('g1', 'Game', updatedAt)
  for (let i = 0; i < creators; i += 1) {
    db.prepare('INSERT INTO creators (id, name, updated_at) VALUES (?, ?, ?)').run(`c${i}`, `Creator ${i}`, updatedAt)
  }
  for (let i = 0; i < picks; i += 1) {
    db.prepare('INSERT INTO creator_picks (game_id, creator_id, created_at) VALUES (?, ?, ?)').run(
      'g1',
      `c${i}`,
      updatedAt,
    )
  }
  db.close()
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-identify-test-'))
  const live = path.join(dir, 'live.db')
  const stale = path.join(dir, 'stale.db')
  const broken = path.join(dir, 'broken.db')

  build(live, { creators: 779, picks: 679, updatedAt: '2026-08-19T14:00:00.000Z' })
  build(stale, { creators: 774, picks: 668, updatedAt: '2026-07-02T09:00:00.000Z' })
  // What a fresh database looks like right after the app creates and seeds one:
  // the newest timestamps on the machine, and nothing worth opening.
  const fresh = path.join(dir, 'fresh.db')
  build(fresh, { creators: 0, picks: 0, updatedAt: '2026-08-19T23:59:00.000Z' })
  fs.writeFileSync(broken, Buffer.alloc(8192, 0x5a))

  // The stale file is touched last, the way a freshly copied backup would be.
  const later = new Date()
  fs.utimesSync(stale, later, later)

  const before = md5(live)
  const liveSummary = await summarizeDatabase(live)
  const staleSummary = await summarizeDatabase(stale)
  const brokenSummary = await summarizeDatabase(broken)

  console.log(describeDatabase(liveSummary, 'live:'))
  console.log(describeDatabase(staleSummary, 'stale:'))
  console.log(describeDatabase(brokenSummary, 'broken:'))
  console.log('')

  if (md5(live) !== before) fail('summarizeDatabase modified the file it read')
  if (!liveSummary.readable || !staleSummary.readable) fail('a valid database was reported unreadable')
  if (brokenSummary.readable) fail('a corrupt file was reported readable')

  if (liveSummary.counts.creators !== 779 || liveSummary.counts.creator_picks !== 679) {
    fail(`wrong counts: ${JSON.stringify(liveSummary.counts)}`)
  }
  if (liveSummary.newestChange !== '2026-08-19T14:00:00.000Z') {
    fail(`wrong newest change: ${liveSummary.newestChange}`)
  }

  // 1: newer data wins despite the stale file having the newer mtime.
  const freshSummary = await summarizeDatabase(fresh)
  const ranked = [staleSummary, freshSummary, liveSummary, brokenSummary].sort(compareDatabases)
  if (ranked[0].path !== live) fail(`ranking picked ${path.basename(ranked[0].path)} instead of live.db`)
  if (ranked[ranked.length - 1].path !== broken) fail('the unreadable file was not ranked last')

  // 1b: the freshest-but-empty database must lose to both real ones.
  if (compareDatabases(freshSummary, liveSummary) < 0) fail('an empty database outranked the live one on recency')
  if (compareDatabases(freshSummary, staleSummary) < 0) fail('an empty database outranked a stale but real one')

  // 2: the difference is stated in rows, so nobody has to go looking for it.
  const shortfall = describeShortfall(staleSummary, liveSummary)
  if (!shortfall) fail('no shortfall reported for a database that is missing rows')
  if (!shortfall.includes('5 fewer creators') || !shortfall.includes('11 fewer creator picks')) {
    fail(`shortfall does not name the missing rows: ${shortfall}`)
  }
  console.log(`shortfall: ${shortfall}`)

  if (describeShortfall(liveSummary, liveSummary)) fail('a database was reported short against itself')

  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* the OS reclaims the temp directory */
  }
  console.log('\nidentify test OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
