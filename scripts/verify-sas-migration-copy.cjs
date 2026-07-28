/*
 * Create a consistent snapshot of the active MarCat database, migrate only the
 * snapshot, and prove that the SAS project graph is unchanged. The source is
 * never opened for writes.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createClient } = require('@libsql/client')
const { createDb, fileUrlFromPath, runMigrations } = require('@marcat/db')

const appDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MarCat')
const marker = path.join(appDir, 'active-db-path.txt')
const source = path.resolve(
  process.env.MARCAT_SOURCE_DB ||
    (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : path.join(appDir, 'marcat.db')),
)
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-sas-migration-'))
const snapshotPath = path.join(outDir, 'sas-snapshot.db')
const migrations = path.join(__dirname, '..', 'packages', 'db', 'migrations')

const scalar = async (client, sql, args = []) => Number((await client.execute({ sql, args })).rows[0]?.n ?? 0)

async function projectSnapshot(client, gameId) {
  const counts = {}
  const projectTables = [
    'tasks',
    'tags',
    'events',
    'wishlist_points',
    'wishlist_imports',
    'utm_links',
    'sources',
    'festival_picks',
    'creator_picks',
    'creator_touches',
    'ai_runs',
  ]
  for (const table of projectTables) {
    counts[table] = await scalar(client, `SELECT count(*) AS n FROM ${table} WHERE game_id = ?`, [gameId])
  }
  counts.task_checklist_items = await scalar(
    client,
    'SELECT count(*) AS n FROM task_checklist_items i JOIN tasks t ON t.id=i.task_id WHERE t.game_id=?',
    [gameId],
  )
  counts.task_dependencies = await scalar(
    client,
    'SELECT count(*) AS n FROM task_dependencies d JOIN tasks t ON t.id=d.blocker_task_id WHERE t.game_id=?',
    [gameId],
  )
  counts.task_links = await scalar(
    client,
    'SELECT count(*) AS n FROM task_links l JOIN tasks t ON t.id=l.task_id WHERE t.game_id=?',
    [gameId],
  )
  counts.task_tag_links = await scalar(
    client,
    'SELECT count(*) AS n FROM task_tag_links l JOIN tasks t ON t.id=l.task_id WHERE t.game_id=?',
    [gameId],
  )
  counts.event_metrics = await scalar(
    client,
    'SELECT count(*) AS n FROM event_metrics m JOIN events e ON e.id=m.event_id WHERE e.game_id=?',
    [gameId],
  )
  counts.sync_runs = await scalar(
    client,
    'SELECT count(*) AS n FROM sync_runs r JOIN sources s ON s.id=r.source_id WHERE s.game_id=?',
    [gameId],
  )
  counts.ai_messages = await scalar(
    client,
    'SELECT count(*) AS n FROM ai_messages m JOIN ai_runs r ON r.id=m.run_id WHERE r.game_id=?',
    [gameId],
  )
  counts.ai_proposal_changes = await scalar(
    client,
    'SELECT count(*) AS n FROM ai_proposal_changes c JOIN ai_runs r ON r.id=c.run_id WHERE r.game_id=?',
    [gameId],
  )
  return counts
}

async function main() {
  if (!fs.existsSync(source)) throw new Error(`active database not found: ${source}`)

  const live = createClient({ url: fileUrlFromPath(source) })
  const liveIntegrity = (await live.execute('PRAGMA integrity_check')).rows[0]?.integrity_check
  if (liveIntegrity !== 'ok') throw new Error(`source integrity_check failed: ${liveIntegrity}`)
  const escapedSnapshot = snapshotPath.replace(/'/g, "''").replace(/\\/g, '/')
  await live.execute(`VACUUM INTO '${escapedSnapshot}'`)
  live.close()

  const { db, client } = createDb(fileUrlFromPath(snapshotPath))
  const game = (
    await client.execute("SELECT id,name,key FROM games WHERE key='SAS' OR lower(name)='salt and soil' LIMIT 1")
  ).rows[0]
  if (!game) throw new Error('SAS project not found in the active database snapshot')

  const before = await projectSnapshot(client, String(game.id))
  const allBefore = {
    games: await scalar(client, 'SELECT count(*) AS n FROM games'),
    settings: await scalar(client, 'SELECT count(*) AS n FROM settings'),
    industry_events: await scalar(client, 'SELECT count(*) AS n FROM industry_events'),
    creators: await scalar(client, 'SELECT count(*) AS n FROM creators'),
    api_spend: await scalar(client, 'SELECT count(*) AS n FROM api_spend'),
    provider_settings: await scalar(client, 'SELECT count(*) AS n FROM provider_settings'),
    outreach_templates: await scalar(client, 'SELECT count(*) AS n FROM outreach_templates'),
  }
  await runMigrations(db, client, migrations)
  const after = await projectSnapshot(client, String(game.id))
  const allAfter = {
    games: await scalar(client, 'SELECT count(*) AS n FROM games'),
    settings: await scalar(client, 'SELECT count(*) AS n FROM settings'),
    industry_events: await scalar(client, 'SELECT count(*) AS n FROM industry_events'),
    creators: await scalar(client, 'SELECT count(*) AS n FROM creators'),
    api_spend: await scalar(client, 'SELECT count(*) AS n FROM api_spend'),
    provider_settings: await scalar(client, 'SELECT count(*) AS n FROM provider_settings'),
    outreach_templates: await scalar(client, 'SELECT count(*) AS n FROM outreach_templates'),
  }
  const integrity = (await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check

  const expectedEvents = before.events + before.creator_touches
  const unchanged = Object.keys(before).filter((key) => key !== 'events')
  const changed = unchanged.filter((key) => before[key] !== after[key])
  if (changed.length) throw new Error(`SAS counts changed: ${changed.join(', ')}`)
  if (after.events !== expectedEvents) {
    throw new Error(`expected ${expectedEvents} journal rows, got ${after.events}`)
  }
  if (JSON.stringify(allBefore) !== JSON.stringify(allAfter)) throw new Error('global catalog/settings counts changed')
  if (integrity !== 'ok') throw new Error(`migrated snapshot integrity_check failed: ${integrity}`)

  client.close()
  console.log(
    JSON.stringify(
      {
        result: 'SAS MIGRATION COPY OK',
        source,
        snapshotPath,
        project: { id: game.id, name: game.name, key: game.key },
        counts: after,
        global: allAfter,
        integrity,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error('SAS MIGRATION COPY FAIL', error)
  process.exit(1)
})
