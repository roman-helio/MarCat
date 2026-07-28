import { eq } from 'drizzle-orm'
import { games } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { getSteamWishlistRank } from '../steamWishlistRank'
import { getCriticScore, getSteamReviews, getSteamSalesSummary, syncSteamFinancials } from '../storefrontMetrics'

type StoredLink = { type?: unknown; url?: unknown }

function criticUrlOf(raw: string | null): string | null {
  try {
    const links = JSON.parse(raw ?? '[]') as StoredLink[]
    if (!Array.isArray(links)) return null
    const link = links.find((item) => item.type === 'metacritic') ?? links.find((item) => item.type === 'opencritic')
    return typeof link?.url === 'string' && link.url ? link.url : null
  } catch {
    return null
  }
}

export const storefrontRouter = router({
  metrics: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(games).where(eq(games.id, input.gameId)).limit(1)
    const game = rows[0]
    if (!game) return null

    const appId = game.steamAppId
    const criticUrl = criticUrlOf(game.officialLinks)
    const financialKey = ctx.secrets?.getApiKey('steamfinancial')
    const sales = appId ? await getSteamSalesSummary(ctx.db, appId) : null
    const lastFinancialSync = sales?.lastSyncedAt ? Date.parse(sales.lastSyncedAt) : 0
    if (financialKey && Date.now() - lastFinancialSync >= 6 * 60 * 60 * 1_000) {
      void syncSteamFinancials(ctx.db, financialKey).catch(() => {})
    }

    const [rankResult, reviewsResult, criticResult] = await Promise.allSettled([
      appId ? getSteamWishlistRank(appId) : Promise.resolve(null),
      appId ? getSteamReviews(appId) : Promise.resolve(null),
      criticUrl ? getCriticScore(criticUrl) : Promise.resolve(null),
    ])

    return {
      appId,
      rank: rankResult.status === 'fulfilled' ? rankResult.value : null,
      reviews: reviewsResult.status === 'fulfilled' ? reviewsResult.value : null,
      sales,
      salesConnectorConfigured: !!financialKey,
      critic: criticResult.status === 'fulfilled' ? criticResult.value : null,
      criticUrl,
      checkedAt: new Date().toISOString(),
    }
  }),
})
