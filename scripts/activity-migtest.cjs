/* Verify activity migrations preserve the journal and normalize legacy event semantics. */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { createClient } = require('@libsql/client')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-activity-mig-'))
  const client = createClient({ url: `file:${path.join(dir, 'activity.db').replace(/\\/g, '/')}` })
  const migrations = path.join(__dirname, '..', 'packages', 'db', 'migrations')
  const files = fs
    .readdirSync(migrations)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort()
  const apply = async (name) => {
    const source = fs.readFileSync(path.join(migrations, name), 'utf8')
    for (const statement of source.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.execute(statement.trim())
    }
  }

  for (const name of files.filter((name) => Number(name.slice(0, 4)) < 15)) await apply(name)
  const stamp = '2026-07-01T10:00:00.000Z'
  await client.execute({
    sql: 'INSERT INTO games (id,name,slug,steam_store_url,color,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    args: [
      'g1',
      'Salt and Soil',
      'salt-and-soil',
      'https://store.steampowered.com/app/4551060/',
      '#27C281',
      stamp,
      stamp,
    ],
  })
  await client.execute({
    sql: 'INSERT INTO creators (id,name,kind,source,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    args: ['c1', 'Creator One', 'youtuber', 'manual', stamp, stamp],
  })
  await client.execute({
    sql: 'INSERT INTO events (id,game_id,occurred_at,type,title,description,is_own,creator_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    args: ['e1', 'g1', '2026-07-01', 'video', 'Coverage', 'Existing event body', 0, 'c1', 'manual', stamp, stamp],
  })
  await client.execute({
    sql: 'INSERT INTO creator_touches (id,game_id,creator_id,occurred_at,direction,channel,summary,body,status_after,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    args: ['t1', 'g1', 'c1', '2026-07-02', 'outbound', 'email', 'Pitch sent', 'Full email body', 'contacted', stamp],
  })

  await apply(files.find((name) => name.startsWith('0015_')))
  await client.execute({
    sql: 'INSERT INTO events (id,game_id,occurred_at,subject_type,subject_id,show_on_wishlist,direction,channel,status_after,type,platform,title,description,is_own,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    args: [
      'e2',
      'g1',
      '2026-07-03',
      'task',
      'task-1',
      1,
      'outbound',
      'r/CityBuilders',
      'ready_to_post',
      'reddit_post',
      'Reddit',
      'Reveal post',
      'Full Reddit copy',
      1,
      'manual',
      stamp,
      stamp,
    ],
  })
  for (const name of files.filter((name) => Number(name.slice(0, 4)) > 15)) await apply(name)
  const rows = (await client.execute('SELECT * FROM events ORDER BY occurred_at')).rows
  const legacy = (await client.execute('SELECT count(*) AS n FROM creator_touches')).rows[0]
  const integrity = (await client.execute('PRAGMA integrity_check')).rows[0]
  const event = rows.find((row) => row.id === 'e1')
  const touch = rows.find((row) => row.id === 't1')
  const reddit = rows.find((row) => row.id === 'e2')

  if (rows.length !== 3) throw new Error(`expected 3 activities, got ${rows.length}`)
  if (event.subject_type !== 'creator' || event.subject_id !== 'c1' || event.show_on_wishlist !== 1)
    throw new Error('existing event was not preserved as a chart activity')
  if (touch.description !== 'Full email body' || touch.direction !== 'outbound' || touch.show_on_wishlist !== 0)
    throw new Error('creator touch was not preserved as a journal activity')
  if (
    reddit.placement !== 'r/CityBuilders' ||
    reddit.platform !== 'reddit' ||
    reddit.type !== 'post' ||
    reddit.direction !== null ||
    reddit.channel !== null ||
    reddit.status_after !== null
  )
    throw new Error('legacy Reddit activity semantics were not normalized')
  if (Number(legacy.n) !== 1) throw new Error('legacy creator touch rollback copy was removed')
  if (integrity.integrity_check !== 'ok') throw new Error('migrated database failed integrity check')
  client.close()
  console.log('ACTIVITY MIGRATION OK')
}

main().catch((error) => {
  console.error('ACTIVITY MIGRATION FAIL', error)
  process.exit(1)
})
