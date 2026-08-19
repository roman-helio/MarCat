const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { appRouter } = require('@marcat/core')
const { configureConnection, createDb, fileUrlFromPath, runMigrations, withSqliteBusyRetry } = require('@marcat/db')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-outreach-'))
  const dbPath = path.join(dir, 'outreach.db')
  const migrations = path.join(require.resolve('@marcat/db'), '..', '..', 'migrations')
  const root = createDb(fileUrlFromPath(dbPath))
  const extraConnections = []
  try {
    await configureConnection(root.client)
    await runMigrations(root.db, root.client, migrations)
    const caller = appRouter.createCaller({ db: root.db })
    const game = await caller.games.create({ name: 'Outreach Safety' })
    const creator = await caller.creators.create({ name: 'Atomic Creator', handle: 'https://example.com/atomic' })
    assert.equal(creator.entityType, 'person')
    const platforms = JSON.stringify([{ platform: 'youtube' }, { platform: 'twitch' }])
    const enrichedCreator = await caller.creators.update({
      id: creator.id,
      entityType: 'media',
      primaryPlatform: 'youtube',
      channelsJson: platforms,
    })
    assert.equal(enrichedCreator.entityType, 'media')
    assert.deepEqual(JSON.parse(enrichedCreator.channelsJson), JSON.parse(platforms))

    await assert.rejects(
      caller.creators.setStatus({ gameId: game.id, creatorId: creator.id, pipelineStatus: 'contacted' }),
      /not picked/,
    )
    await caller.creators.pick({ gameId: game.id, creatorId: creator.id })
    const explicitlyContacted = await caller.creators.setStatus({
      gameId: game.id,
      creatorId: creator.id,
      pipelineStatus: 'contacted',
    })
    assert.equal(explicitlyContacted.pipelineStatus, 'contacted')
    await caller.creators.setStatus({ gameId: game.id, creatorId: creator.id, pipelineStatus: 'prospect' })

    const touchInput = {
      gameId: game.id,
      creatorId: creator.id,
      occurredAt: '2026-07-28',
      direction: 'outbound',
      channel: 'email',
      summary: 'Sent one message',
      body: 'Complete message body',
      statusAfter: 'contacted',
      requestId: 'outreach-test-one',
    }
    const first = await caller.creators.logTouch(touchInput)
    const replay = await caller.creators.logTouch(touchInput)
    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.id, first.id)
    assert.equal(first.pick.pipelineStatus, 'contacted')
    assert.equal((await caller.creators.touches({ gameId: game.id, creatorId: creator.id })).length, 1)

    await caller.creators.setStatus({ gameId: game.id, creatorId: creator.id, pipelineStatus: 'replied' })
    const laterTouch = await caller.creators.logTouch({
      ...touchInput,
      requestId: 'outreach-test-no-regression',
      statusAfter: 'contacted',
    })
    assert.equal(laterTouch.pick.pipelineStatus, 'replied')

    const unpicked = await caller.creators.create({ name: 'Unpicked Creator', handle: 'https://example.com/unpicked' })
    await assert.rejects(
      caller.creators.logTouch({ ...touchInput, creatorId: unpicked.id, requestId: 'outreach-test-unpicked' }),
      /not picked/,
    )
    assert.equal((await caller.creators.touches({ gameId: game.id, creatorId: unpicked.id })).length, 0)

    const second = await caller.creators.create({ name: 'Batch Creator', handle: 'https://example.com/batch' })
    await caller.creators.pick({ gameId: game.id, creatorId: second.id })
    await assert.rejects(
      caller.creators.logTouchesBulk({
        gameId: game.id,
        items: [
          {
            creatorId: second.id,
            direction: 'outbound',
            channel: 'email',
            summary: 'Must roll back',
            requestId: 'outreach-test-rollback',
            statusAfter: 'contacted',
          },
          {
            creatorId: 'missing-creator',
            direction: 'outbound',
            channel: 'email',
            summary: 'Invalid item',
            requestId: 'outreach-test-invalid',
            statusAfter: 'contacted',
          },
        ],
      }),
      /not picked/,
    )
    assert.equal((await caller.creators.touches({ gameId: game.id, creatorId: second.id })).length, 0)

    const batch = await caller.creators.logTouchesBulk({
      gameId: game.id,
      items: [
        {
          creatorId: second.id,
          direction: 'outbound',
          channel: 'email',
          summary: 'Batch message',
          requestId: 'outreach-test-batch',
          statusAfter: 'contacted',
        },
      ],
    })
    assert.equal(batch.count, 1)
    assert.equal(batch.results[0].pick.pipelineStatus, 'contacted')

    for (let index = 0; index < 4; index += 1) {
      const connection = createDb(fileUrlFromPath(dbPath))
      await configureConnection(connection.client)
      extraConnections.push(connection)
    }
    const concurrent = await Promise.all(
      extraConnections.map(({ db }) =>
        appRouter.createCaller({ db }).creators.logTouch({
          ...touchInput,
          requestId: 'outreach-test-concurrent-retry',
          summary: 'One message from concurrent retries',
        }),
      ),
    )
    assert.equal(new Set(concurrent.map((item) => item.id)).size, 1)
    assert.equal(
      (await caller.creators.touches({ gameId: game.id, creatorId: creator.id })).filter(
        (item) => item.idempotencyKey === 'creator-touch:outreach-test-concurrent-retry',
      ).length,
      1,
    )

    let attempts = 0
    const retried = await withSqliteBusyRetry(
      async () => {
        attempts += 1
        if (attempts < 3) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
        return 'ok'
      },
      { initialDelayMs: 0 },
    )
    assert.equal(retried, 'ok')
    assert.equal(attempts, 3)

    console.log('CREATOR OUTREACH OK (profile fields + strict status + atomic batch + idempotent retry)')
  } finally {
    for (const connection of extraConnections) connection.client.close()
    root.client.close()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        break
      } catch (error) {
        if (attempt === 9) throw error
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
}

main().catch((error) => {
  console.error('CREATOR OUTREACH FAIL', error)
  process.exitCode = 1
})
