/* Verify migration 0005 converts existing milestones → dated tags + task_tag_links. */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { createClient } = require('@libsql/client')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-mig-'))
  const file = path.join(dir, 'm.db').replace(/\\/g, '/')
  const client = createClient({ url: 'file:' + file })
  const migDir = path.join(require.resolve('@marcat/db'), '..', '..', 'migrations')
  const all = fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const applySql = async (f) => {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const s = stmt.trim()
      if (s) await client.execute(s)
    }
  }

  // Apply everything BEFORE 0005 (the old schema).
  for (const f of all.filter((f) => Number(f.slice(0, 4)) < 5)) await applySql(f)

  const ts = '2026-01-01T00:00:00Z'
  await client.execute({
    sql: 'INSERT INTO games (id,name,slug,color,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    args: ['g1', 'Game', 'game', '#27C281', ts, ts],
  })
  await client.execute({
    sql: 'INSERT INTO milestones (id,game_id,name,type,date,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    args: ['m1', 'g1', 'Announce', 'festival', '2026-10-01', ts, ts],
  })
  await client.execute({
    sql: 'INSERT INTO tasks (id,game_id,milestone_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    args: ['t1', 'g1', 'm1', 'Task A', ts, ts],
  })

  // Now apply 0005 (the merge migration).
  await applySql(all.find((f) => f.startsWith('0005')))

  const tags = (await client.execute('SELECT id,name,target_date,type FROM tags')).rows
  const links = (await client.execute('SELECT task_id,tag_id FROM task_tag_links')).rows
  console.log('tags:', JSON.stringify(tags))
  console.log('links:', JSON.stringify(links))

  if (!tags.find((r) => r.id === 'm1' && r.target_date === '2026-10-01' && r.type === 'festival'))
    throw new Error('milestone -> dated tag failed')
  if (!links.find((r) => r.task_id === 't1' && r.tag_id === 'm1')) throw new Error('milestone_id -> tag link failed')
  console.log('MIG OK')
}

main().catch((e) => {
  console.error('MIG FAIL', e)
  process.exit(1)
})
