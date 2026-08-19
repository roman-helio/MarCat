import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import {
  backgroundOperationItems,
  backgroundOperations,
  creatorDiscoveryCandidates,
  creatorDiscoveryApiRequests,
  creatorDiscoveryContacts,
  creatorDiscoveryEvidence,
  creatorDiscoveryProfiles,
  creatorDiscoveryReferences,
  creatorDiscoveryRunChannels,
  creatorDiscoveryRunCandidates,
  creatorDiscoveryRuns,
  creatorDiscoveryRunSearches,
  youtubeApiRequests,
} from '@marcat/db'
import { z } from 'zod'
import { publicProcedure, router } from '../trpc'
import {
  hashDiscoveryProfile,
  creatorDiscoveryProviderStatus,
  previewDiscoveryPromotions,
  promoteDiscoveryCandidate,
  syncYouTubeDiscoveryRunArchive,
  youtubeDiscoveryRequestOperation,
  youtubeDiscoveryRunIssue,
  youtubeKeyFingerprint,
  youtubeQuotaStatus,
  type DiscoveryProfileSnapshot,
  type DiscoveryPlatform,
} from '../youtubeDiscovery'
import { cancelCreatorPromotion, queueCreatorPromotion, retryCreatorPromotion } from '../creatorPromotion'

const stringList = z.array(z.string().trim().min(1)).max(100).default([])
const discoveryPlatform = z.enum(['youtube', 'instagram', 'tiktok', 'twitter'])
const referenceInput = z.object({
  label: z.string().trim().min(1).max(160),
  aliases: stringList,
  queryTerms: stringList,
  weight: z.number().min(0.1).max(10).default(1),
})

const profileInput = z.object({
  gameId: z.string(),
  name: z.string().trim().min(1).max(160),
  mode: z.enum(['games', 'topic']).default('games'),
  languages: z.array(z.string().trim().min(2).max(12)).max(10).default([]),
  includeTerms: stringList,
  excludeTerms: stringList,
  seedChannels: z.array(z.string().trim().min(1)).max(200).default([]),
  maxSearchRequests: z.number().int().min(1).max(100).default(10),
  maxChannels: z.number().int().min(10).max(5_000).default(500),
  recentVideoLimit: z.number().int().min(10).max(100).default(50),
  discoverContacts: z.boolean().default(true),
  references: z.array(referenceInput).min(1).max(100),
})

function parseArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.map(String) : []
  } catch {
    return []
  }
}

async function profileWithReferences(ctx: { db: Parameters<typeof youtubeQuotaStatus>[0] }, profileId: string) {
  const profile = (
    await ctx.db.select().from(creatorDiscoveryProfiles).where(eq(creatorDiscoveryProfiles.id, profileId)).limit(1)
  )[0]
  if (!profile) return null
  const references = await ctx.db
    .select()
    .from(creatorDiscoveryReferences)
    .where(eq(creatorDiscoveryReferences.profileId, profileId))
    .orderBy(asc(creatorDiscoveryReferences.createdAt))
  return {
    ...profile,
    languages: parseArray(profile.languagesJson),
    includeTerms: parseArray(profile.includeTermsJson),
    excludeTerms: parseArray(profile.excludeTermsJson),
    seedChannels: parseArray(profile.seedChannelsJson),
    references: references.map((reference) => ({
      ...reference,
      aliases: parseArray(reference.aliasesJson),
      queryTerms: parseArray(reference.queryTermsJson),
    })),
  }
}

function toSnapshot(
  profile: NonNullable<Awaited<ReturnType<typeof profileWithReferences>>>,
  platforms: DiscoveryPlatform[],
): DiscoveryProfileSnapshot {
  return {
    profileId: profile.id,
    gameId: profile.gameId,
    name: profile.name,
    mode: profile.mode,
    languages: profile.languages,
    includeTerms: profile.includeTerms,
    excludeTerms: profile.excludeTerms,
    seedChannels: profile.seedChannels,
    maxSearchRequests: profile.maxSearchRequests,
    maxChannels: profile.maxChannels,
    recentVideoLimit: profile.recentVideoLimit,
    discoverContacts: profile.discoverContacts,
    platforms,
    references: profile.references.map((reference) => ({
      id: reference.id,
      label: reference.label,
      aliases: reference.aliases,
      queryTerms: reference.queryTerms,
      weight: reference.weight,
    })),
  }
}

