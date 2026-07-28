import fs from 'node:fs'
import { join } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { apiSpend, eventMetrics, events, inboxComments, providerSettings, sources, syncRuns, type DB } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { stripUndefined } from '../util/slug'
import { importWishlistCsv } from '../wishlistImport'
import { PLATFORMS, fetchPosts, isPlatform, type Platform } from '../connectors'
import { fetchReviewItems, isReviewPlatform, type ReviewPlatform } from '../reviewConnectors'
import { syncSteamFinancials } from '../storefrontMetrics'

const today = () => new Date().toISOString().slice(0, 10)
const now = () => new Date().toISOString()

async function addSpend(db: DB, provider: string, requests: number, cost: number) {
  const d = today()
  const ex = await db
    .select()
    .from(apiSpend)
    .where(and(eq(apiSpend.provider, provider), eq(apiSpend.date, d)))
    .limit(1)
  if (ex[0]) {
    await db
      .update(apiSpend)
      .set({ requests: ex[0].requests + requests, costUsd: ex[0].costUsd + cost })
      .where(eq(apiSpend.id, ex[0].id))
  } else {
    await db.insert(apiSpend).values({ provider, date: d, requests, costUsd: cost })
  }
}

/** Scan a Steam CSV folder and upsert every row into wishlist_points (idempotent). */
async function syncSteam(db: DB, gameId: string, folder: string): Promise<number> {
  if (!folder || !fs.existsSync(folder)) throw new Error(`Folder not found: ${folder}`)
  const files = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.csv'))
  if (!files.length) throw new Error('No .csv files in the folder')
  let imported = 0
  for (const f of files) {
    const result = await importWishlistCsv(db, {
      gameId,
      csv: fs.readFileSync(join(folder, f), 'utf8'),
      filename: f,
    })
    imported += result.imported
  }
  return imported
}

/** Pull a social account's latest posts into events (+ metric history). Returns new-event count. */
async function syncSocial(
  db: DB,
  gameId: string,
  sourceId: string,
  platform: Platform,
  handle: string,
  apiKey: string,
) {
  const posts = await fetchPosts(platform, handle, apiKey)
  let imported = 0
  for (const p of posts) {
    const existing = await db
      .select()
      .from(events)
      .where(and(eq(events.gameId, gameId), eq(events.sourceId, sourceId), eq(events.externalId, p.externalId)))
      .limit(1)
    let eventId: string
    if (existing[0]) {
      eventId = existing[0].id
      await db
        .update(events)
        .set({ views: p.views, likes: p.likes, comments: p.comments, updatedAt: now() })
        .where(eq(events.id, eventId))
    } else {
      const rows = await db
        .insert(events)
        .values({
          gameId,
          occurredAt: p.occurredAt,
          type: platform === 'youtube' ? 'video' : 'post',
          platform,
          placement: handle,
          title: p.title || '(no caption)',
          url: p.url,
          views: p.views,
          likes: p.likes,
          comments: p.comments,
          isOwn: true,
          sourceId,
          externalId: p.externalId,
          createdBy: 'source',
        })
        .returning()
      eventId = rows[0]!.id
      imported++
    }
    await db
      .insert(eventMetrics)
      .values({ eventId, views: p.views, likes: p.likes, comments: p.comments, shares: p.shares })
  }
  return imported
}

