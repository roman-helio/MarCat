const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { appRouter, processYouTubeDiscoveryQueue } = require('@marcat/core')
const { configureConnection, createDb, fileUrlFromPath, runMigrations } = require('@marcat/db')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-youtube-discovery-'))
  const dbPath = path.join(dir, 'discovery.db')
  const migrations = path.join(require.resolve('@marcat/db'), '..', '..', 'migrations')
  const database = createDb(fileUrlFromPath(dbPath))
  const originalFetch = global.fetch
  const apiKey = ['test', 'youtube', 'credential'].join('-')
  const secrets = {
    getApiKey: (provider) => (provider === 'youtube' ? apiKey : undefined),
    setApiKey: () => {},
    getClaudeToken: () => undefined,
    setClaudeToken: () => {},
    getAiProvider: () => undefined,
    setAiProvider: () => {},
  }
  const channelId = 'UC1234567890123456789012'
  let networkCalls = 0
  global.fetch = async (input) => {
    networkCalls += 1
    const url = new URL(String(input))
    const endpoint = url.pathname.split('/').at(-1)
    if (endpoint === 'search') {
      return Response.json({
        items: [{ id: { videoId: `seed-${networkCalls}` }, snippet: { channelId, channelTitle: 'Overlap Lab' } }],
      })
    }
    if (endpoint === 'channels') {
      return Response.json({
        items: [
          {
            id: channelId,
            snippet: {
              title: 'Overlap Lab',
              description: 'Business inquiries: hello@overlap.example https://overlap.example/contact',
              customUrl: '@overlaplab',
              country: 'US',
              defaultLanguage: 'en',
              thumbnails: { high: { url: 'https://img.example/channel.jpg' } },
            },
            statistics: { subscriberCount: '42000', viewCount: '5000000', videoCount: '200' },
            contentDetails: { relatedPlaylists: { uploads: 'UU1234567890123456789012' } },
          },
        ],
      })
    }
    if (endpoint === 'playlistItems') {
      return Response.json({
        items: [
          { snippet: { resourceId: { videoId: 'video-a' } } },
          { snippet: { resourceId: { videoId: 'video-b' } } },
        ],
      })
    }
    if (endpoint === 'videos') {
      return Response.json({
        items: [
          {
            id: 'video-a',
            snippet: {
              channelId,
              title: 'Deep dive: Alpha Game review',
              description: 'Contact hello@overlap.example',
              publishedAt: '2026-07-20T12:00:00Z',
            },
            statistics: { viewCount: '12000' },
          },
          {
            id: 'video-b',
            snippet: {
              channelId,
              title: 'Beta Quest strategy history',
              description: '',
              publishedAt: '2026-07-25T12:00:00Z',
            },
            statistics: { viewCount: '18000' },
          },
        ],
      })
    }
    return new Response('Unexpected endpoint', { status: 404 })
  }

  try {
    await configureConnection(database.client)
    await runMigrations(database.db, database.client, migrations)
    const caller = appRouter.createCaller({ db: database.db, secrets })
    const game = await caller.games.create({ name: 'Discovery Test' })
    const profile = await caller.creatorDiscovery.createProfile({
      gameId: game.id,
      name: 'Reference overlap',
      mode: 'games',
      languages: ['en'],
      includeTerms: [],
      excludeTerms: ['giveaway'],
      seedChannels: [],
      maxSearchRequests: 2,
      maxChannels: 10,
      recentVideoLimit: 10,
      discoverContacts: true,
      references: [
        { label: 'Alpha Game', aliases: ['Alpha'], queryTerms: ['Alpha Game review'], weight: 1 },
        { label: 'Beta Quest', aliases: ['Beta'], queryTerms: ['Beta Quest gameplay'], weight: 1 },
      ],
    })
    const first = await caller.creatorDiscovery.start({ profileId: profile.id, forceNew: false })
    const duplicate = await caller.creatorDiscovery.start({ profileId: profile.id, forceNew: false })
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.run.id, first.run.id)
    assert.equal((await caller.creators.list()).length, 0, 'discovery must not write directly to production CRM')

    await processYouTubeDiscoveryQueue(database.db, secrets)
    const completed = await caller.creatorDiscovery.getRun({ id: first.run.id })
    assert.equal(completed.status, 'completed')
    assert.equal(completed.searchRequestsUsed, 2)
    assert.equal(completed.dataUnitsUsed, 3)
    const staged = await caller.creatorDiscovery.candidates({
      runId: first.run.id,
      status: 'staged',
      minFit: 0,
      limit: 50,
    })
    assert.equal(staged.length, 1)
    assert.equal(staged[0].result.matchedReferenceCount, 2)
    assert.deepEqual(JSON.parse(staged[0].result.matchedReferencesJson), ['Alpha Game', 'Beta Quest'])
    assert.equal(staged[0].contacts.filter((contact) => contact.type === 'business_email').length, 1)

    const quotaBeforeReplay = await caller.creatorDiscovery.quota()
    assert.equal(quotaBeforeReplay.search.used, 2)
    assert.equal(quotaBeforeReplay.data.used, 3)
    assert.equal(networkCalls, 5)

    const freshDuplicate = await caller.creatorDiscovery.start({ profileId: profile.id, forceNew: false })
    assert.equal(freshDuplicate.run.id, first.run.id)
    const forced = await caller.creatorDiscovery.start({ profileId: profile.id, forceNew: true })
    assert.notEqual(forced.run.id, first.run.id)
    await processYouTubeDiscoveryQueue(database.db, secrets)
    assert.equal(networkCalls, 5, 'identical YouTube requests must be served from the durable cache')
    const quotaAfterReplay = await caller.creatorDiscovery.quota()
    assert.equal(quotaAfterReplay.search.used, 2)
    assert.equal(quotaAfterReplay.data.used, 3)
    await database.client.execute({
      sql: "UPDATE creator_discovery_runs SET status = 'waiting_for_quota', phase = 'waiting_for_quota', heartbeat_at = ? WHERE id = ?",
      args: ['2020-01-01T00:00:00.000Z', forced.run.id],
    })
    await processYouTubeDiscoveryQueue(database.db, secrets)
    assert.equal((await caller.creatorDiscovery.getRun({ id: forced.run.id })).status, 'completed')
    assert.equal(networkCalls, 5, 'a run resumed after quota reset must still reuse cached requests')

    const promoted = await caller.creatorDiscovery.promote({ runId: first.run.id, candidateId: staged[0].candidate.id })
    const promotedAgain = await caller.creatorDiscovery.promote({
      runId: first.run.id,
      candidateId: staged[0].candidate.id,
    })
    assert.equal(promotedAgain.creatorId, promoted.creatorId)
    const creators = await caller.creators.list()
    assert.equal(creators.length, 1)
    assert.equal(creators[0].youtubeChannelId, channelId)
    assert.equal((await caller.creators.picks({ gameId: game.id })).length, 1)
    const promotedEvidence = await caller.creatorDiscovery.promotedEvidence({
      gameId: game.id,
      creatorId: promoted.creatorId,
      limit: 5,
    })
    assert.equal(promotedEvidence.length, 1)
    assert.deepEqual(promotedEvidence[0].matchedReferences, ['Alpha Game', 'Beta Quest'])
    assert.equal(promotedEvidence[0].evidence.length, 2)

    const aiCaller = appRouter.createCaller({
      db: database.db,
      secrets,
      agent: {
        async run() {
          return {
            summary: 'Queued a topic discovery search',
            changes: [
              {
                op: 'create',
                entity: 'creator_discovery_search',
                after: {
                  name: 'History experts',
                  mode: 'topic',
                  references: [
                    { label: 'Ancient Rome', aliases: ['Roman history'] },
                    { label: 'Medieval warfare', queryTerms: ['medieval battle documentary'] },
                  ],
                  languages: ['en'],
                  maxSearchRequests: 3,
                  discoverContacts: true,
                },
              },
            ],
            rawOutput: '{}',
            model: 'mock',
          }
        },
      },
    })
    const aiRun = await aiCaller.ai.run({ gameId: game.id, prompt: 'Find YouTube historians at scale' })
    let stagedAiRun = await aiCaller.ai.getRun({ id: aiRun.id })
    for (let index = 0; index < 100 && stagedAiRun.run.status === 'running'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      stagedAiRun = await aiCaller.ai.getRun({ id: aiRun.id })
    }
    const applied = await aiCaller.ai.applyRun({ id: aiRun.id })
    assert.equal(applied.applied, 1)
    const profiles = await caller.creatorDiscovery.profiles({ gameId: game.id })
    const historyProfile = profiles.find((item) => item?.name === 'History experts')
    assert.ok(historyProfile)
    assert.equal(historyProfile.mode, 'topic')
    assert.equal(historyProfile.references.length, 2)
    const historyRuns = await caller.creatorDiscovery.runs({ gameId: game.id, limit: 50 })
    assert.ok(historyRuns.some((run) => run.profileId === historyProfile.id && run.status === 'queued'))

    console.log('YOUTUBE DISCOVERY OK (onboarding model + staging + evidence + quota + dedupe + AI-managed run)')
  } finally {
    global.fetch = originalFetch
    database.client.close()
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
  console.error('YOUTUBE DISCOVERY FAIL', error)
  process.exitCode = 1
})
