import { and, asc, desc, eq, inArray, type InferInsertModel } from 'drizzle-orm'
import {
  creators,
  creatorPicks,
  events,
  games,
  outreachTemplates,
  tags,
  tasks,
  taskTagLinks,
  type DB,
  withSqliteBusyRetry,
  wishlistPoints,
} from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { computeFit, type FitContext } from '../creators-scoring'
import { computeImpact } from '../analytics'

type CreatorInsert = InferInsertModel<typeof creators>

/** The 6 pipeline stages (Fable-reviewed: compressed from 12). */
export const PIPELINE_STAGES = ['prospect', 'contacted', 'replied', 'agreed', 'published', 'closed'] as const
export const CLOSED_REASONS = ['declined', 'no_response', 'done'] as const

/** Normalize a channel URL into a stable dedup key (host + path, no scheme/query/trailing slash). */
export function channelKeyOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url.trim())
    const host = u.host.replace(/^www\./, '').toLowerCase()
    const path = u.pathname.replace(/\/+$/, '').toLowerCase()
    return `${host}${path}` || null
  } catch {
    const s = url
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
    return s || null
  }
}

const fields = {
  name: z.string().min(1),
  handle: z.string().nullish(),
  kind: z.string().nullish(),
  primaryPlatform: z.string().nullish(),
  channelKey: z.string().nullish(),
  channelsJson: z.string().nullish(),
  audience: z.number().int().nullish(),
  avgViews: z.number().int().nullish(),
  engagementRate: z.number().nullish(),
  lastActiveAt: z.string().nullish(),
  cadencePerMonth: z.number().nullish(),
  topicsJson: z.string().nullish(),
  playedGamesJson: z.string().nullish(),
  language: z.string().nullish(),
  region: z.string().nullish(),
  contactsJson: z.string().nullish(),
  costUsd: z.number().int().nonnegative().nullish(),
  /** @deprecated Compatibility alias for older clients. */
  rateUsd: z.number().int().nonnegative().nullish(),
  acceptsKeysOnly: z.boolean().nullish(),
  currency: z.string().nullish(),
  rateNote: z.string().nullish(),
  doNotContact: z.boolean().nullish(),
  notes: z.string().nullish(),
  description: z.string().nullish(),
}
const item = z.object(fields)
const patch = z.object(fields).partial().extend({ id: z.string() })

const creatorTouchInput = z.object({
  gameId: z.string(),
  creatorId: z.string(),
  occurredAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  direction: z.enum(['outbound', 'inbound']),
  channel: z.enum(['email', 'dm', 'form', 'call']).optional(),
  summary: z.string().optional(),
  body: z.string().nullish(),
  templateId: z.string().nullish(),
  statusAfter: z.enum(PIPELINE_STAGES).nullish(),
  createdBy: z.enum(['manual', 'source', 'ai']).optional(),
  requestId: z.string().min(1).max(200).optional(),
})

type CreatorTouchInput = z.infer<typeof creatorTouchInput>

type CreatorPickState = {
  creatorId: string
  pipelineStatus: (typeof PIPELINE_STAGES)[number]
  closedReason: string | null
  agreedCostUsd: number | null
  keysSentJson: string | null
  pinned: boolean
  addedBy: 'manual' | 'ai'
}

async function creatorPickContext(
  db: DB,
  gameId: string,
  creatorId: string,
): Promise<{ creatorName: string; pick: CreatorPickState }> {
  const row = (
    await db
      .select({
        creatorName: creators.name,
        creatorId: creatorPicks.creatorId,
        pipelineStatus: creatorPicks.pipelineStatus,
        closedReason: creatorPicks.closedReason,
        agreedCostUsd: creatorPicks.agreedCostUsd,
        keysSentJson: creatorPicks.keysSentJson,
        pinned: creatorPicks.pinned,
        addedBy: creatorPicks.addedBy,
      })
      .from(creatorPicks)
      .innerJoin(creators, eq(creators.id, creatorPicks.creatorId))
      .where(and(eq(creatorPicks.gameId, gameId), eq(creatorPicks.creatorId, creatorId)))
      .limit(1)
  )[0]
  if (!row) throw new Error('Creator is not picked for this project')
  return {
    creatorName: row.creatorName,
    pick: {
      creatorId: row.creatorId,
      pipelineStatus: row.pipelineStatus as CreatorPickState['pipelineStatus'],
      closedReason: row.closedReason,
      agreedCostUsd: row.agreedCostUsd,
      keysSentJson: row.keysSentJson,
      pinned: row.pinned,
      addedBy: row.addedBy,
    },
  }
}

