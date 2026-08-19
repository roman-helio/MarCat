/* Verify catalogue transports stay bounded while the local SQLite index grows. */
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { appRouter } = require('@marcat/core')
const { createDb, fileUrlFromPath, runMigrations, schema } = require('@marcat/db')

const MCP_RESPONSE_LIMIT = 256 * 1024

async function insertChunks(db, table, rows, size = 250) {
  for (let offset = 0; offset < rows.length; offset += size) {
    await db.insert(table).values(rows.slice(offset, offset + size))
  }
}

function responseBytes(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8')
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-transport-'))
  const dbFile = path.join(dir, 'scale.db')
  const { db, client } = createDb(fileUrlFromPath(dbFile))
  try {
    await runMigrations(db, client, path.join(require.resolve('@marcat/db'), '..', '..', 'migrations'))
    const caller = appRouter.createCaller({ db })
    const game = await caller.games.create({ name: 'Transport Scale' })

    const creators = Array.from({ length: 5_000 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `Creator ${String(index).padStart(5, '0')}`,
      handle: `@creator${index}`,
      primaryPlatform: index % 2 ? 'youtube' : 'tiktok',
      audience: 1_000 + index,
      language: index % 3 ? 'en' : 'ru',
      topicsJson: JSON.stringify(['strategy', `facet-${index % 20}`]),
      contactsJson: JSON.stringify([
        {
          type: 'business_email',
          value: `creator${index}@example.com`,
          verified: index % 2 === 0,
          gated: false,
          sourceUrl: `https://example.com/creator/${index}`,
        },
      ]),
      channelsJson: JSON.stringify([
        {
          platform: index % 2 ? 'youtube' : 'tiktok',
          url: `https://example.com/channel/${index}`,
          subscribers: 1_000 + index,
        },
      ]),
    }))
    await insertChunks(db, schema.creators, creators)

    const activities = Array.from({ length: 10_000 }, (_, index) => ({
      id: crypto.randomUUID(),
      gameId: game.id,
      occurredAt: `2026-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
      subjectType: 'project',
      showOnWishlist: index % 20 === 0,
      type: index % 2 ? 'post' : 'video',
      platform: index % 2 ? 'reddit' : 'youtube',
      title: `Activity ${String(index).padStart(5, '0')}`,
      description: `Full activity body ${index}. ${'Evidence '.repeat(40)}`,
    }))
    await insertChunks(db, schema.events, activities)

    const festivals = Array.from({ length: 2_000 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `Festival ${String(index).padStart(5, '0')}`,
      startDate: `2027-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
      type: index % 2 ? 'festival' : 'showcase',
      description: `Festival description ${index}. ${'Details '.repeat(20)}`,
      notes: `Internal festival notes ${index}`,
    }))
    await insertChunks(db, schema.industryEvents, festivals)

    const creatorPage = await caller.creators.search({ hasBusinessEmail: true, limit: 50 })
    const creatorMatch = await caller.creators.search({ query: 'Creator 04999', limit: 20 })
    const activityPage = await caller.activities.search({ gameId: game.id, limit: 50 })
    const activityMatch = await caller.activities.search({ gameId: game.id, search: 'Activity 09999', limit: 20 })
    const festivalPage = await caller.festivals.search({ from: '2027-01-01', to: '2027-12-31', limit: 50 })

    if (creatorPage.totalCount !== 5_000 || creatorPage.items.length !== 50 || creatorPage.nextOffset !== 50) {
      throw new Error('creator catalogue page is not bounded or count-aware')
    }
    if (creatorMatch.totalCount !== 1 || creatorMatch.items[0]?.name !== 'Creator 04999') {
      throw new Error('creator catalogue server-side search failed')
    }
    if ('contactsJson' in creatorPage.items[0] || 'channelsJson' in creatorPage.items[0]) {
      throw new Error('creator summary leaked duplicate raw JSON fields')
    }
    if (activityPage.totalCount !== 10_000 || activityPage.items.length !== 50 || activityPage.nextOffset !== 50) {
      throw new Error('activity journal page is not bounded or count-aware')
    }
    if (activityMatch.totalCount !== 1 || activityMatch.items[0]?.title !== 'Activity 09999') {
      throw new Error('activity server-side search failed')
    }
    if ('description' in activityPage.items[0] || 'body' in activityPage.items[0]) {
      throw new Error('activity summary included an unbounded full body')
    }
    if (festivalPage.totalCount !== 2_000 || festivalPage.items.length !== 50 || festivalPage.nextOffset !== 50) {
      throw new Error('festival catalogue page is not bounded or count-aware')
    }

    const sizes = {
      creators: responseBytes(creatorPage),
      activities: responseBytes(activityPage),
      festivals: responseBytes(festivalPage),
    }
    for (const [name, bytes] of Object.entries(sizes)) {
      if (bytes >= MCP_RESPONSE_LIMIT) throw new Error(`${name} page exceeds the MCP response limit: ${bytes}`)
    }
    console.log(
      `Transport scale OK · 5,000 creators / 10,000 activities / 2,000 festivals · page bytes ${JSON.stringify(sizes)}`,
    )
  } finally {
    await client.close()
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      // libsql can retain a Windows file handle until process exit; the OS temp directory remains recoverable.
      if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error
    }
  }
}

main().catch((error) => {
  console.error('Transport scale FAIL', error)
  process.exit(1)
})
