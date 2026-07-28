import { and, asc, eq, type InferInsertModel } from 'drizzle-orm'
import { festivalPicks, games, industryEvents } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'

type EventInsert = InferInsertModel<typeof industryEvents>

const festivalType = z.string()

/** Full field set mirrored from the Steam-festival tracking sheet. */
const fields = {
  name: z.string().min(1),
  startDate: z.string().min(1),
  type: festivalType.optional(),
  endDate: z.string().nullish(),
  applyDeadline: z.string().nullish(),
  url: z.string().nullish(),
  applyUrl: z.string().nullish(),
  organizer: z.string().nullish(),
  description: z.string().nullish(),
  notes: z.string().nullish(),
  steamEvent: z.string().nullish(),
  steamFeature: z.string().nullish(),
  media: z.boolean().nullish(),
  offline: z.boolean().nullish(),
  costUsd: z.number().int().nonnegative().nullish(),
  /** @deprecated Compatibility alias for older clients. */
  feeUsd: z.number().int().nonnegative().nullish(),
}
const item = z.object(fields)
/** Partial: every field optional, plus the id. */
const patch = z.object(fields).partial().extend({ id: z.string() })

function normalizeKeyPart(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function importKey(value: { name: string; startDate: string }): string {
  return `${normalizeKeyPart(value.name)}|${value.startDate}`
}

/** Map a validated input to a row, dropping undefined (so update patches are partial). */
function toValues(input: Record<string, unknown>): Partial<EventInsert> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(fields).filter((key) => key !== 'feeUsd')) {
    if (input[key] !== undefined) out[key] = input[key]
  }
  if (input.costUsd === undefined && input.feeUsd !== undefined) out.costUsd = input.feeUsd
  return out as Partial<EventInsert>
}

export const festivalsRouter = router({
  /** Global catalogue of industry events (festivals/conferences/sales). */
  list: publicProcedure.query(({ ctx }) => ctx.db.select().from(industryEvents).orderBy(asc(industryEvents.startDate))),

  /** Which games participate in (picked) each festival — for the global view. */
  participation: publicProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        industryEventId: festivalPicks.industryEventId,
        status: festivalPicks.status,
        gameId: games.id,
        gameName: games.name,
        color: games.color,
      })
      .from(festivalPicks)
      .innerJoin(games, eq(games.id, festivalPicks.gameId))
    return rows
  }),

  /** Industry events a game picked, with their prep status. */
  picks: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select({ id: festivalPicks.industryEventId, status: festivalPicks.status })
      .from(festivalPicks)
      .where(eq(festivalPicks.gameId, input.gameId))
    return rows.map((r) => ({ industryEventId: r.id, status: r.status }))
  }),

  setStatus: publicProcedure
    .input(z.object({ gameId: z.string(), industryEventId: z.string(), status: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(festivalPicks)
        .set({ status: input.status })
        .where(and(eq(festivalPicks.gameId, input.gameId), eq(festivalPicks.industryEventId, input.industryEventId)))
      return { ok: true }
    }),

  create: publicProcedure.input(item).mutation(async ({ ctx, input }) => {
    const rows = await ctx.db
      .insert(industryEvents)
      .values({
        ...toValues(input),
        name: input.name,
        startDate: input.startDate,
        type: input.type ?? 'festival',
        source: 'manual',
      })
      .returning()
    return rows[0]!
  }),

  /** Edit any field of a festival (everything is manually editable). */
  update: publicProcedure.input(patch).mutation(async ({ ctx, input }) => {
    const { id, ...rest } = input
    const values = toValues(rest)
    if (Object.keys(values).length) {
      await ctx.db.update(industryEvents).set(values).where(eq(industryEvents.id, id))
    }
    const rows = await ctx.db.select().from(industryEvents).where(eq(industryEvents.id, id))
    return rows[0]!
  }),

  /** Bulk-import a shared list (e.g. the Steam festival calendar). */
  importMany: publicProcedure.input(z.object({ items: z.array(item).min(1) })).mutation(async ({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      const existing = await tx.select().from(industryEvents)
      const byKey = new Map(existing.map((row) => [importKey(row), row.id]))
      let created = 0
      let updated = 0
      for (const it of input.items) {
        const values = {
          ...toValues(it),
          name: it.name,
          startDate: it.startDate,
          type: it.type ?? 'festival',
        }
        const key = importKey({ name: it.name, startDate: it.startDate })
        const existingId = byKey.get(key)
        if (existingId) {
          await tx.update(industryEvents).set(values).where(eq(industryEvents.id, existingId))
          updated++
        } else {
          const rows = await tx
            .insert(industryEvents)
            .values({ ...values, source: 'import' })
            .returning({ id: industryEvents.id })
          byKey.set(key, rows[0]!.id)
          created++
        }
      }
      return { imported: created + updated, created, updated }
    }),
  ),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(industryEvents).where(eq(industryEvents.id, input.id))
    return { id: input.id }
  }),

  pick: publicProcedure
    .input(z.object({ gameId: z.string(), industryEventId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const dup = await ctx.db
        .select()
        .from(festivalPicks)
        .where(and(eq(festivalPicks.gameId, input.gameId), eq(festivalPicks.industryEventId, input.industryEventId)))
      if (!dup.length) await ctx.db.insert(festivalPicks).values(input)
      return { ok: true }
    }),

  unpick: publicProcedure
    .input(z.object({ gameId: z.string(), industryEventId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(festivalPicks)
        .where(and(eq(festivalPicks.gameId, input.gameId), eq(festivalPicks.industryEventId, input.industryEventId)))
      return { ok: true }
    }),
})