function presentTouch(
  touch: typeof events.$inferSelect,
  pick: CreatorPickState,
  replayed: boolean,
): typeof touch & { summary: string; body: string; pick: CreatorPickState; replayed: boolean } {
  return { ...touch, summary: touch.title, body: touch.description, pick, replayed }
}

async function performLogTouch(db: DB, input: CreatorTouchInput) {
  let context = await creatorPickContext(db, input.gameId, input.creatorId)
  const idempotencyKey = input.requestId ? `creator-touch:${input.requestId}` : null
  if (idempotencyKey) {
    const existing = (await db.select().from(events).where(eq(events.idempotencyKey, idempotencyKey)).limit(1))[0]
    if (existing) {
      if (existing.gameId !== input.gameId || existing.creatorId !== input.creatorId) {
        throw new Error('requestId is already used for a different creator touch')
      }
      return presentTouch(existing, context.pick, true)
    }
  }

  const values: typeof events.$inferInsert = {
    gameId: input.gameId,
    subjectType: 'creator',
    subjectId: input.creatorId,
    subjectLabel: context.creatorName,
    showOnWishlist: false,
    creatorId: input.creatorId,
    occurredAt: input.occurredAt ?? new Date().toISOString().slice(0, 10),
    direction: input.direction,
    channel: input.channel ?? 'email',
    title: input.summary?.trim() || (input.direction === 'inbound' ? 'Received reply' : 'Sent message'),
    description: input.body ?? '',
    templateId: input.templateId ?? null,
    statusAfter: input.statusAfter ?? null,
    type: 'other',
    isOwn: input.direction === 'outbound',
    createdBy: input.createdBy ?? 'manual',
    idempotencyKey,
  }
  const rows = idempotencyKey
    ? await db.insert(events).values(values).onConflictDoNothing({ target: events.idempotencyKey }).returning()
    : await db.insert(events).values(values).returning()
  const touch =
    rows[0] ??
    (idempotencyKey
      ? (await db.select().from(events).where(eq(events.idempotencyKey, idempotencyKey)).limit(1))[0]
      : undefined)
  if (!touch) throw new Error('Creator touch was not saved')
  if (rows.length === 0) {
    if (touch.gameId !== input.gameId || touch.creatorId !== input.creatorId) {
      throw new Error('requestId is already used for a different creator touch')
    }
    return presentTouch(touch, context.pick, true)
  }

  // A touch advances the funnel but never moves an already-later relationship backwards.
  if (
    input.statusAfter &&
    PIPELINE_STAGES.indexOf(input.statusAfter) > PIPELINE_STAGES.indexOf(context.pick.pipelineStatus)
  ) {
    const updated = await db
      .update(creatorPicks)
      .set({ pipelineStatus: input.statusAfter })
      .where(and(eq(creatorPicks.gameId, input.gameId), eq(creatorPicks.creatorId, input.creatorId)))
      .returning()
    if (!updated[0]) throw new Error('Creator is not picked for this project')
    context = await creatorPickContext(db, input.gameId, input.creatorId)
  }
  return presentTouch(touch, context.pick, false)
}

function toValues(input: Record<string, unknown>): Partial<CreatorInsert> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(fields).filter((key) => key !== 'rateUsd')) {
    if (input[key] !== undefined) out[key] = input[key]
  }
  if (input.costUsd === undefined && input.rateUsd !== undefined) out.costUsd = input.rateUsd
  return out as Partial<CreatorInsert>
}

/** The tag name that links a game's tasks to this creator (the CRM link convention). */
export function crmTagName(creator: { name: string }): string {
  return creator.name.trim()
}