type CandidateSelection = {
  runId: string
  candidateIds?: string[]
  minFit: number
  minReferenceMatches: number
  requireBusinessEmail: boolean
  limit: number
}

async function businessEmailCandidateIds(
  ctx: { db: Parameters<typeof youtubeQuotaStatus>[0] },
  runId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ candidateId: creatorDiscoveryContacts.candidateId })
    .from(creatorDiscoveryContacts)
    .where(and(eq(creatorDiscoveryContacts.runId, runId), eq(creatorDiscoveryContacts.type, 'business_email')))
  return [...new Set(rows.map((row) => row.candidateId))]
}

async function selectCandidateIds(
  ctx: { db: Parameters<typeof youtubeQuotaStatus>[0] },
  input: CandidateSelection,
  status: (typeof creatorDiscoveryRunCandidates.$inferSelect)['status'],
): Promise<string[]> {
  const filters = [
    eq(creatorDiscoveryRunCandidates.runId, input.runId),
    eq(creatorDiscoveryRunCandidates.status, status),
    gte(creatorDiscoveryRunCandidates.fitScore, input.minFit),
    gte(creatorDiscoveryRunCandidates.matchedReferenceCount, input.minReferenceMatches),
  ]
  if (input.candidateIds) filters.push(inArray(creatorDiscoveryRunCandidates.candidateId, input.candidateIds))
  if (input.requireBusinessEmail) {
    const withEmail = await businessEmailCandidateIds(ctx, input.runId)
    if (!withEmail.length) return []
    filters.push(inArray(creatorDiscoveryRunCandidates.candidateId, withEmail))
  }
  const rows = await ctx.db
    .select({ candidateId: creatorDiscoveryRunCandidates.candidateId })
    .from(creatorDiscoveryRunCandidates)
    .where(and(...filters))
    .orderBy(desc(creatorDiscoveryRunCandidates.fitScore), desc(creatorDiscoveryRunCandidates.matchedReferenceCount))
    .limit(input.limit)
  return rows.map((row) => row.candidateId)
}

async function runsWithIssues(
  ctx: {
    db: Parameters<typeof youtubeQuotaStatus>[0]
    secrets?: { getApiKey(provider: string): string | undefined }
  },
  runs: Array<typeof creatorDiscoveryRuns.$inferSelect>,
) {
  const resultRows: Array<{
    runId: string
    status: (typeof creatorDiscoveryRunCandidates.$inferSelect)['status']
    count: number
  }> = []
  const runIds = runs.map((run) => run.id)
  for (let offset = 0; offset < runIds.length; offset += 500) {
    resultRows.push(
      ...(await ctx.db
        .select({
          runId: creatorDiscoveryRunCandidates.runId,
          status: creatorDiscoveryRunCandidates.status,
          count: sql<number>`count(*)`,
        })
        .from(creatorDiscoveryRunCandidates)
        .where(inArray(creatorDiscoveryRunCandidates.runId, runIds.slice(offset, offset + 500)))
        .groupBy(creatorDiscoveryRunCandidates.runId, creatorDiscoveryRunCandidates.status)),
    )
  }
  const counts = new Map<string, { total: number; staged: number; promoted: number; dismissed: number }>()
  for (const result of resultRows) {
    const current = counts.get(result.runId) ?? { total: 0, staged: 0, promoted: 0, dismissed: 0 }
    current.total += result.count
    current[result.status] += result.count
    counts.set(result.runId, current)
  }
  const enriched = runs.map((run) => ({
    ...run,
    resultCounts: counts.get(run.id) ?? { total: 0, staged: 0, promoted: 0, dismissed: 0 },
  }))
  if (!runs.some((run) => run.status === 'partial')) {
    return enriched.map((run) => ({ ...run, issue: youtubeDiscoveryRunIssue(run.status, run.error) }))
  }
  const socialPartialRunIds = new Set(
    runs
      .filter((run) => run.status === 'partial' && /Paid discovery request|ScrapeCreators/i.test(run.error ?? ''))
      .map((run) => run.id),
  )
  const apiKey = ctx.secrets?.getApiKey('youtube')
  const filters = [eq(youtubeApiRequests.status, 'uncertain')]
  if (apiKey) filters.push(eq(youtubeApiRequests.keyFingerprint, youtubeKeyFingerprint(apiKey)))
  const uncertainRequests = await ctx.db
    .select({ endpoint: youtubeApiRequests.endpoint, lastRunId: youtubeApiRequests.lastRunId })
    .from(youtubeApiRequests)
    .where(and(...filters))
    .orderBy(desc(youtubeApiRequests.updatedAt))
  return enriched.map((run) => {
    if (socialPartialRunIds.has(run.id)) {
      return { ...run, issue: youtubeDiscoveryRunIssue(run.status, run.error, 'social_request') }
    }
    const request = uncertainRequests.find((candidate) => candidate.lastRunId === run.id) ?? uncertainRequests[0]
    const operation = request ? youtubeDiscoveryRequestOperation(request.endpoint) : undefined
    return { ...run, issue: youtubeDiscoveryRunIssue(run.status, run.error, operation) }
  })
}

