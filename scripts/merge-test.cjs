/*
 * The merge tool exists to put recovered rows back without losing anything, so
 * the properties worth testing are the ones a careless merge would break:
 *   1. every row of the live database survives (additive, never destructive);
 *   2. rows missing from live are restored from the source;
 *   3. rows the live database changed are NOT overwritten by the older source;
 *   4. rows whose parent was never recovered are skipped, not inserted broken;
 *   5. tables with no declared primary key are still matched correctly.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')

const SCHEMA = `
CREATE TABLE games (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
CREATE TABLE creators (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
CREATE TABLE creator_picks (
  game_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  pipeline_status TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE cascade,
  FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE cascade
);
CREATE UNIQUE INDEX creator_picks_pair ON creator_picks (game_id, creator_id);
`

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function build(file, rows) {
  const db = new DatabaseSync(file)
  // Off while seeding so the fixture can contain the very thing being tested:
  // a row whose parent did not survive.
  db.exec('PRAGMA foreign_keys=OFF')
  db.exec(SCHEMA)
  for (const [table, list] of Object.entries(rows)) {
    for (const row of list) {
      const columns = Object.keys(row)
      db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
        ...columns.map((c) => row[c]),
      )
    }
  }
  db.close()
}

function read(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-merge-test-'))
const live = path.join(dir, 'live.db')
const source = path.join(dir, 'source.db')
const out = path.join(dir, 'merged.db')

// Live: lost one pick, renamed a creator, and gained a pick of its own.
build(live, {
  games: [{ id: 'g1', name: 'Game One' }],
  creators: [
    { id: 'c1', name: 'Creator One (renamed after the incident)' },
    { id: 'c2', name: 'Creator Two' },
  ],
  creator_picks: [{ game_id: 'g1', creator_id: 'c2', pipeline_status: 'prospect' }],
})

// Source: the pre-incident snapshot. It still has the lost pick and the old
// creator name, and it references a creator that no longer exists anywhere.
build(source, {
  games: [{ id: 'g1', name: 'Game One' }],
  creators: [
    { id: 'c1', name: 'Creator One (old name)' },
    { id: 'c2', name: 'Creator Two' },
  ],
  creator_picks: [
    { game_id: 'g1', creator_id: 'c1', pipeline_status: 'contacted' },
    { game_id: 'g1', creator_id: 'c2', pipeline_status: 'prospect' },
    { game_id: 'g1', creator_id: 'ghost', pipeline_status: 'contacted' },
  ],
})

const output = execFileSync(
  process.execPath,
  [path.join(__dirname, 'merge-recovered.cjs'), '--live', live, '--source', source, '--out', out],
  { encoding: 'utf8' },
)
console.log(output.trim())

const picks = read(out, 'SELECT game_id, creator_id, pipeline_status FROM creator_picks ORDER BY creator_id')
const creators = read(out, 'SELECT id, name FROM creators ORDER BY id')

// 1 + 2: the lost pick is back and the live pick is untouched.
if (picks.length !== 2) fail(`expected 2 picks, got ${picks.length}: ${JSON.stringify(picks)}`)
if (!picks.some((p) => p.creator_id === 'c1' && p.pipeline_status === 'contacted')) {
  fail('the pick that was missing from live was not restored')
}
if (!picks.some((p) => p.creator_id === 'c2' && p.pipeline_status === 'prospect')) fail('the live pick was lost')

// 3: an older source must never overwrite what live already holds.
const c1 = creators.find((c) => c.id === 'c1')
if (!c1.name.includes('renamed')) fail(`the source overwrote a live row: ${c1.name}`)

// 4: the pick pointing at a creator nobody recovered must not be inserted.
if (picks.some((p) => p.creator_id === 'ghost')) fail('a pick with no creator was inserted')
if (!output.includes('skipped because what they reference was not recovered')) {
  fail('the orphaned row was dropped without being reported')
}

// 5: composite identity worked - no duplicate of the c2 pick.
const duplicates = picks.filter((p) => p.creator_id === 'c2').length
if (duplicates !== 1) fail(`composite identity failed: ${duplicates} copies of the c2 pick`)

const liveRows = read(live, 'SELECT id FROM creators').length
if (read(out, 'SELECT id FROM creators').length < liveRows) fail('merged database lost creators')

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {
  /* the OS reclaims the temp directory */
}
console.log('\nmerge test OK')
