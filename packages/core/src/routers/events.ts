import { and, asc, eq } from 'drizzle-orm'
import { events } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { stripUndefined } from '../util/slug'
import { ACTIVITY_PLATFORMS, ACTIVITY_TYPES } from '../activitySemantics'

const fields = z.object({
  occurredAt: z.string(),
  type: z.enum(ACTIVITY_TYPES).optional(),
  platform: z.enum(ACTIVITY_PLATFORMS).nullish(),
  placement: z.string().max(300).nullish(),
  title: z.string().min(1).max(300),
  description: z.string().optional(),
  url: z.string().nullish(),
  views: z.number().int().nullish(),
  likes: z.number().int().nullish(),
  comments: z.number().int().nullish(),
  isOwn: z.boolean().optional(),
})

export const eventsRouter = router({
  list: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db
      .select()
      .from(events)
      .where(and(eq(events.gameId, input.gameId), eq(events.showOnWishlist, true)))
      .orderBy(asc(events.occurredAt))
  }),

  create: publicProcedure.input(fields.extend({ gameId: z.string() })).mutation(async ({ ctx, input }) => {
    const { gameId, ...rest } = input
    const rows = await ctx.db
      .insert(events)
      .values({
        gameId,
        occurredAt: rest.occurredAt,
        type: rest.type ?? 'other',
        platform: rest.platform ?? null,
        placement: rest.placement ?? null,
        title: rest.title,
        description: rest.description ?? '',
        url: rest.url ?? null,
        views: rest.views ?? null,
        likes: rest.likes ?? null,
        comments: rest.comments ?? null,
        isOwn: rest.isOwn ?? true,
        showOnWishlist: true,
      })
      .returning()
    return rows[0]!
  }),

  update: publicProcedure
    .input(z.object({ id: z.string(), patch: fields.partial() }))
    .mutation(async ({ ctx, input }) => {
      const set = stripUndefined({ ...input.patch, updatedAt: new Date().toISOString() })
      const rows = await ctx.db.update(events).set(set).where(eq(events.id, input.id)).returning()
      return rows[0] ?? null
    }),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(events).where(eq(events.id, input.id))
    return { id: input.id }
  }),
})
