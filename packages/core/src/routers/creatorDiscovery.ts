import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm'
import {
  creatorDiscoveryCandidates,
  creatorDiscoveryContacts,
  creatorDiscoveryEvidence,
  creatorDiscoveryProfiles,
  creatorDiscoveryReferences,
  creatorDiscoveryRunCandidates,
  creatorDiscoveryRuns,
} from '@marcat/db'
import { z } from 'zod'
import { publicProcedure, router } from '../trpc'
import {
  hashDiscoveryProfile,
  promoteDiscoveryCandidate,
  youtubeQuotaStatus,
  type DiscoveryProfileSnapshot,
} from '../youtubeDiscovery'

const stringList = z.array(z.string().trim().min(1)).max(100).default([])
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

function toSnapshot(profile: NonNullable<Awaited<ReturnType<typeof profileWithReferences>>>): DiscoveryProfileSnapshot {
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
    references: profile.references.map((reference) => ({
      id: reference.id,
      label: reference.label,
      aliases: reference.aliases,
      queryTerms: reference.queryTerms,
      weight: reference.weight,
    })),
  }
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
    .input(z.object({ profileId: z.string(), forceNew: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const profile = await profileWithReferences(ctx, input.profileId)
      if (!profile) throw new Error('Discovery profile not found')
      const snapshot = toSnapshot(profile)
      const profileHash = hashDiscoveryProfile(snapshot)
      const active = await ctx.db
        .select()
        .from(creatorDiscoveryRuns)
        .where(and(eq(creatorDiscoveryRuns.profileId, profile.id), eq(creatorDiscoveryRuns.profileHash, profileHash)))
        .orderBy(desc(creatorDiscoveryRuns.createdAt))
      const activeDuplicate = active.find((run) =>
        ['queued', 'running', 'paused', 'waiting_for_quota'].includes(run.status),
      )
      if (activeDuplicate) return { run: activeDuplicate, duplicate: true, reason: 'active' as const }
      const freshCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString()
      const freshCompleted = active.find(
        (run) => run.status === 'completed' && run.finishedAt && run.finishedAt >= freshCutoff,
      )
      if (freshCompleted && !input.forceNew) return { run: freshCompleted, duplicate: true, reason: 'fresh' as const }
      const rows = await ctx.db
        .insert(creatorDiscoveryRuns)
        .values({
          gameId: profile.gameId,
          profileId: profile.id,
          profileHash,
          profileSnapshotJson: JSON.stringify(snapshot),
        })
        .returning()
      return { run: rows[0]!, duplicate: false, reason: null }
    }),

  runs: publicProcedure
    .input(z.object({ gameId: z.string(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(({ ctx, input }) =>
      ctx.db
        .select()
        .from(creatorDiscoveryRuns)
        .where(eq(creatorDiscoveryRuns.gameId, input.gameId))
        .orderBy(desc(creatorDiscoveryRuns.createdAt))
        .limit(input.limit),
    ),

  getRun: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const run = (
      await ctx.db.select().from(creatorDiscoveryRuns).where(eq(creatorDiscoveryRuns.id, input.id)).limit(1)
    )[0]
    if (!run) return null
    return { ...run, profileSnapshot: JSON.parse(run.profileSnapshotJson) as DiscoveryProfileSnapshot }
  }),

  pause: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db
      .update(creatorDiscoveryRuns)
      .set({ status: 'paused', phase: 'paused', heartbeatAt: new Date().toISOString() })
      .where(eq(creatorDiscoveryRuns.id, input.id))
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
    if (!run || !['paused', 'waiting_for_quota', 'failed'].includes(run.status)) {
      throw new Error('Only paused, quota-waiting, or failed runs can be resumed')
    }
    await ctx.db
      .update(creatorDiscoveryRuns)
      .set({ status: 'queued', phase: 'queued', error: null, finishedAt: null, heartbeatAt: new Date().toISOString() })
      .where(eq(creatorDiscoveryRuns.id, input.id))
    return { id: input.id }
  }),

  cancel: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db
      .update(creatorDiscoveryRuns)
      .set({
        status: 'cancelled',
        phase: 'cancelled',
        finishedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      })
      .where(eq(creatorDiscoveryRuns.id, input.id))
    return { id: input.id }
  }),

  candidates: publicProcedure
    .input(
      z.object({
        runId: z.string(),
        status: z.enum(['staged', 'promoted', 'dismissed']).optional(),
        minFit: z.number().int().min(0).max(100).default(0),
        limit: z.number().int().min(1).max(1_000).default(500),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filters = [
        eq(creatorDiscoveryRunCandidates.runId, input.runId),
        gte(creatorDiscoveryRunCandidates.fitScore, input.minFit),
      ]
      if (input.status) filters.push(eq(creatorDiscoveryRunCandidates.status, input.status))
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
    .mutation(({ ctx, input }) => promoteDiscoveryCandidate(ctx.db, input.runId, input.candidateId)),

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
      return input
    }),

  quota: publicProcedure.query(({ ctx }) => youtubeQuotaStatus(ctx.db, ctx.secrets?.getApiKey('youtube'))),
})
