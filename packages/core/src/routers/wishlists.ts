import { asc, eq } from 'drizzle-orm'
import { games, wishlistPoints } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { detectWishlistCsvMapping, parseCsv } from '../util/csv'
import { importWishlistCsv } from '../wishlistImport'
import { getSteamWishlistRank } from '../steamWishlistRank'

const mapping = z.object({
  date: z.string(),
  adds: z.string().optional(),
  deletes: z.string().optional(),
  gifts: z.string().optional(),
  balance: z.string().optional(),
  net: z.string().optional(),
})

export const wishlistsRouter = router({
  series: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db
      .select()
      .from(wishlistPoints)
      .where(eq(wishlistPoints.gameId, input.gameId))
      .orderBy(asc(wishlistPoints.date))
  }),

  topRank: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select({ steamAppId: games.steamAppId })
      .from(games)
      .where(eq(games.id, input.gameId))
      .limit(1)
    const appId = rows[0]?.steamAppId ?? null
    if (!appId) return { status: 'missing-app-id' as const, rank: null }

    try {
      return { status: 'ok' as const, ...(await getSteamWishlistRank(appId)) }
    } catch (error) {
      return {
        status: 'unavailable' as const,
        rank: null,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }),

  addPoint: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        date: z.string(),
        adds: z.number().int().nullish(),
        deletes: z.number().int().nullish(),
        gifts: z.number().int().nullish(),
        balance: z.number().int().nullish(),
        net: z.number().int().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { gameId, date, ...rest } = input
      await ctx.db
        .insert(wishlistPoints)
        .values({ gameId, date, source: 'manual', ...rest })
        .onConflictDoUpdate({
          target: [wishlistPoints.gameId, wishlistPoints.date],
          set: { ...rest, source: 'manual' },
        })
      return { ok: true }
    }),

  deletePoint: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(wishlistPoints).where(eq(wishlistPoints.id, input.id))
    return { id: input.id }
  }),

  /** Parse a CSV and return its detected columns plus a few sample rows. */
  previewCsv: publicProcedure.input(z.object({ csv: z.string() })).mutation(async ({ input }) => {
    const { headers, rows } = parseCsv(input.csv)
    return { headers, mapping: detectWishlistCsvMapping(headers), sample: rows.slice(0, 5), total: rows.length }
  }),

  importCsv: publicProcedure
    .input(
      z.object({ gameId: z.string(), csv: z.string(), filename: z.string().optional(), mapping: mapping.optional() }),
    )
    .mutation(({ ctx, input }) => importWishlistCsv(ctx.db, input)),
})
