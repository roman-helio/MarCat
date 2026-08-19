const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createClient } = require('@libsql/client')

async function applyMigration(client, file) {
  const source = fs.readFileSync(file, 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    const sql = statement.trim()
    if (sql) await client.execute(sql)
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-youtube-storage-migration-'))
  const dbPath = path.join(dir, 'legacy.db')
  const migrations = path.join(require.resolve('@marcat/db'), '..', '..', 'migrations')
  const client = createClient({ url: `file:${dbPath.replace(/\\/g, '/')}` })
  try {
    const files = fs
      .readdirSync(migrations)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort()
    for (const name of files.filter((name) => Number(name.slice(0, 4)) <= 37)) {
      await applyMigration(client, path.join(migrations, name))
    }

    const timestamp = '2026-07-31T12:00:00.000Z'
    await client.batch(
      [
        {
          sql: 'INSERT INTO games (id, name, slug, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          args: ['game', 'Migration fixture', 'migration-fixture', '#27C281', timestamp, timestamp],
        },
        {
          sql: `INSERT INTO creator_discovery_profiles
            (id, game_id, name, mode, languages_json, include_terms_json, exclude_terms_json, seed_channels_json,
             max_search_requests, max_channels, recent_video_limit, discover_contacts, created_at, updated_at)
            VALUES (?, ?, ?, 'topic', '[]', '[]', '[]', '[]', 10, 500, 50, 1, ?, ?)`,
          args: ['profile', 'game', 'Migration fixture', timestamp, timestamp],
        },
        {
          sql: `INSERT INTO creator_discovery_runs
            (id, game_id, profile_id, profile_hash, profile_snapshot_json, status, phase, created_at, finished_at)
            VALUES (?, ?, ?, ?, '{}', 'completed', 'completed', ?, ?)`,
          args: ['run', 'game', 'profile', 'hash', timestamp, timestamp],
        },
        {
          sql: `INSERT INTO youtube_api_requests
            (id, last_run_id, key_fingerprint, endpoint, request_hash, status, quota_bucket, quota_cost, quota_date,
             response_json, cache_expires_at, completed_at, updated_at, created_at)
            VALUES (?, ?, ?, 'videos', ?, 'succeeded', 'data', 1, '2026-07-31', ?, ?, ?, ?, ?)`,
          args: [
            'request',
            'run',
            'fingerprint',
            'hash',
            JSON.stringify({ items: [{ description: 'x'.repeat(1_000_000) }] }),
            '2026-08-30T12:00:00.000Z',
            timestamp,
            timestamp,
            timestamp,
          ],
        },
      ],
      'write',
    )

    await applyMigration(
      client,
      path.join(
        migrations,
        files.find((name) => name.startsWith('0038_')),
      ),
    )

    const columns = (await client.execute('PRAGMA table_info(youtube_api_requests)')).rows.map((row) => row.name)
    assert.equal(columns.includes('response_json'), false)
    assert.equal(columns.includes('cache_expires_at'), false)
    assert.equal(
      Number((await client.execute('SELECT count(*) AS count FROM youtube_api_requests')).rows[0].count),
      1,
      '0038 may already be recorded before cleanup is shipped',
    )

    await applyMigration(
      client,
      path.join(
        migrations,
        files.find((name) => name.startsWith('0039_')),
      ),
    )

    assert.equal(Number((await client.execute('SELECT count(*) AS count FROM youtube_api_requests')).rows[0].count), 0)
    assert.equal(
      Number((await client.execute('SELECT count(*) AS count FROM creator_discovery_run_channels')).rows[0].count),
      0,
    )
    assert.equal(
      (await client.execute("SELECT youtube_completed_at FROM creator_discovery_runs WHERE id = 'run'")).rows[0]
        .youtube_completed_at,
      timestamp,
    )
    assert.equal(
      (await client.execute("SELECT value FROM settings WHERE key = 'maintenance.youtube_storage_v1'")).rows[0].value,
      'pending',
    )
    await client.execute('VACUUM')
    assert.ok(fs.statSync(dbPath).size < 1_000_000, 'compacted database must not retain the raw payload allocation')
    console.log('YOUTUBE STORAGE MIGRATION OK (raw payload removed; normalized resume schema ready)')
  } finally {
    client.close()
    if (process.platform === 'win32') {
      const cleaner = spawn(
        process.execPath,
        [
          '-e',
          "const fs=require('node:fs');setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:30,retryDelay:100}),500)",
          dir,
        ],
        { detached: true, stdio: 'ignore', windowsHide: true },
      )
      cleaner.unref()
    } else {
      await new Promise((resolve) => setTimeout(resolve, 30))
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

main().catch((error) => {
  console.error('YOUTUBE STORAGE MIGRATION FAIL', error)
  process.exit(1)
})