async function syncRunArchive(
  ctx: {
    db: Parameters<typeof youtubeQuotaStatus>[0]
    workspace?: Parameters<typeof syncYouTubeDiscoveryRunArchive>[1]
  },
  runId: string,
): Promise<void> {
  if (!ctx.workspace) return
  await syncYouTubeDiscoveryRunArchive(ctx.db, ctx.workspace, runId).catch(() => null)
}

type ArchiveContext = Parameters<typeof syncRunArchive>[0]
type ScheduledArchive = {
  ctx: ArchiveContext
  dirty: boolean
  syncing: boolean
  timer?: ReturnType<typeof setTimeout>
}

const scheduledArchives = new WeakMap<object, Map<string, ScheduledArchive>>()

/** Coalesce rapid one-by-one reviews into one bounded archive rebuild per run. */
function scheduleRunArchive(ctx: ArchiveContext, runId: string): void {
  if (!ctx.workspace) return
  let byRun = scheduledArchives.get(ctx.workspace)
  if (!byRun) {
    byRun = new Map()
    scheduledArchives.set(ctx.workspace, byRun)
  }
  const state = byRun.get(runId) ?? { ctx, dirty: false, syncing: false }
  state.ctx = ctx
  state.dirty = true
  byRun.set(runId, state)
  if (state.syncing) return
  clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = undefined
    state.syncing = true
    state.dirty = false
    void syncRunArchive(state.ctx, runId).finally(() => {
      state.syncing = false
      if (state.dirty) {
        scheduleRunArchive(state.ctx, runId)
      } else {
        byRun?.delete(runId)
      }
    })
  }, 2_000)
  state.timer.unref?.()
}

