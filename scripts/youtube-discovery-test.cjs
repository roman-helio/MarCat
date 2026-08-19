const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  appRouter,
  DrizzleWorkspaceRepository,
  expireYoutubeDiscoveryCache,
  MarkdownWorkspaceCoordinator,
  processCreatorPromotionQueue,
  processYouTubeDiscoveryQueue,
  recoverInterruptedDiscoveryRuns,
  syncYouTubeDiscoveryRunArchive,
  youtubeDiscoveryRunIssue,
} = require('@marcat/core')
const { configureConnection, createDb, fileUrlFromPath, runMigrations } = require('@marcat/db')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-youtube-discovery-'))
  const dbPath = path.join(dir, 'discovery.db')
  const migrations = path.join(require.resolve('@marcat/db'), '..', '..', 'migrations')
  const database = createDb(fileUrlFromPath(dbPath))
  const originalFetch = global.fetch
  const apiKey = ['test', 'youtube', 'credential'].join('-')
  const socialApiKey = ['test', 'social', 'credential'].join('-')
  let youtubeEnabled = true
  let socialEnabled = false
  const secrets = {
    getApiKey: (provider) =>
      provider === 'youtube' && youtubeEnabled
        ? apiKey
        : provider === 'scrapecreators' && socialEnabled
          ? socialApiKey
          : undefined,
    setApiKey: () => {},
    getClaudeToken: () => undefined,
    setClaudeToken: () => {},
    getAiProvider: () => undefined,
    setAiProvider: () => {},
  }
  const channelId = 'UC1234567890123456789012'
  let networkCalls = 0
  let socialApiCalls = 0
  let rejectForExternalQuota = false
  let slicedFixtureEnabled = false
  global.fetch = async (input) => {
    networkCalls += 1
    const url = new URL(String(input))
    const endpoint = url.pathname.split('/').at(-1)
    if (url.hostname === 'api.scrapecreators.com') {
      socialApiCalls += 1
      const credits = 100 - socialApiCalls
      if (url.pathname === '/v1/instagram/search/profiles') {
        const query = url.searchParams.get('query') || ''
        return Response.json({
          success: true,
          credits_remaining: credits,
          credits_charged: 1,
          profiles: [
            {
              id: 'instagram-creator-1',
              username: 'historygrams',
              full_name: 'History Grams',
              biography: `Public history creator. Business: collab@history.example. ${query}`,
              follower_count: 51000,
              media_count: 320,
              profile_pic_url: 'https://img.example/instagram.jpg',
              url: 'https://instagram.com/historygrams',
            },
          ],
        })
      }
      if (url.pathname === '/v1/tiktok/search/keyword') {
        const query = url.searchParams.get('query') || ''
        return Response.json({
          success: true,
          credits_remaining: credits,
          credits_charged: 1,
          search_item_list: [
            {
              aweme_id: `tiktok-${query.replace(/\W/g, '-').toLowerCase()}`,
              desc: `${query} explained`,
              create_time_utc: '2026-07-26T12:00:00Z',
              url: 'https://www.tiktok.com/@historytok/video/123',
              author: {
                uid: 'tiktok-creator-1',
                unique_id: 'historytok',
                nickname: 'History Tok',
                follower_count: 88000,
                signature: 'History videos. Contact collab@history.example',
              },
              statistics: { play_count: 45000 },
            },
          ],
        })
      }
      if (url.pathname === '/v1/google/search') {
        const query = url.searchParams.get('query') || ''
        return Response.json({
          success: true,
          credits_remaining: credits,
          credits_charged: 1,
          results: [
            {
              url: 'https://x.com/historythreads/status/123',
              title: 'History Threads',
              description: `${query} essays and documentaries`,
            },
          ],
        })
      }
      if (url.pathname === '/v1/tiktok/profile') {
        assert.equal(url.searchParams.get('cache_max_age'), '30d')
        return Response.json({
          success: true,
          credits_remaining: credits,
          credits_charged: 1,
          user: {
            id: 'tiktok-creator-1',
            uniqueId: 'historytok',
            nickname: 'History Tok',
            signature: 'History videos. Contact collab@history.example',
            avatarMedium: 'https://img.example/tiktok.jpg',
            language: 'en',
          },
          stats: { followerCount: 88000, videoCount: 410 },
        })
      }
      if (url.pathname === '/v1/twitter/profile') {
        assert.equal(url.searchParams.get('cache_max_age'), '30d')
        return Response.json({
          success: true,
          credits_remaining: credits,
          credits_charged: 1,
          rest_id: 'twitter-creator-1',
          legacy: {
            name: 'History Threads',
            screen_name: 'historythreads',
            description: 'Long-form history. Press: collab@history.example',
            followers_count: 64000,
            statuses_count: 900,
            profile_image_url_https: 'https://img.example/x.jpg',
            entities: {},
          },
        })
      }
      return new Response('Unexpected ScrapeCreators endpoint', { status: 404 })
    }
    if (slicedFixtureEnabled) {
      if (endpoint === 'search') return Response.json({ items: [] })
      if (endpoint === 'channels') {
        const ids = (url.searchParams.get('id') || '').split(',').filter(Boolean)
        return Response.json({
          items: ids.map((id) => ({
            id,
            snippet: { title: `Sliced creator ${id}`, description: '', defaultLanguage: 'en' },
            statistics: { subscriberCount: '1000', viewCount: '10000', videoCount: '10' },
            contentDetails: { relatedPlaylists: { uploads: `uploads-${id}` } },
          })),
        })
      }
      if (endpoint === 'playlistItems') {
        const creatorId = (url.searchParams.get('playlistId') || '').replace(/^uploads-/, '')
        return Response.json({ items: [{ snippet: { resourceId: { videoId: `video-${creatorId}` } } }] })
      }
      if (endpoint === 'videos') {
        const ids = (url.searchParams.get('id') || '').split(',').filter(Boolean)
        return Response.json({
          items: ids.map((id) => ({
            id,
            snippet: {
              channelId: id.replace(/^video-/, ''),
              title: 'Slice Reference coverage',
              description: '',
              publishedAt: '2026-07-30T12:00:00Z',
            },
            statistics: { viewCount: '1000' },
          })),
        })
      }
    }
    if (rejectForExternalQuota) {
      return new Response(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }
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
              description: `Contact hello@overlap.example ${'historical gameplay analysis '.repeat(250)}`,
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
    let caller = appRouter.createCaller({ db: database.db, secrets })
    const game = await caller.games.create({ name: 'Discovery Test' })
    const projectFiles = path.join(dir, 'project-files')
    const workspace = new MarkdownWorkspaceCoordinator(new DrizzleWorkspaceRepository(database.db))
    await workspace.configure({
      gameId: game.id,
      rootPath: projectFiles,
      workspaceFolder: 'MarCat',
      enabled: true,
    })
    let discoveryWakeCount = 0
    let promotionWakeCount = 0
    caller = appRouter.createCaller({
      db: database.db,
      secrets,
      workspace,
      wakeCreatorDiscovery: () => {
        discoveryWakeCount += 1
      },
      wakeCreatorPromotion: () => {
        promotionWakeCount += 1
      },
    })
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
    assert.equal(discoveryWakeCount, 1, 'a newly queued run must wake the isolated discovery worker')
    const duplicate = await caller.creatorDiscovery.start({ profileId: profile.id, forceNew: false })
    assert.equal(discoveryWakeCount, 1, 'an already active run must not emit a redundant wake signal')
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.run.id, first.run.id)
    assert.equal((await caller.creators.list()).length, 0, 'discovery must not write directly to production CRM')

    await processYouTubeDiscoveryQueue(database.db, secrets)
    const youtubeRequestColumns = await database.client.execute('PRAGMA table_info(youtube_api_requests)')
    assert.equal(
      youtubeRequestColumns.rows.some((column) => ['response_json', 'cache_expires_at'].includes(column.name)),
      false,
      'raw YouTube responses must not have durable storage columns',
    )
    const completedRequestRows = await database.client.execute(
      "SELECT count(*) AS count FROM youtube_api_requests WHERE status = 'succeeded'",
    )
    assert.equal(Number(completedRequestRows.rows[0].count), 0, 'completed YouTube request ledgers must be transient')
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
    const archiveResult = await syncYouTubeDiscoveryRunArchive(database.db, workspace, first.run.id)
    assert.equal(archiveResult.changed, true)
    const archivePath = path.join(projectFiles, 'MarCat', 'Discovery', 'Creators', `${first.run.id}.json`)
    const archivedSearch = JSON.parse(fs.readFileSync(archivePath, 'utf8'))
    assert.equal(archivedSearch.kind, 'creator-discovery-run')
    assert.equal(archivedSearch.profileSnapshot.name, 'Reference overlap')
    assert.equal(archivedSearch.results.length, 1)
    assert.equal(archivedSearch.results[0].result.fitScore, staged[0].result.fitScore)
    assert.equal(archivedSearch.results[0].contacts[0].value, 'hello@overlap.example')
    assert.equal(archivedSearch.results[0].evidence.length, 2)
    assert.deepEqual(await caller.creatorDiscovery.archiveLocation({ gameId: game.id }), {
      available: true,
      path: path.dirname(archivePath),
    })
    assert.equal(
      (
        await caller.creatorDiscovery.candidates({
          runId: first.run.id,
          status: 'staged',
          minFit: 0,
          minReferenceMatches: 3,
          limit: 50,
        })
      ).length,
      0,
      'matched-reference count must be filterable independently from composite fit',
    )
    const manualCreator = await caller.creators.create({
      name: 'Manual relationship owner',
      handle: 'https://youtube.com/@overlaplab',
      kind: 'journalist',
      primaryPlatform: 'youtube',
      channelsJson: JSON.stringify([
        {
          platform: 'youtube',
          url: 'https://youtube.com/@overlaplab',
          handle: '@overlaplab',
          subscribers: 1,
          customNote: 'Keep this channel note',
        },
      ]),
      audience: 1,
      contactsJson: JSON.stringify([
        {
          type: 'business_email',
          value: 'hello@overlap.example',
          source: 'manual',
          verified: true,
        },
        { type: 'manager', value: 'owner@overlap.example', source: 'manual', verified: true },
      ]),
      playedGamesJson: JSON.stringify(['Manual Game']),
      costUsd: 777,
      doNotContact: true,
      notes: 'Do not overwrite this note',
      description: 'Hand-written description',
      language: 'fr',
      region: 'CA',
    })
    await caller.creators.pick({ gameId: game.id, creatorId: manualCreator.id, addedBy: 'manual' })
    await caller.creators.setStatus({
      gameId: game.id,
      creatorId: manualCreator.id,
      pipelineStatus: 'replied',
      agreedCostUsd: 555,
    })
    await caller.creators.logTouch({
      gameId: game.id,
      creatorId: manualCreator.id,
      direction: 'inbound',
      channel: 'email',
      summary: 'Existing correspondence',
      body: 'This must survive discovery promotion.',
      requestId: 'youtube-discovery-safe-merge-touch',
    })
    const emailOnly = await caller.creatorDiscovery.candidates({
      runId: first.run.id,
      status: 'staged',
      minFit: 0,
      requireBusinessEmail: true,
      limit: 50,
    })
    assert.equal(emailOnly.length, 1)
    const batchPreview = await caller.creatorDiscovery.reviewPreview({
      runId: first.run.id,
      minFit: 0,
      minReferenceMatches: 1,
      requireBusinessEmail: true,
      batchLimit: 500,
    })
    assert.deepEqual(batchPreview, {
      total: 1,
      nextBatchSize: 1,
      nextBatchCreated: 0,
      nextBatchUpdated: 1,
      minFit: 0,
      minReferenceMatches: 1,
      requireBusinessEmail: true,
    })

    const quotaBeforeReplay = await caller.creatorDiscovery.quota()
    assert.equal(quotaBeforeReplay.youtube.search.used, 2)
    assert.equal(quotaBeforeReplay.youtube.data.used, 3)
    assert.equal(networkCalls, 5)

    const freshDuplicate = await caller.creatorDiscovery.start({ profileId: profile.id, forceNew: false })
    assert.equal(freshDuplicate.run.id, first.run.id)
    const forced = await caller.creatorDiscovery.start({ profileId: profile.id, forceNew: true })
    assert.notEqual(forced.run.id, first.run.id)
    await processYouTubeDiscoveryQueue(database.db, secrets)
    assert.equal(
      networkCalls,
      10,
      'a new run must fetch fresh YouTube data instead of reading raw payloads from SQLite',
    )
    const quotaAfterReplay = await caller.creatorDiscovery.quota()
    assert.equal(quotaAfterReplay.youtube.search.used, 4)
    assert.equal(quotaAfterReplay.youtube.data.used, 6)
    await database.client.execute({
      sql: "UPDATE creator_discovery_runs SET status = 'waiting_for_quota', phase = 'waiting_for_quota', heartbeat_at = ? WHERE id = ?",
      args: ['2020-01-01T00:00:00.000Z', forced.run.id],
    })
    await processYouTubeDiscoveryQueue(database.db, secrets)
    assert.equal((await caller.creatorDiscovery.getRun({ id: forced.run.id })).status, 'completed')
    assert.equal(networkCalls, 10, 'a completed YouTube phase must not be repeated when a later run phase resumes')

    slicedFixtureEnabled = true
    const slicedProfile = await caller.creatorDiscovery.createProfile({
      gameId: game.id,
      name: 'Bounded native worker fixture',
      mode: 'topic',
      languages: ['en'],
      includeTerms: [],
      excludeTerms: [],
      seedChannels: Array.from({ length: 3 }, (_, index) => `UC${String(index).padStart(22, '0')}`),
      maxSearchRequests: 1,
      maxChannels: 10,
      recentVideoLimit: 10,
      discoverContacts: false,
      references: [{ label: 'Slice Reference', aliases: [], queryTerms: ['Slice Reference'], weight: 1 }],
    })
    const slicedRun = await caller.creatorDiscovery.start({ profileId: slicedProfile.id, forceNew: true })
    await processYouTubeDiscoveryQueue(database.db, secrets, { maxYoutubeChannelsPerInvocation: 1 })
    const firstSlice = await caller.creatorDiscovery.getRun({ id: slicedRun.run.id })
    assert.equal(firstSlice.status, 'queued')
    assert.equal(firstSlice.channelsScanned, 1)
    const durableSliceQueue = await database.client.execute({
      sql: 'SELECT status, count(*) AS count FROM creator_discovery_run_channels WHERE run_id = ? GROUP BY status',
      args: [slicedRun.run.id],
    })
    assert.deepEqual(
      Object.fromEntries(durableSliceQueue.rows.map((row) => [row.status, Number(row.count)])),
      { queued: 2, scanned: 1 },
      'only parsed channel ids and their progress should survive between worker slices',
    )
    await processYouTubeDiscoveryQueue(database.db, secrets, { maxYoutubeChannelsPerInvocation: 1 })
    assert.equal((await caller.creatorDiscovery.getRun({ id: slicedRun.run.id })).channelsScanned, 2)
    await processYouTubeDiscoveryQueue(database.db, secrets, { maxYoutubeChannelsPerInvocation: 1 })
    const completedSlices = await caller.creatorDiscovery.getRun({ id: slicedRun.run.id })
    assert.equal(completedSlices.status, 'completed')
    assert.equal(completedSlices.channelsScanned, 3)
    assert.equal(completedSlices.candidatesStaged, 3)
    assert.equal(
      Number(
        (
          await database.client.execute({
            sql: 'SELECT count(*) AS count FROM creator_discovery_run_channels WHERE run_id = ?',
            args: [slicedRun.run.id],
          })
        ).rows[0].count,
      ),
      0,
      'temporary normalized queues must be removed after completion',
    )
    slicedFixtureEnabled = false

    const uncertainTimestamp = new Date().toISOString()
    await database.client.execute({
      sql: `INSERT INTO youtube_api_requests
        (id, last_run_id, key_fingerprint, endpoint, request_hash, status, quota_bucket, quota_cost, quota_date, error, requested_at, updated_at, created_at)
        VALUES (?, ?, ?, 'search', ?, 'uncertain', 'search', 1, '2026-07-31', 'fixture', ?, ?, ?)`,
      args: [
        'uncertain-request-fixture',
        first.run.id,
        createHash('sha256').update(apiKey).digest('hex').slice(0, 16),
        'fixture-hash',
        uncertainTimestamp,
        uncertainTimestamp,
        uncertainTimestamp,
      ],
    })
    await database.client.execute({
      sql: "UPDATE creator_discovery_runs SET status = 'partial', phase = 'partial', error = ? WHERE id = ?",
      args: ['A stale identical YouTube request may have consumed quota; not retrying automatically', forced.run.id],
    })
    const partialRun = await caller.creatorDiscovery.getRun({ id: forced.run.id })
    assert.deepEqual(partialRun.issue, {
      code: 'request_uncertain',
      recovery: 'retry',
      operation: 'search_results',
    })
    assert.deepEqual(youtubeDiscoveryRunIssue('failed', 'YouTube API 403: API key not valid'), {
      code: 'youtube_setup',
      recovery: 'settings',
    })
    await caller.creatorDiscovery.resume({ id: forced.run.id })
    const retryableRequest = await database.client.execute({
      sql: "SELECT status FROM youtube_api_requests WHERE status = 'failed' AND error = 'Retry approved by user' LIMIT 1",
      args: [],
    })
    assert.equal(retryableRequest.rows[0].status, 'failed')
    await processYouTubeDiscoveryQueue(database.db, secrets)
    assert.equal((await caller.creatorDiscovery.getRun({ id: forced.run.id })).status, 'completed')

    const quotaProfile = await caller.creatorDiscovery.createProfile({
      gameId: game.id,
      name: 'External quota recovery',
      mode: 'topic',
      languages: ['en'],
      includeTerms: [],
      excludeTerms: [],
      seedChannels: [],
      maxSearchRequests: 1,
      maxChannels: 10,
      recentVideoLimit: 10,
      discoverContacts: false,
      references: [{ label: 'Quota Sentinel', aliases: [], queryTerms: ['unique quota sentinel query'], weight: 1 }],
    })
    const quotaRun = await caller.creatorDiscovery.start({ profileId: quotaProfile.id, forceNew: true })
    rejectForExternalQuota = true
    await processYouTubeDiscoveryQueue(database.db, secrets)
    rejectForExternalQuota = false
    const waitingForExternalQuota = await caller.creatorDiscovery.getRun({ id: quotaRun.run.id })
    assert.equal(waitingForExternalQuota.status, 'waiting_for_quota')
    assert.deepEqual(waitingForExternalQuota.issue, { code: 'quota_wait', recovery: 'automatic' })

    const dismissedBatch = await caller.creatorDiscovery.reviewBulk({
      runId: forced.run.id,
      decision: 'dismiss',
      minFit: 0,
      requireBusinessEmail: false,
      limit: 50,
    })
    assert.equal(dismissedBatch.processed, 1)
    const dismissedCandidates = await caller.creatorDiscovery.candidates({
      runId: forced.run.id,
      status: 'dismissed',
      minFit: 0,
      requireBusinessEmail: false,
      limit: 50,
    })
    assert.equal(dismissedCandidates.length, 1)
    const restoredBatch = await caller.creatorDiscovery.reviewBulk({
      runId: forced.run.id,
      decision: 'restore',
      candidateIds: [dismissedCandidates[0].candidate.id],
      minFit: 0,
      minReferenceMatches: 1,
      requireBusinessEmail: false,
      limit: 50,
    })
    assert.equal(restoredBatch.processed, 1)
    assert.equal(
      (
        await caller.creatorDiscovery.candidates({
          runId: forced.run.id,
          status: 'staged',
          minFit: 0,
          requireBusinessEmail: false,
          limit: 50,
        })
      ).length,
      1,
      'hidden historical results must be restorable for a later wave',
    )

    const promotedBatch = await caller.creatorDiscovery.reviewBulk({
      runId: first.run.id,
      decision: 'promote',
      candidateIds: [staged[0].candidate.id],
      minFit: 0,
      minReferenceMatches: 1,
      requireBusinessEmail: false,
      limit: 50,
    })
    assert.equal(promotedBatch.queued, true)
    assert.equal(promotionWakeCount, 1, 'a queued bulk promotion must wake its isolated worker')
    assert.equal(promotedBatch.processed, 0)
    const duplicatePromotion = await caller.creatorDiscovery.reviewBulk({
      runId: first.run.id,
      decision: 'promote',
      candidateIds: [staged[0].candidate.id],
      minFit: 0,
      minReferenceMatches: 1,
      requireBusinessEmail: false,
      limit: 50,
    })
    assert.equal(duplicatePromotion.duplicate, true)
    assert.equal(duplicatePromotion.operation.id, promotedBatch.operation.id)
    await database.client.batch([
      {
        sql: "UPDATE background_operation_items SET status = 'failed', error = 'synthetic retry test' WHERE operation_id = ?",
        args: [promotedBatch.operation.id],
      },
      {
        sql: "UPDATE background_operations SET status = 'failed', processed = 1, failed = 1 WHERE id = ?",
        args: [promotedBatch.operation.id],
      },
    ])
    const wakesBeforeRetry = promotionWakeCount
    const retriedPromotion = await caller.creatorDiscovery.retryPromotion({ id: promotedBatch.operation.id })
    assert.equal(
      promotionWakeCount,
      wakesBeforeRetry + 1,
      'a retried bulk promotion must wake its isolated worker again',
    )
    assert.equal(retriedPromotion.status, 'queued')
    assert.equal(retriedPromotion.processed, 0)
    assert.equal(retriedPromotion.failed, 0)
    const processedPromotion = await processCreatorPromotionQueue(database.db)
    assert.equal(processedPromotion.operation.id, promotedBatch.operation.id)
    assert.equal(processedPromotion.operation.processed, 1)
    assert.equal(processedPromotion.operation.createdCount, 0)
    assert.equal(processedPromotion.operation.updatedCount, 1)
    const promotedRows = await caller.creatorDiscovery.candidates({
      runId: first.run.id,
      status: 'promoted',
      minFit: 0,
      requireBusinessEmail: false,
      limit: 50,
    })
    const promoted = promotedRows.find(({ candidate }) => candidate.id === staged[0].candidate.id).result
    assert.equal(promoted.creatorId, manualCreator.id, 'vanity URL must deduplicate against a discovered channel ID')
    const promotedAgain = await caller.creatorDiscovery.promote({
      runId: first.run.id,
      candidateId: staged[0].candidate.id,
    })
    assert.equal(promotedAgain.creatorId, promoted.creatorId)
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    assert.equal(
      JSON.parse(fs.readFileSync(archivePath, 'utf8')).results[0].result.status,
      'promoted',
      'project archive must follow review decisions',
    )
    const creators = await caller.creators.list()
    assert.equal(creators.length, 1)
    assert.equal(creators[0].youtubeChannelId, channelId)
    assert.equal(creators[0].name, 'Manual relationship owner')
    assert.equal(creators[0].handle, 'https://youtube.com/@overlaplab')
    assert.equal(creators[0].kind, 'journalist')
    assert.equal(creators[0].description, 'Hand-written description')
    assert.equal(creators[0].notes, 'Do not overwrite this note')
    assert.equal(creators[0].costUsd, 777)
    assert.equal(creators[0].doNotContact, true)
    assert.equal(creators[0].language, 'fr')
    assert.equal(creators[0].region, 'CA')
    assert.equal(creators[0].source, 'manual')
    assert.equal(creators[0].audience, 1, 'a manually entered aggregate metric must not be overwritten')
    const mergedContacts = JSON.parse(creators[0].contactsJson)
    assert.equal(mergedContacts.filter((contact) => contact.value === 'hello@overlap.example').length, 1)
    assert.equal(mergedContacts.find((contact) => contact.value === 'hello@overlap.example').verified, true)
    assert.ok(mergedContacts.some((contact) => contact.value === 'owner@overlap.example'))
    assert.deepEqual(JSON.parse(creators[0].playedGamesJson), ['Manual Game', 'Alpha Game', 'Beta Quest'])
    const mergedYoutubeChannel = JSON.parse(creators[0].channelsJson).find((channel) => channel.platform === 'youtube')
    assert.equal(mergedYoutubeChannel.customNote, 'Keep this channel note')
    assert.equal(mergedYoutubeChannel.url, 'https://youtube.com/@overlaplab')
    assert.equal(mergedYoutubeChannel.subscribers, 42000)
    const picks = await caller.creators.picks({ gameId: game.id })
    assert.equal(picks.length, 1)
    assert.equal(picks[0].pipelineStatus, 'replied')
    assert.equal(picks[0].agreedCostUsd, 555)
    assert.equal(picks[0].addedBy, 'manual')
    const touches = await caller.creators.touches({ gameId: game.id, creatorId: manualCreator.id })
    assert.equal(touches.length, 1)
    assert.equal(touches[0].summary, 'Existing correspondence')
    const promotedEvidence = await caller.creatorDiscovery.promotedEvidence({
      gameId: game.id,
      creatorId: promoted.creatorId,
      limit: 5,
    })
    assert.equal(promotedEvidence.length, 1)
    assert.deepEqual(promotedEvidence[0].matchedReferences, ['Alpha Game', 'Beta Quest'])
    assert.equal(promotedEvidence[0].evidence.length, 2)

    await database.client.batch([
      {
        sql: 'UPDATE creators SET data_expires_at = ? WHERE id = ?',
        args: ['2020-01-01T00:00:00.000Z', manualCreator.id],
      },
      {
        sql: 'UPDATE creator_discovery_candidates SET expires_at = ? WHERE id = ?',
        args: ['2020-01-01T00:00:00.000Z', staged[0].candidate.id],
      },
    ])
    await expireYoutubeDiscoveryCache(database.db)
    const creatorAfterExpiry = await caller.creators.get({ id: manualCreator.id })
    assert.equal(creatorAfterExpiry.name, 'Manual relationship owner')
    assert.equal(creatorAfterExpiry.description, 'Hand-written description')
    assert.equal(creatorAfterExpiry.notes, 'Do not overwrite this note')
    assert.equal(creatorAfterExpiry.audience, 1)
    assert.deepEqual(JSON.parse(creatorAfterExpiry.playedGamesJson), ['Manual Game', 'Alpha Game', 'Beta Quest'])
    const channelAfterExpiry = JSON.parse(creatorAfterExpiry.channelsJson).find(
      (channel) => channel.platform === 'youtube',
    )
    assert.equal(channelAfterExpiry.customNote, 'Keep this channel note')
    assert.equal(channelAfterExpiry.url, 'https://youtube.com/@overlaplab')
    assert.equal(channelAfterExpiry.subscribers, undefined)
    assert.equal((await caller.creators.touches({ gameId: game.id, creatorId: manualCreator.id })).length, 1)
    const retainedHistory = await caller.creatorDiscovery.candidates({
      runId: first.run.id,
      status: 'promoted',
      minFit: 0,
      minReferenceMatches: 1,
      requireBusinessEmail: true,
      limit: 50,
    })
    assert.equal(retainedHistory.length, 1, 'expired API freshness must not delete historical search results')
    assert.equal(retainedHistory[0].evidence.length, 2)
    assert.equal(retainedHistory[0].contacts[0].value, 'hello@overlap.example')
    const profileHistory = await caller.creatorDiscovery.runs({
      gameId: game.id,
      profileId: profile.id,
      limit: 5_000,
    })
    assert.ok(profileHistory.length >= 2)
    assert.equal(profileHistory.find((run) => run.id === first.run.id).resultCounts.promoted, 1)

    youtubeEnabled = false
    socialEnabled = true
    const socialProfile = await caller.creatorDiscovery.createProfile({
      gameId: game.id,
      name: 'Social history creators',
      mode: 'topic',
      languages: ['en'],
      includeTerms: [],
      excludeTerms: [],
      seedChannels: [],
      maxSearchRequests: 2,
      maxChannels: 50,
      recentVideoLimit: 10,
      discoverContacts: true,
      references: [
        { label: 'Ancient Rome', aliases: ['Roman history'], queryTerms: ['Ancient Rome'], weight: 1 },
        { label: 'Medieval warfare', aliases: ['medieval battles'], queryTerms: ['Medieval warfare'], weight: 1 },
      ],
    })
    const socialRun = await caller.creatorDiscovery.start({ profileId: socialProfile.id, forceNew: false })
    assert.deepEqual(JSON.parse(socialRun.run.profileSnapshotJson).platforms, ['instagram', 'tiktok', 'twitter'])
    await processYouTubeDiscoveryQueue(database.db, secrets)
    const completedSocial = await caller.creatorDiscovery.getRun({ id: socialRun.run.id })
    assert.equal(completedSocial.status, 'completed')
    const socialCandidates = await caller.creatorDiscovery.candidates({
      runId: socialRun.run.id,
      status: 'staged',
      minFit: 0,
      minReferenceMatches: 2,
      requireBusinessEmail: true,
      limit: 50,
    })
    assert.deepEqual(socialCandidates.map(({ candidate }) => candidate.platform).sort(), [
      'instagram',
      'tiktok',
      'twitter',
    ])
    assert.ok(socialCandidates.every(({ contacts }) => contacts.some((contact) => contact.type === 'business_email')))
    const socialPromotionPreview = await caller.creatorDiscovery.reviewPreview({
      runId: socialRun.run.id,
      minFit: 0,
      minReferenceMatches: 2,
      requireBusinessEmail: true,
      batchLimit: 50,
    })
    assert.equal(socialPromotionPreview.nextBatchCreated, 1)
    assert.equal(socialPromotionPreview.nextBatchUpdated, 2)
    const socialStatus = await caller.creatorDiscovery.quota()
    assert.equal(socialStatus.social.configured, true)
    assert.equal(socialStatus.social.creditsRemaining, 100 - socialApiCalls)

    const instagramOnly = await caller.creatorDiscovery.start({
      profileId: socialProfile.id,
      forceNew: true,
      platforms: ['instagram'],
    })
    assert.deepEqual(JSON.parse(instagramOnly.run.profileSnapshotJson).platforms, ['instagram'])
    await processYouTubeDiscoveryQueue(database.db, secrets)
    const instagramOnlyCandidates = await caller.creatorDiscovery.candidates({
      runId: instagramOnly.run.id,
      status: 'staged',
      minFit: 0,
      limit: 50,
    })
    assert.ok(instagramOnlyCandidates.length > 0)
    assert.ok(instagramOnlyCandidates.every(({ candidate }) => candidate.platform === 'instagram'))

    const paidCallsBeforeRepeat = socialApiCalls
    const repeatedSocial = await caller.creatorDiscovery.start({ profileId: socialProfile.id, forceNew: true })
    await processYouTubeDiscoveryQueue(database.db, secrets)
    assert.equal((await caller.creatorDiscovery.getRun({ id: repeatedSocial.run.id })).status, 'completed')
    assert.equal(
      socialApiCalls,
      paidCallsBeforeRepeat,
      'identical social API calls must be served from the durable cache',
    )

    const promotedSocial = await caller.creatorDiscovery.promote({
      runId: socialRun.run.id,
      candidateId: socialCandidates.find(({ candidate }) => candidate.platform === 'tiktok').candidate.id,
    })
    const promotedSocialCard = (await caller.creators.list()).find((creator) => creator.id === promotedSocial.creatorId)
    assert.equal(promotedSocialCard.primaryPlatform, 'tiktok')
    assert.equal(promotedSocialCard.kind, 'tiktoker')
    assert.ok(JSON.parse(promotedSocialCard.contactsJson).some((contact) => contact.value === 'collab@history.example'))
    const promotedInstagram = await caller.creatorDiscovery.promote({
      runId: socialRun.run.id,
      candidateId: socialCandidates.find(({ candidate }) => candidate.platform === 'instagram').candidate.id,
    })
    assert.equal(promotedInstagram.created, false)
    assert.equal(promotedInstagram.creatorId, promotedSocial.creatorId)
    const mergedSocialCard = (await caller.creators.list()).find((creator) => creator.id === promotedSocial.creatorId)
    assert.deepEqual(
      JSON.parse(mergedSocialCard.channelsJson)
        .map((channel) => channel.platform)
        .sort(),
      ['instagram', 'tiktok'],
    )

    const mcpStyleCaller = appRouter.createCaller({ db: database.db })
    const mcpAutoProfile = await mcpStyleCaller.creatorDiscovery.createProfile({
      gameId: game.id,
      name: 'MCP auto sources',
      mode: 'topic',
      languages: ['en'],
      includeTerms: [],
      excludeTerms: [],
      seedChannels: [],
      maxSearchRequests: 1,
      maxChannels: 20,
      recentVideoLimit: 10,
      discoverContacts: true,
      references: [{ label: 'Ancient Rome', aliases: [], queryTerms: ['Ancient Rome'], weight: 1 }],
    })
    const mcpQueued = await mcpStyleCaller.creatorDiscovery.start({
      profileId: mcpAutoProfile.id,
      forceNew: false,
      platforms: ['instagram', 'tiktok'],
    })
    assert.deepEqual(JSON.parse(mcpQueued.run.profileSnapshotJson).platforms, ['instagram', 'tiktok'])
    await processYouTubeDiscoveryQueue(database.db, secrets)
    const mcpCompleted = await mcpStyleCaller.creatorDiscovery.getRun({ id: mcpQueued.run.id })
    assert.equal(mcpCompleted.status, 'completed')
    assert.deepEqual(mcpCompleted.profileSnapshot.platforms, ['instagram', 'tiktok'])
    const mcpDuplicate = await mcpStyleCaller.creatorDiscovery.start({
      profileId: mcpAutoProfile.id,
      forceNew: false,
      platforms: ['instagram', 'tiktok'],
    })
    assert.equal(mcpDuplicate.run.id, mcpQueued.run.id)

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

    const recoveryRun = await mcpStyleCaller.creatorDiscovery.start({
      profileId: mcpAutoProfile.id,
      forceNew: true,
      platforms: ['youtube'],
    })
    await database.client.execute({
      sql: "UPDATE creator_discovery_runs SET status = 'running', phase = 'scanning_channels' WHERE id = ?",
      args: [recoveryRun.run.id],
    })
    assert.deepEqual(await recoverInterruptedDiscoveryRuns(database.db), { requeued: 1, partial: 0 })
    assert.equal((await caller.creatorDiscovery.getRun({ id: recoveryRun.run.id })).status, 'queued')
    await database.client.batch([
      {
        sql: "UPDATE creator_discovery_runs SET status = 'running', phase = 'scanning_channels' WHERE id = ?",
        args: [recoveryRun.run.id],
      },
      {
        sql: "UPDATE youtube_api_requests SET status = 'running', last_run_id = ? WHERE id = (SELECT id FROM youtube_api_requests LIMIT 1)",
        args: [recoveryRun.run.id],
      },
    ])
    assert.deepEqual(await recoverInterruptedDiscoveryRuns(database.db), { requeued: 0, partial: 1 })
    assert.equal((await caller.creatorDiscovery.getRun({ id: recoveryRun.run.id })).status, 'partial')

    console.log(
      'CREATOR DISCOVERY OK (YouTube + Instagram + TikTok + X + durable archive + historical waves + safe recovery + reference filters + merge-safe promotion + contacts + quota/credits + paid-request dedupe + AI-managed run)',
    )
  } finally {
    global.fetch = originalFetch
    if (process.platform === 'win32') {
      // Closing a heavily-used local libSQL client can itself trigger the native
      // Windows shutdown race this suite is exercising. Let process teardown own
      // the handle and remove the fixture from a clean helper process afterwards.
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
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('YOUTUBE DISCOVERY FAIL', error)
    process.exit(1)
  },
)
