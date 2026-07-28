import { desc, eq } from 'drizzle-orm'
import { utmLinks } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'

function buildUtmUrl(
  base: string,
  p: { utmSource: string; utmMedium: string; utmCampaign: string; utmContent?: string | null; utmTerm?: string | null },
): string {
  const params = new URLSearchParams()
  params.set('utm_source', p.utmSource)
  params.set('utm_medium', p.utmMedium)
  params.set('utm_campaign', p.utmCampaign)
  if (p.utmContent) params.set('utm_content', p.utmContent)
  if (p.utmTerm) params.set('utm_term', p.utmTerm)
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}${params.toString()}`
}

export const utmRouter = router({
  list: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db.select().from(utmLinks).where(eq(utmLinks.gameId, input.gameId)).orderBy(desc(utmLinks.createdAt))
  }),

  build: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        label: z.string().min(1).max(80),
        baseUrl: z.string().min(1),
        utmSource: z.string().min(1),
        utmMedium: z.string().min(1),
        utmCampaign: z.string().min(1),
        utmContent: z.string().nullish(),
        utmTerm: z.string().nullish(),
        eventId: z.string().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const fullUrl = buildUtmUrl(input.baseUrl, input)
      const rows = await ctx.db
        .insert(utmLinks)
        .values({
          gameId: input.gameId,
          label: input.label,
          baseUrl: input.baseUrl,
          utmSource: input.utmSource,
          utmMedium: input.utmMedium,
          utmCampaign: input.utmCampaign,
          utmContent: input.utmContent ?? null,
          utmTerm: input.utmTerm ?? null,
          fullUrl,
          eventId: input.eventId ?? null,
        })
        .returning()
      return rows[0]!
    }),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(utmLinks).where(eq(utmLinks.id, input.id))
    return { id: input.id }
  }),
})