export const creatorDiscoveryRouter = router({
  profiles: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    const profiles = await ctx.db
      .select()
      .from(creatorDiscoveryProfiles)
      .where(eq(creatorDiscoveryProfiles.gameId, input.gameId))
      .orderBy(desc(creatorDiscoveryProfiles.updatedAt))
    return Promise.all(profiles.map((profile) => profileWithReferences(ctx, profile.id)))
  }),

  getProfile: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => profileWithReferences(ctx, input.id)),

  createProfile: publicProcedure.input(profileInput).mutation(({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(creatorDiscoveryProfiles)
        .values({
          gameId: input.gameId,
          name: input.name,
          mode: input.mode,
          languagesJson: JSON.stringify(input.languages),
          includeTermsJson: JSON.stringify(input.includeTerms),
          excludeTermsJson: JSON.stringify(input.excludeTerms),
          seedChannelsJson: JSON.stringify(input.seedChannels),
          maxSearchRequests: input.maxSearchRequests,
          maxChannels: input.maxChannels,
          recentVideoLimit: input.recentVideoLimit,
          discoverContacts: input.discoverContacts,
        })
        .returning({ id: creatorDiscoveryProfiles.id })
      const profileId = inserted[0]!.id
      await tx.insert(creatorDiscoveryReferences).values(
        input.references.map((reference) => ({
          profileId,
          label: reference.label,
          aliasesJson: JSON.stringify(reference.aliases),
          queryTermsJson: JSON.stringify(reference.queryTerms.length ? reference.queryTerms : [reference.label]),
          weight: reference.weight,
        })),
      )
      return { id: profileId }
    }),
  ),

  removeProfile: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const runs = await ctx.db
      .select({ id: creatorDiscoveryRuns.id })
      .from(creatorDiscoveryRuns)
      .where(eq(creatorDiscoveryRuns.profileId, input.id))
      .limit(1)
    if (runs.length) throw new Error('A profile with run artifacts cannot be deleted')
    await ctx.db.delete(creatorDiscoveryProfiles).where(eq(creatorDiscoveryProfiles.id, input.id))
    return { id: input.id }
  }),

  start: publicProcedure
    .input(
      z.object({
        profileId: z.string(),
        forceNew: z.boolean().default(false),
        platforms: z.array(discoveryPlatform).min(1).max(4).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const profile = await profileWithReferences(ctx, input.profileId)
      if (!profile) throw new Error('Discovery profile not found')
      const configuredPlatforms: DiscoveryPlatform[] = [
        ...(ctx.secrets?.getApiKey('youtube') ? (['youtube'] as const) : []),
        ...(ctx.secrets?.getApiKey('scrapecreators') ? (['instagram', 'tiktok', 'twitter'] as const) : []),
      ]
      if (ctx.secrets && !configuredPlatforms.length) {
        throw new Error('Connect YouTube or ScrapeCreators before starting creator discovery')
      }
      const requestedPlatforms = input.platforms ? ([...new Set(input.platforms)] as DiscoveryPlatform[]) : undefined
      if (ctx.secrets && requestedPlatforms) {
        const unavailable = requestedPlatforms.filter((platform) => !configuredPlatforms.includes(platform))
        if (unavailable.length) {
          throw new Error(`Connect the required creator discovery source: ${unavailable.join(', ')}`)
        }
      }
      // The standalone MCP server cannot read protected desktop keys. Preserve an
      // explicit selection for the desktop worker; [] keeps legacy auto-resolution.
      const platforms = requestedPlatforms ?? (ctx.secrets ? configuredPlatforms : [])
      const snapshot = toSnapshot(profile, platforms)
      const profileHash = hashDiscoveryProfile(snapshot)
      const profileRuns = await ctx.db
        .select()
        .from(creatorDiscoveryRuns)
        .where(eq(creatorDiscoveryRuns.profileId, profile.id))
        .orderBy(desc(creatorDiscoveryRuns.createdAt))
      const active =
        ctx.secrets || requestedPlatforms
          ? profileRuns.filter((run) => run.profileHash === profileHash)
          : profileRuns.filter((run) => {
              try {
                const historical = JSON.parse(run.profileSnapshotJson) as DiscoveryProfileSnapshot
                return hashDiscoveryProfile({ ...historical, platforms: [] }) === profileHash
              } catch {
                return false
              }
            })
      const activeDuplicate = active.find((run) =>
        ['queued', 'running', 'paused', 'waiting_for_quota'].includes(run.status),
      )
      if (activeDuplicate) {
        await syncRunArchive(ctx, activeDuplicate.id)
        return { run: activeDuplicate, duplicate: true, reason: 'active' as const }
      }
      const freshCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString()
      const freshCompleted = active.find(
        (run) => run.status === 'completed' && run.finishedAt && run.finishedAt >= freshCutoff,
      )
      if (freshCompleted && !input.forceNew) {
        await syncRunArchive(ctx, freshCompleted.id)
        return { run: freshCompleted, duplicate: true, reason: 'fresh' as const }
      }
      const rows = await ctx.db
        .insert(creatorDiscoveryRuns)
        .values({
          gameId: profile.gameId,
          profileId: profile.id,
          profileHash,
          profileSnapshotJson: JSON.stringify(snapshot),
        })
        .returning()
      ctx.wakeCreatorDiscovery?.()
      await syncRunArchive(ctx, rows[0]!.id)
      return { run: rows[0]!, duplicate: false, reason: null }
    }),

  runs: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        profileId: z.string().optional(),
        limit: z.number().int().min(1).max(5_000).default(500),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(creatorDiscoveryRuns)
        .where(
          input.profileId
            ? and(eq(creatorDiscoveryRuns.gameId, input.gameId), eq(creatorDiscoveryRuns.profileId, input.profileId))
            : eq(creatorDiscoveryRuns.gameId, input.gameId),
        )
        .orderBy(desc(creatorDiscoveryRuns.createdAt))
        .limit(input.limit)
        .offset(input.offset)
      return runsWithIssues(ctx, rows)
    }),

  archiveLocation: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    if (!ctx.workspace) return { available: false as const, path: null }
    try {
      return { available: true as const, path: await ctx.workspace.discoveryArchiveLocation(input.gameId) }
    } catch {
      return { available: false as const, path: null }
    }
  }),

  getRun: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const run = (
      await ctx.db.select().from(creatorDiscoveryRuns).where(eq(creatorDiscoveryRuns.id, input.id)).limit(1)
    )[0]
    if (!run) return null
    const withIssue = (await runsWithIssues(ctx, [run]))[0]!
    return {
      ...withIssue,
      profileSnapshot: JSON.parse(run.profileSnapshotJson) as DiscoveryProfileSnapshot,
    }
  }),

  pause: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db
      .update(creatorDiscoveryRuns)
      .set({ status: 'paused', phase: 'paused', heartbeatAt: new Date().toISOString() })
      .where(eq(creatorDiscoveryRuns.id, input.id))
    await syncRunArchive(ctx, input.id)
    return { id: input.id }
  }),

  resume: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const run = (
      await ctx.db
        .select({ status: creatorDiscoveryRuns.status })
        .from(creatorDiscoveryRuns)
        .where(eq(creatorDiscoveryRuns.id, input.id))
        .limit(1)
    )[0]
    if (!run || !['paused', 'waiting_for_quota', 'partial', 'failed'].includes(run.status)) {
      throw new Error('Only paused, quota-waiting, partial, or failed runs can be resumed')
    }
    const timestamp = new Date().toISOString()
    await ctx.db.transaction(async (tx) => {
      if (run.status === 'partial') {
        const apiKey = ctx.secrets?.getApiKey('youtube')
        const uncertainRequest = apiKey
          ? and(
              eq(youtubeApiRequests.status, 'uncertain'),
              eq(youtubeApiRequests.keyFingerprint, youtubeKeyFingerprint(apiKey)),
            )
          : and(eq(youtubeApiRequests.status, 'uncertain'), eq(youtubeApiRequests.lastRunId, input.id))
        await tx
          .update(youtubeApiRequests)
          .set({ status: 'failed', error: 'Retry approved by user', updatedAt: timestamp })
          .where(uncertainRequest)
        await tx
          .update(creatorDiscoveryApiRequests)
          .set({ status: 'failed', error: 'Retry approved by user', updatedAt: timestamp })
          .where(
            and(
              eq(creatorDiscoveryApiRequests.status, 'uncertain'),
              eq(creatorDiscoveryApiRequests.lastRunId, input.id),
            ),
          )
      }
      await tx
        .update(creatorDiscoveryRuns)
        .set({ status: 'queued', phase: 'queued', error: null, finishedAt: null, heartbeatAt: timestamp })
        .where(eq(creatorDiscoveryRuns.id, input.id))
    })
    ctx.wakeCreatorDiscovery?.()
    await syncRunArchive(ctx, input.id)
    return { id: input.id }
  }),

  cancel: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.transaction(async (tx) => {
      await tx.delete(creatorDiscoveryRunSearches).where(eq(creatorDiscoveryRunSearches.runId, input.id))
      await tx.delete(creatorDiscoveryRunChannels).where(eq(creatorDiscoveryRunChannels.runId, input.id))
      await tx
        .update(creatorDiscoveryRuns)
        .set({
          status: 'cancelled',
          phase: 'cancelled',
          finishedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
        })
        .where(eq(creatorDiscoveryRuns.id, input.id))
    })
    await syncRunArchive(ctx, input.id)
    return { id: input.id }
  }),

  candidates: publicProcedure
    .input(
      z.object({
        runId: z.string(),
        status: z.enum(['staged', 'promoted', 'dismissed']).optional(),
        minFit: z.number().int().min(0).max(100).default(0),
        minReferenceMatches: z.number().int().min(1).max(100).default(1),
        requireBusinessEmail: z.boolean().default(false),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1_000).default(500),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filters = [
        eq(creatorDiscoveryRunCandidates.runId, input.runId),
        gte(creatorDiscoveryRunCandidates.fitScore, input.minFit),
        gte(creatorDiscoveryRunCandidates.matchedReferenceCount, input.minReferenceMatches),
      ]
      if (input.status) filters.push(eq(creatorDiscoveryRunCandidates.status, input.status))
      if (input.requireBusinessEmail) {
        const withEmail = await businessEmailCandidateIds(ctx, input.runId)
        if (!withEmail.length) return []
        filters.push(inArray(creatorDiscoveryRunCandidates.candidateId, withEmail))
      }
      const rows = await ctx.db
        .select({ result: creatorDiscoveryRunCandidates, candidate: creatorDiscoveryCandidates })
        .from(creatorDiscoveryRunCandidates)
        .innerJoin(
          creatorDiscoveryCandidates,
          eq(creatorDiscoveryCandidates.id, creatorDiscoveryRunCandidates.candidateId),
        )
        .where(and(...filters))
        .orderBy(
          desc(creatorDiscoveryRunCandidates.fitScore),
          desc(creatorDiscoveryRunCandidates.matchedReferenceCount),
        )
        .offset(input.offset)
        .limit(input.limit)
      const candidateIds = rows.map((row) => row.candidate.id)
      const [contacts, evidence] = candidateIds.length
        ? await Promise.all([
            ctx.db
              .select()
              .from(creatorDiscoveryContacts)
              .where(
                and(
                  eq(creatorDiscoveryContacts.runId, input.runId),
                  inArray(creatorDiscoveryContacts.candidateId, candidateIds),
                ),
              ),
            ctx.db
              .select()
              .from(creatorDiscoveryEvidence)
              .where(
                and(
                  eq(creatorDiscoveryEvidence.runId, input.runId),
                  inArray(creatorDiscoveryEvidence.candidateId, candidateIds),
                ),
              ),
          ])
        : [[], []]
      return rows.map((row) => ({
        ...row,
        contacts: contacts.filter((contact) => contact.candidateId === row.candidate.id),
        evidence: evidence.filter((item) => item.candidateId === row.candidate.id),
      }))
    }),

  promotedEvidence: publicProcedure
    .input(z.object({ gameId: z.string(), creatorId: z.string(), limit: z.number().int().min(1).max(10).default(5) }))
    .query(async ({ ctx, input }) => {
      const promoted = await ctx.db
        .select({
          result: creatorDiscoveryRunCandidates,
          candidate: creatorDiscoveryCandidates,
          run: creatorDiscoveryRuns,
        })
        .from(creatorDiscoveryRunCandidates)
        .innerJoin(
          creatorDiscoveryCandidates,
          eq(creatorDiscoveryCandidates.id, creatorDiscoveryRunCandidates.candidateId),
        )
        .innerJoin(creatorDiscoveryRuns, eq(creatorDiscoveryRuns.id, creatorDiscoveryRunCandidates.runId))
        .where(
          and(
            eq(creatorDiscoveryRuns.gameId, input.gameId),
            eq(creatorDiscoveryRunCandidates.creatorId, input.creatorId),
            eq(creatorDiscoveryRunCandidates.status, 'promoted'),
          ),
        )
        .orderBy(desc(creatorDiscoveryRuns.createdAt))
        .limit(input.limit)

      return Promise.all(
        promoted.map(async (row) => {
          const evidence = await ctx.db
            .select({ evidence: creatorDiscoveryEvidence, reference: creatorDiscoveryReferences })
            .from(creatorDiscoveryEvidence)
            .innerJoin(
              creatorDiscoveryReferences,
              eq(creatorDiscoveryReferences.id, creatorDiscoveryEvidence.referenceId),
            )
            .where(
              and(
                eq(creatorDiscoveryEvidence.runId, row.run.id),
                eq(creatorDiscoveryEvidence.candidateId, row.candidate.id),
              ),
            )
            .orderBy(desc(creatorDiscoveryEvidence.publishedAt))
          return {
            ...row,
            matchedReferences: parseArray(row.result.matchedReferencesJson),
            fitReasons: parseArray(row.result.fitReasonsJson),
            evidence: evidence.map(({ evidence: item, reference }) => ({
              ...item,
              referenceLabel: reference.label,
              matchedTerms: parseArray(item.matchedTermsJson),
            })),
          }
        }),
      )
    }),

  promote: publicProcedure
    .input(z.object({ runId: z.string(), candidateId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await promoteDiscoveryCandidate(ctx.db, input.runId, input.candidateId)
      scheduleRunArchive(ctx, input.runId)
      return result
    }),

  dismiss: publicProcedure
    .input(z.object({ runId: z.string(), candidateId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(creatorDiscoveryRunCandidates)
        .set({ status: 'dismissed', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(creatorDiscoveryRunCandidates.runId, input.runId),
            eq(creatorDiscoveryRunCandidates.candidateId, input.candidateId),
          ),
        )
      scheduleRunArchive(ctx, input.runId)
      return input
    }),

  restore: publicProcedure
    .input(z.object({ runId: z.string(), candidateId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(creatorDiscoveryRunCandidates)
        .set({ status: 'staged', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(creatorDiscoveryRunCandidates.runId, input.runId),
            eq(creatorDiscoveryRunCandidates.candidateId, input.candidateId),
            eq(creatorDiscoveryRunCandidates.status, 'dismissed'),
          ),
        )
      scheduleRunArchive(ctx, input.runId)
      return input
    }),

  reviewPreview: publicProcedure
    .input(
      z.object({
        runId: z.string(),
        minFit: z.number().int().min(0).max(100).default(0),
        minReferenceMatches: z.number().int().min(1).max(100).default(1),
        requireBusinessEmail: z.boolean().default(false),
        batchLimit: z.number().int().min(1).max(1_000).default(500),
      }),
    )
    .query(async ({ ctx, input }) => {
      const candidateIds = await selectCandidateIds(
        ctx,
        {
          runId: input.runId,
          minFit: input.minFit,
          minReferenceMatches: input.minReferenceMatches,
          requireBusinessEmail: input.requireBusinessEmail,
          limit: 5_000,
        },
        'staged',
      )
      const nextBatchIds = candidateIds.slice(0, input.batchLimit)
      const promotionPreview = await previewDiscoveryPromotions(ctx.db, input.runId, nextBatchIds)
      return {
        total: candidateIds.length,
        nextBatchSize: nextBatchIds.length,
        nextBatchCreated: promotionPreview.created,
        nextBatchUpdated: promotionPreview.updated,
        minFit: input.minFit,
        minReferenceMatches: input.minReferenceMatches,
        requireBusinessEmail: input.requireBusinessEmail,
      }
    }),

  reviewBulk: publicProcedure
    .input(
      z.object({
        runId: z.string(),
        decision: z.enum(['promote', 'dismiss', 'restore']),
        candidateIds: z.array(z.string()).min(1).max(1_000).optional(),
        minFit: z.number().int().min(0).max(100).default(0),
        minReferenceMatches: z.number().int().min(1).max(100).default(1),
        requireBusinessEmail: z.boolean().default(false),
        limit: z.number().int().min(1).max(1_000).default(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const candidateIds = await selectCandidateIds(ctx, input, input.decision === 'restore' ? 'dismissed' : 'staged')
      if (!candidateIds.length) {
        return {
          decision: input.decision,
          selected: 0,
          processed: 0,
          created: 0,
          updated: 0,
          items: [],
          queued: false,
          duplicate: false,
          operation: null,
        }
      }
      if (input.decision === 'dismiss') {
        await ctx.db
          .update(creatorDiscoveryRunCandidates)
          .set({ status: 'dismissed', updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(creatorDiscoveryRunCandidates.runId, input.runId),
              eq(creatorDiscoveryRunCandidates.status, 'staged'),
              inArray(creatorDiscoveryRunCandidates.candidateId, candidateIds),
            ),
          )
        await syncRunArchive(ctx, input.runId)
        return {
          decision: input.decision,
          selected: candidateIds.length,
          processed: candidateIds.length,
          created: 0,
          updated: 0,
          items: candidateIds.map((candidateId) => ({ candidateId })),
          queued: false,
          duplicate: false,
          operation: null,
        }
      }
      if (input.decision === 'restore') {
        await ctx.db
          .update(creatorDiscoveryRunCandidates)
          .set({ status: 'staged', updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(creatorDiscoveryRunCandidates.runId, input.runId),
              eq(creatorDiscoveryRunCandidates.status, 'dismissed'),
              inArray(creatorDiscoveryRunCandidates.candidateId, candidateIds),
            ),
          )
        await syncRunArchive(ctx, input.runId)
        return {
          decision: input.decision,
          selected: candidateIds.length,
          processed: candidateIds.length,
          created: 0,
          updated: 0,
          items: candidateIds.map((candidateId) => ({ candidateId })),
          queued: false,
          duplicate: false,
          operation: null,
        }
      }

      const queued = await queueCreatorPromotion(ctx.db, input.runId, candidateIds)
      ctx.wakeCreatorPromotion?.()
      return {
        decision: input.decision,
        selected: candidateIds.length,
        processed: queued.operation.processed,
        created: queued.operation.createdCount,
        updated: queued.operation.updatedCount,
        items: [],
        queued: true,
        duplicate: queued.duplicate,
        operation: queued.operation,
      }
    }),

  promotionOperations: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        runId: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.db
        .select()
        .from(backgroundOperations)
        .where(
          and(
            eq(backgroundOperations.gameId, input.gameId),
            eq(backgroundOperations.kind, 'creator_promotion'),
            ...(input.runId ? [eq(backgroundOperations.scopeId, input.runId)] : []),
          ),
        )
        .orderBy(desc(backgroundOperations.createdAt))
        .limit(input.limit),
    ),

  promotionOperation: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const operation = (
      await ctx.db
        .select()
        .from(backgroundOperations)
        .where(and(eq(backgroundOperations.id, input.id), eq(backgroundOperations.kind, 'creator_promotion')))
        .limit(1)
    )[0]
    if (!operation) return null
    const failedItems = await ctx.db
      .select({ candidateId: backgroundOperationItems.entityId, error: backgroundOperationItems.error })
      .from(backgroundOperationItems)
      .where(and(eq(backgroundOperationItems.operationId, operation.id), eq(backgroundOperationItems.status, 'failed')))
      .limit(20)
    return { ...operation, failedItems }
  }),

  cancelPromotion: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => cancelCreatorPromotion(ctx.db, input.id)),

  retryPromotion: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const operation = await retryCreatorPromotion(ctx.db, input.id)
    if (operation) ctx.wakeCreatorPromotion?.()
    return operation
  }),

  quota: publicProcedure.query(({ ctx }) =>
    creatorDiscoveryProviderStatus(ctx.db, {
      youtube: ctx.secrets?.getApiKey('youtube'),
      scrapecreators: ctx.secrets?.getApiKey('scrapecreators'),
    }),
  ),
})
