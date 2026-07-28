import { and, desc, eq } from 'drizzle-orm'
import { inboxComments, sources } from '@marcat/db'
import { z } from 'zod'
import { PLATFORMS } from '../connectors'
import { isReviewPlatform } from '../reviewConnectors'
import { router, publicProcedure } from '../trpc'

const commentStatus = z.enum(['unread', 'open', 'replied', 'ignored'])

export const commentsRouter = router({
  sources: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    const [sourceRows, commentRows] = await Promise.all([
      ctx.db
        .select()
        .from(sources)
        .where(and(eq(sources.gameId, input.gameId), eq(sources.enabled, true))),
      ctx.db.select().from(inboxComments).where(eq(inboxComments.gameId, input.gameId)),
    ])
    return sourceRows
      .filter((source) => isReviewPlatform(source.platform))
      .map((source) => {
        const rows = commentRows.filter((comment) => comment.sourceId === source.id)
        return {
          ...source,
          label:
            source.displayName ??
            (source.platform in PLATFORMS
              ? PLATFORMS[source.platform as keyof typeof PLATFORMS].label
              : source.platform),
          total: rows.length,
          unread: rows.filter((comment) => comment.status === 'unread').length,
          needsReply: rows.filter((comment) => comment.status === 'unread' || comment.status === 'open').length,
        }
      })
  }),

  list: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        sourceId: z.string().optional(),
        status: commentStatus.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const conditions = [eq(inboxComments.gameId, input.gameId)]
      if (input.sourceId) conditions.push(eq(inboxComments.sourceId, input.sourceId))
      if (input.status) conditions.push(eq(inboxComments.status, input.status))
      return ctx.db
        .select()
        .from(inboxComments)
        .where(and(...conditions))
        .orderBy(desc(inboxComments.publishedAt), desc(inboxComments.firstSeenAt))
    }),

  setStatus: publicProcedure
    .input(z.object({ id: z.string(), status: commentStatus }))
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db
        .update(inboxComments)
        .set({ status: input.status, updatedAt: new Date().toISOString() })
        .where(eq(inboxComments.id, input.id))
        .returning()
      return rows[0] ?? null
    }),
})
