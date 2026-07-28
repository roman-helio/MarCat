const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createClient } = require('@libsql/client')

async function applyMigration(client, migrations, filename) {
  const source = fs.readFileSync(path.join(migrations, filename), 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    if (statement.trim()) await client.execute(statement.trim())
  }
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-workspace-upgrade-'))
  const dbPath = path.join(temp, 'upgrade.db').replace(/\\/g, '/')
  const client = createClient({ url: `file:${dbPath}` })
  const migrations = path.resolve(__dirname, '../packages/db/migrations')
  const files = fs
    .readdirSync(migrations)
    .filter((name) => /^\d{4}.*\.sql$/.test(name))
    .sort()
  const upgrade = files.find((name) => name.startsWith('0024_'))
  const rollingCompatibility = files.find((name) => name.startsWith('0025_'))
  assert.ok(upgrade, 'workspace upgrade migration 0024 must exist')
  assert.ok(rollingCompatibility, 'workspace rolling-upgrade migration 0025 must exist')
  for (const filename of files.filter((name) => name < upgrade)) await applyMigration(client, migrations, filename)

  const before = (await client.execute('PRAGMA table_info(workspace_import_guard)')).rows.map((row) => row.name)
  assert.deepEqual(before, ['game_id', 'owner', 'created_at'])
  await applyMigration(client, migrations, upgrade)
  await applyMigration(client, migrations, rollingCompatibility)
  const after = (await client.execute('PRAGMA table_info(workspace_import_guard)')).rows.map((row) => row.name)
  assert.deepEqual(after, ['game_id', 'owner', 'created_at', 'entity_type', 'entity_id'])

  const now = '2026-07-22T00:00:00.000Z'
  await client.execute({
    sql: 'INSERT INTO games(id,name,slug,color,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    args: ['g1', 'Migration', 'migration', '#27C281', now, now],
  })
  await client.execute({
    sql: 'INSERT INTO workspace_configs(game_id,root_path,enabled,created_at,updated_at) VALUES(?,?,?,?,?)',
    args: ['g1', 'C:/workspace', 1, now, now],
  })
  await client.execute({
    sql: 'INSERT INTO insights(id,game_id,title,body,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    args: ['i1', 'g1', 'One', 'One', 'manual', now, now],
  })
  await client.execute({
    sql: 'INSERT INTO insights(id,game_id,title,body,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    args: ['i2', 'g1', 'Two', 'Two', 'manual', now, now],
  })
  await client.execute('UPDATE workspace_outbox SET processed_at=created_at')
  await client.execute({
    sql: 'INSERT INTO workspace_import_guard(game_id,entity_type,entity_id,owner,created_at) VALUES(?,?,?,?,?)',
    args: ['g1', 'insight', 'i1', 'test-owner', now],
  })
  await client.execute("UPDATE insights SET body='guarded' WHERE id='i1'")
  await client.execute("UPDATE insights SET body='must-export' WHERE id='i2'")
  const queued = (await client.execute('SELECT entity_id FROM workspace_outbox WHERE processed_at IS NULL')).rows
  assert.deepEqual(
    queued.map((row) => row.entity_id),
    ['i2'],
  )
  await client.execute('UPDATE workspace_outbox SET processed_at=created_at')
  await client.execute('DELETE FROM workspace_import_guard')
  await client.execute({
    sql: 'INSERT INTO workspace_import_guard(game_id,owner,created_at) VALUES(?,?,?)',
    args: ['g1', 'legacy-process', now],
  })
  await client.execute("UPDATE insights SET body='legacy import' WHERE id='i2'")
  const legacyQueued = (await client.execute('SELECT entity_id FROM workspace_outbox WHERE processed_at IS NULL')).rows
  assert.deepEqual(legacyQueued, [])
  await client.close()
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch (error) {
    if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error
  }
  console.log('workspace migration upgrade test passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