export const creatorsRouter = router({
  /** Global catalogue of creators (shared by all games). */
  list: publicProcedure.query(({ ctx }) => ctx.db.select().from(creators).orderBy(asc(creators.name))),

  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(creators).where(eq(creators.id, input.id))
    return rows[0] ?? null
  }),

  /** Cross-game participation — which games picked a creator (so we don't spam globally). */
  participation: publicProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        creatorId: creatorPicks.creatorId,
        gameId: games.id,
        gameName: games.name,
        color: games.color,
        status: creatorPicks.pipelineStatus,
      })
      .from(creatorPicks)
      .innerJoin(games, eq(games.id, creatorPicks.gameId))
  }),

  /** Creators a game picked, with pipeline status. */
  picks: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db
      .select({
        creatorId: creatorPicks.creatorId,
        pipelineStatus: creatorPicks.pipelineStatus,
        closedReason: creatorPicks.closedReason,
        agreedCostUsd: creatorPicks.agreedCostUsd,
        keysSentJson: creatorPicks.keysSentJson,
        pinned: creatorPicks.pinned,
        addedBy: creatorPicks.addedBy,
      })
      .from(creatorPicks)
      .where(eq(creatorPicks.gameId, input.gameId))
  }),

  create: publicProcedure.input(item).mutation(async ({ ctx, input }) => {
    const channelKey = input.channelKey ?? channelKeyOf(input.handle) ?? null
    // Dedup: reuse an existing creator with the same channel key.
    if (channelKey) {
      const dup = await ctx.db.select().from(creators).where(eq(creators.channelKey, channelKey))
      if (dup.length) return dup[0]!
    }
    const rows = await ctx.db
      .insert(creators)
      .values({ ...toValues(input), name: input.name, channelKey, source: 'manual' })
      .returning()
    return rows[0]!
  }),

  update: publicProcedure.input(patch).mutation(async ({ ctx, input }) => {
    const { id, ...rest } = input
    const values = toValues(rest)
    if (Object.keys(values).length) {
      await ctx.db
        .update(creators)
        .set({ ...values, updatedAt: new Date().toISOString() })
        .where(eq(creators.id, id))
    }
    const rows = await ctx.db.select().from(creators).where(eq(creators.id, id))
    return rows[0]!
  }),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    // Cascades to picks/touches via FK; global delete also removes personal contacts (compliance).
    await ctx.db.delete(creators).where(eq(creators.id, input.id))
    return { id: input.id }
  }),

  /** Bulk-import a creator list (CSV/JSON), deduped by channel key. */
  importMany: publicProcedure.input(z.object({ items: z.array(item).min(1) })).mutation(async ({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const existing = await tx.select({ id: creators.id, channelKey: creators.channelKey }).from(creators)
      const byKey = new Map(existing.filter((r) => r.channelKey).map((r) => [r.channelKey!, r.id]))
      let created = 0
      let updated = 0
      for (const it of input.items) {
        const channelKey = it.channelKey ?? channelKeyOf(it.handle) ?? null
        const values = { ...toValues(it), name: it.name, channelKey }
        const existingId = channelKey ? byKey.get(channelKey) : undefined
        if (existingId) {
          await tx.update(creators).set(values).where(eq(creators.id, existingId))
          updated++
        } else {
          const rows = await tx
            .insert(creators)
            .values({ ...values, source: 'import' })
            .returning({ id: creators.id })
          if (channelKey) byKey.set(channelKey, rows[0]!.id)
          created++
        }
      }
      return { imported: created + updated, created, updated }
    }),
  ),

  pick: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        creatorId: z.string(),
        addedBy: z.enum(['manual', 'ai']).optional(),
        keysSentJson: z.string().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const dup = await ctx.db
        .select()
        .from(creatorPicks)
        .where(and(eq(creatorPicks.gameId, input.gameId), eq(creatorPicks.creatorId, input.creatorId)))
      if (!dup.length) {
        await ctx.db.insert(creatorPicks).values({
          gameId: input.gameId,
          creatorId: input.creatorId,
          addedBy: input.addedBy ?? 'manual',
          keysSentJson: input.keysSentJson ?? null,
        })
      } else if (input.keysSentJson !== undefined) {
        await ctx.db
          .update(creatorPicks)
          .set({ keysSentJson: input.keysSentJson })
          .where(and(eq(creatorPicks.gameId, input.gameId), eq(creatorPicks.creatorId, input.creatorId)))
      }
      return { ok: true }
    }),

  updatePick: publicProcedure
    .input(z.object({ gameId: z.string(), creatorId: z.string(), keysSentJson: z.string().nullish() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(creatorPicks)
        .set({ keysSentJson: input.keysSentJson ?? null })
        .where(and(eq(creatorPicks.gameId, input.gameId), eq(creatorPicks.creatorId, input.creatorId)))
      return { ok: true }
    }),

  unpick: publicProcedure
    .input(z.object({ gameId: z.string(), creatorId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(creatorPicks)
        .where(and(eq(creatorPicks.gameId, input.gameId), eq(creatorPicks.creatorId, input.creatorId)))
      return { ok: true }
    }),

  setStatus: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        creatorId: z.string(),
        pipelineStatus: z.enum(PIPELINE_STAGES),
        closedReason: z.enum(CLOSED_REASONS).nullish(),
        agreedCostUsd: z.number().int().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const set: Record<string, unknown> = { pipelineStatus: input.pipelineStatus }
      if (input.closedReason !== undefined) set.closedReason = input.closedReason
      if (input.agreedCostUsd !== undefined) set.agreedCostUsd = input.agreedCostUsd
      return withSqliteBusyRetry(async () => {
        const rows = await ctx.db
          .update(creatorPicks)
          .set(set)
          .where(and(eq(creatorPicks.gameId, input.gameId), eq(creatorPicks.creatorId, input.creatorId)))
          .returning()
        if (!rows[0]) throw new Error('Creator is not picked for this project')
        return rows[0]
      })
    }),

  /* ------------------------------ Fit scoring (on the fly) ------------------------------ */

  /** Compute the deterministic fit score for a game's picked creators (or a given subset). */
  fit: publicProcedure
    .input(z.object({ gameId: z.string(), creatorIds: z.array(z.string()).optional() }))
    .query(async ({ ctx, input }) => {
      // Game topics = its tag names (proxy for genres/themes).
      const [gameTags, gameRows] = await Promise.all([
        ctx.db.select({ name: tags.name }).from(tags).where(eq(tags.gameId, input.gameId)),
        ctx.db.select({ name: games.name }).from(games).where(eq(games.id, input.gameId)).limit(1),
      ])
      const gameTopics = gameTags.map((t) => t.name)

      // Past performance: lift of this game's beats, grouped by creator.
      const evs = await ctx.db
        .select()
        .from(events)
        .where(and(eq(events.gameId, input.gameId), eq(events.showOnWishlist, true)))
      const pts = await ctx.db.select().from(wishlistPoints).where(eq(wishlistPoints.gameId, input.gameId))
      const { impacts } = computeImpact(evs, pts)
      const liftByEvent = new Map(
        impacts
          .filter((impact) => impact.lift != null && impact.classification !== 'ambiguous')
          .map((impact) => [impact.eventId, impact.lift!]),
      )
      const pastByCreator = new Map<string, { total: number; count: number }>()
      for (const e of evs) {
        if (!e.creatorId) continue
        const lift = liftByEvent.get(e.id)
        if (lift == null) continue
        const cur = pastByCreator.get(e.creatorId) ?? { total: 0, count: 0 }
        cur.total += lift
        cur.count += 1
        pastByCreator.set(e.creatorId, cur)
      }

      let ids = input.creatorIds
      if (!ids) {
        const picks = await ctx.db
          .select({ creatorId: creatorPicks.creatorId })
          .from(creatorPicks)
          .where(eq(creatorPicks.gameId, input.gameId))
        ids = picks.map((p) => p.creatorId)
      }
      if (!ids.length) return []
      const rows = await ctx.db.select().from(creators).where(inArray(creators.id, ids))
      const baseCtx: FitContext = { gameTopics, gameName: gameRows[0]?.name }
      return rows.map((c) => {
        const fit = computeFit(c, { ...baseCtx, pastLift: pastByCreator.get(c.id) })
        return { creatorId: c.id, score: fit.score, reasons: fit.reasons, components: fit.components }
      })
    }),

  /* --------------------------------- Correspondence --------------------------------- */

  touches: publicProcedure.input(z.object({ gameId: z.string(), creatorId: z.string() })).query(({ ctx, input }) =>
    ctx.db
      .select()
      .from(events)
      .where(
        and(eq(events.gameId, input.gameId), eq(events.subjectType, 'creator'), eq(events.subjectId, input.creatorId)),
      )
      .orderBy(desc(events.occurredAt), desc(events.createdAt))
      .then((rows) => rows.map((row) => ({ ...row, summary: row.title, body: row.description }))),
  ),

  logTouch: publicProcedure.input(creatorTouchInput).mutation(({ ctx, input }) =>
    withSqliteBusyRetry(() =>
      ctx.db.transaction((tx) => performLogTouch(tx as unknown as DB, input)),
    ),
  ),

  logTouchesBulk: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        items: z
          .array(
            creatorTouchInput.omit({ gameId: true }).extend({
              requestId: z.string().min(1).max(200),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(({ ctx, input }) =>
      withSqliteBusyRetry(() =>
        ctx.db.transaction(async (tx) => {
          const db = tx as unknown as DB
          const results = []
          for (const item of input.items) results.push(await performLogTouch(db, { ...item, gameId: input.gameId }))
          return { count: results.length, results }
        }),
      ),
    ),

  removeTouch: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(events).where(eq(events.id, input.id))
    return { id: input.id }
  }),

  /** Tasks linked to a creator via the CRM tag convention. */
  tasksFor: publicProcedure
    .input(z.object({ gameId: z.string(), creatorId: z.string() }))
    .query(async ({ ctx, input }) => {
      const c = (await ctx.db.select().from(creators).where(eq(creators.id, input.creatorId)))[0]
      if (!c) return []
      const name = crmTagName(c).toLowerCase()
      const gameTags = await ctx.db.select().from(tags).where(eq(tags.gameId, input.gameId))
      const tag = gameTags.find((t) => t.name.trim().toLowerCase() === name)
      if (!tag) return []
      const linkRows = await ctx.db
        .select({ taskId: taskTagLinks.taskId })
        .from(taskTagLinks)
        .where(eq(taskTagLinks.tagId, tag.id))
      const ids = linkRows.map((l) => l.taskId)
      if (!ids.length) return []
      const rows = await ctx.db.select().from(tasks).where(inArray(tasks.id, ids))
      const allLinks = await ctx.db
        .select({
          taskId: taskTagLinks.taskId,
          id: tags.id,
          name: tags.name,
          color: tags.color,
          colorEnabled: tags.colorEnabled,
        })
        .from(taskTagLinks)
        .innerJoin(tags, eq(taskTagLinks.tagId, tags.id))
        .where(inArray(taskTagLinks.taskId, ids))
      const byTask = new Map<string, { id: string; name: string; color: string; colorEnabled: boolean }[]>()
      for (const link of allLinks) {
        byTask.set(link.taskId, [
          ...(byTask.get(link.taskId) ?? []),
          { id: link.id, name: link.name, color: link.color, colorEnabled: link.colorEnabled },
        ])
      }
      const game = await ctx.db.select({ key: games.key }).from(games).where(eq(games.id, input.gameId)).limit(1)
      const gameKey = game[0]?.key ?? null
      return rows.map((task) => ({
        ...task,
        taskKey: gameKey && task.seq != null ? `${gameKey}-${task.seq}` : null,
        tags: byTask.get(task.id) ?? [],
      }))
    }),

  /* ----------------------------------- Templates ----------------------------------- */

  templates: publicProcedure.query(({ ctx }) =>
    ctx.db.select().from(outreachTemplates).orderBy(asc(outreachTemplates.name)),
  ),

  saveTemplate: publicProcedure
    .input(z.object({ id: z.string().optional(), name: z.string().min(1), subject: z.string(), body: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.id) {
        await ctx.db
          .update(outreachTemplates)
          .set({ name: input.name, subject: input.subject, body: input.body })
          .where(eq(outreachTemplates.id, input.id))
        return { id: input.id }
      }
      const rows = await ctx.db
        .insert(outreachTemplates)
        .values({ name: input.name, subject: input.subject, body: input.body })
        .returning({ id: outreachTemplates.id })
      return { id: rows[0]!.id }
    }),

  removeTemplate: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(outreachTemplates).where(eq(outreachTemplates.id, input.id))
    return { id: input.id }
  }),

  /* ------------------------------------ Funnel ------------------------------------- */

  /** Per-game outreach funnel + effectiveness (deterministic, on the fly). */
  funnel: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    const picks = await ctx.db.select().from(creatorPicks).where(eq(creatorPicks.gameId, input.gameId))
    const stageOrder = PIPELINE_STAGES
    const counts: Record<string, number> = {}
    for (const s of stageOrder) counts[s] = 0
    for (const p of picks) counts[p.pipelineStatus] = (counts[p.pipelineStatus] ?? 0) + 1

    const touchRows = await ctx.db
      .select()
      .from(events)
      .where(and(eq(events.gameId, input.gameId), eq(events.subjectType, 'creator')))
      .then((rows) => rows.filter((row) => row.direction != null))
    const outbound = touchRows.filter((t) => t.direction === 'outbound').length
    const inbound = touchRows.filter((t) => t.direction === 'inbound').length
    const contacted = picks.filter((p) => p.pipelineStatus !== 'prospect').length
    const replied = picks.filter((p) => ['replied', 'agreed', 'published'].includes(p.pipelineStatus)).length
    const published = picks.filter((p) => p.pipelineStatus === 'published').length

    return {
      stageCounts: counts,
      total: picks.length,
      outbound,
      inbound,
      responseRate: contacted ? replied / contacted : null,
      conversionRate: contacted ? published / contacted : null,
    }
  }),
})