/** Pull normalized reviews/comments into the project inbox. Returns new-or-updated count. */
async function syncFeedback(db: DB, gameId: string, sourceId: string, platform: ReviewPlatform, target: string) {
  const items = await fetchReviewItems(platform, target)
  let imported = 0
  const observedAt = now()
  for (const item of items) {
    const existing = await db
      .select()
      .from(inboxComments)
      .where(and(eq(inboxComments.sourceId, sourceId), eq(inboxComments.externalId, item.externalId)))
      .limit(1)
    const current = existing[0]
    const changed =
      !!current &&
      (current.body !== item.body ||
        current.remoteUpdatedAt !== item.updatedAt ||
        current.developerReply !== item.developerReply)
    const replyIsCurrent =
      !!item.developerReply &&
      (!item.updatedAt || !item.developerRepliedAt || item.developerRepliedAt >= item.updatedAt)
    if (current) {
      const status = changed
        ? replyIsCurrent
          ? 'replied'
          : 'unread'
        : current.status === 'ignored'
          ? 'ignored'
          : replyIsCurrent
            ? 'replied'
            : current.status
      await db
        .update(inboxComments)
        .set({
          kind: item.kind,
          authorName: item.authorName,
          authorUrl: item.authorUrl,
          body: item.body,
          rating: item.rating,
          language: item.language,
          url: item.url,
          publishedAt: item.publishedAt,
          remoteUpdatedAt: item.updatedAt,
          developerReply: item.developerReply,
          developerRepliedAt: item.developerRepliedAt,
          status,
          lastSeenAt: observedAt,
          updatedAt: observedAt,
        })
        .where(eq(inboxComments.id, current.id))
      if (changed) imported++
    } else {
      await db.insert(inboxComments).values({
        gameId,
        sourceId,
        platform,
        externalId: item.externalId,
        kind: item.kind,
        authorName: item.authorName,
        authorUrl: item.authorUrl,
        body: item.body,
        rating: item.rating,
        language: item.language,
        url: item.url,
        publishedAt: item.publishedAt,
        remoteUpdatedAt: item.updatedAt,
        developerReply: item.developerReply,
        developerRepliedAt: item.developerRepliedAt,
        status: replyIsCurrent ? 'replied' : 'unread',
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        createdAt: observedAt,
        updatedAt: observedAt,
      })
      imported++
    }
  }
  return imported
}

export const sourcesRouter = router({
  /** Platform catalogue (paid flag, provider, estimated cost) for the UI. */
  platforms: publicProcedure.query(() => Object.entries(PLATFORMS).map(([id, info]) => ({ id, ...info }))),

  keyStatus: publicProcedure.query(({ ctx }) => ({
    twitterapi: !!ctx.secrets?.getApiKey('twitterapi'),
    scrapecreators: !!ctx.secrets?.getApiKey('scrapecreators'),
    youtube: !!ctx.secrets?.getApiKey('youtube'),
    steamfinancial: !!ctx.secrets?.getApiKey('steamfinancial'),
    gmass: !!ctx.secrets?.getApiKey('gmass'),
  })),

  setApiKey: publicProcedure.input(z.object({ provider: z.string(), key: z.string() })).mutation(({ ctx, input }) => {
    const key = input.key.trim()
    ctx.secrets?.setApiKey(input.provider, key || null)
    if (input.provider === 'steamfinancial' && key) void syncSteamFinancials(ctx.db, key).catch(() => {})
    return { ok: true }
  }),

  list: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db.select().from(sources).where(eq(sources.gameId, input.gameId)).orderBy(desc(sources.createdAt))
  }),

  create: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        platform: z.string(),
        handle: z.string().min(1),
        displayName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!isPlatform(input.platform)) throw new Error(`Unknown platform: ${input.platform}`)
      const rows = await ctx.db
        .insert(sources)
        .values({
          gameId: input.gameId,
          platform: input.platform,
          handle: input.handle.trim(),
          displayName: input.displayName?.trim() || null,
        })
        .returning()
      return rows[0]!
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        patch: z.object({
          handle: z.string().optional(),
          displayName: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db
        .update(sources)
        .set(stripUndefined({ ...input.patch }))
        .where(eq(sources.id, input.id))
        .returning()
      return rows[0] ?? null
    }),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(sources).where(eq(sources.id, input.id))
    return { id: input.id }
  }),

  history: publicProcedure.input(z.object({ sourceId: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.sourceId, input.sourceId))
      .orderBy(desc(syncRuns.startedAt))
      .limit(20)
  }),

  /** Today's spend + budget per paid provider. */
  spend: publicProcedure.query(async ({ ctx }) => {
    const d = today()
    const spendRows = await ctx.db.select().from(apiSpend).where(eq(apiSpend.date, d))
    const budgets = await ctx.db.select().from(providerSettings)
    const providers = ['twitterapi', 'scrapecreators']
    return providers.map((p) => ({
      provider: p,
      todayCostUsd: spendRows.find((s) => s.provider === p)?.costUsd ?? 0,
      todayRequests: spendRows.find((s) => s.provider === p)?.requests ?? 0,
      dailyBudgetUsd: budgets.find((b) => b.provider === p)?.dailyBudgetUsd ?? null,
    }))
  }),

  setBudget: publicProcedure
    .input(z.object({ provider: z.string(), dailyBudgetUsd: z.number().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const ex = await ctx.db
        .select()
        .from(providerSettings)
        .where(eq(providerSettings.provider, input.provider))
        .limit(1)
      if (ex[0]) {
        await ctx.db
          .update(providerSettings)
          .set({ dailyBudgetUsd: input.dailyBudgetUsd })
          .where(eq(providerSettings.provider, input.provider))
      } else {
        await ctx.db.insert(providerSettings).values({ provider: input.provider, dailyBudgetUsd: input.dailyBudgetUsd })
      }
      return { ok: true }
    }),

  /**
   * Run a source. Free sources (steam) run immediately. Paid sources return a
   * cost estimate first (confirm:false) and only spend when confirm:true, gated
   * by the provider's daily budget.
   */
  sync: publicProcedure
    .input(z.object({ sourceId: z.string(), confirm: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const srcRows = await ctx.db.select().from(sources).where(eq(sources.id, input.sourceId)).limit(1)
      const source = srcRows[0]
      if (!source) throw new Error('Source not found')
      if (!isPlatform(source.platform)) throw new Error(`Unknown platform: ${source.platform}`)
      const platform = source.platform
      const info = PLATFORMS[platform]

      // Paid: estimate first, then require confirmation.
      if (info.paid && !input.confirm) {
        return {
          dryRun: true as const,
          paid: true,
          provider: info.provider,
          estCostUsd: info.costPerRequest,
          estRequests: 1,
        }
      }

      const runRows = await ctx.db.insert(syncRuns).values({ sourceId: source.id, status: 'running' }).returning()
      const runId = runRows[0]!.id
      try {
        let imported = 0
        let costUsd = 0
        if (isReviewPlatform(platform)) {
          imported = await syncFeedback(ctx.db, source.gameId, source.id, platform, source.handle)
        } else if (platform === 'steam') {
          imported = await syncSteam(ctx.db, source.gameId, source.handle)
          // Steam folder feeds wishlists; nudge dependent queries.
        } else {
          let apiKey = ''
          if (info.needsKey) {
            const k = ctx.secrets?.getApiKey(info.provider!)
            if (!k) throw new Error(`API key for "${info.provider}" is not set (Settings → connectors).`)
            apiKey = k
          }
          if (info.paid) {
            const provider = info.provider!
            const spentRows = await ctx.db
              .select()
              .from(apiSpend)
              .where(and(eq(apiSpend.provider, provider), eq(apiSpend.date, today())))
              .limit(1)
            const budgetRows = await ctx.db
              .select()
              .from(providerSettings)
              .where(eq(providerSettings.provider, provider))
              .limit(1)
            const budget = budgetRows[0]?.dailyBudgetUsd
            const spent = spentRows[0]?.costUsd ?? 0
            if (budget != null && spent + info.costPerRequest > budget) {
              throw new Error(`Daily budget for "${provider}" reached ($${budget}).`)
            }
          }
          imported = await syncSocial(ctx.db, source.gameId, source.id, platform, source.handle, apiKey)
          if (info.paid) {
            costUsd = info.costPerRequest
            await addSpend(ctx.db, info.provider!, 1, costUsd)
          }
        }
        await ctx.db
          .update(syncRuns)
          .set({ status: 'ok', finishedAt: now(), imported, costUsd })
          .where(eq(syncRuns.id, runId))
        await ctx.db.update(sources).set({ lastSyncedAt: now(), lastStatus: 'ok' }).where(eq(sources.id, source.id))
        return { dryRun: false as const, imported, costUsd }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await ctx.db
          .update(syncRuns)
          .set({ status: 'error', finishedAt: now(), error: msg })
          .where(eq(syncRuns.id, runId))
        await ctx.db.update(sources).set({ lastSyncedAt: now(), lastStatus: 'error' }).where(eq(sources.id, source.id))
        throw new Error(msg)
      }
    }),
})
