import { and, asc, desc, eq } from 'drizzle-orm'
import { analyticsImports, events, wishlistPoints, type DB } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { computeImpact } from '../analytics'
import {
  parseAnalyticsCsv,
  steamTrafficBucket,
  summarizeUtm,
  type AnalyticsImportKind,
  type SteamTrafficRow,
  type UtmMetricRow,
} from '../trafficAnalytics'
import { importWishlistCsv } from '../wishlistImport'

function rowsOf<T>(json: string | undefined): T[] {
  if (!json) return []
  try {
    const value = JSON.parse(json)
    return Array.isArray(value) ? (value as T[]) : []
  } catch {
    return []
  }
}

async function storeAnalyticsImport(db: DB, gameId: string, csv: string, filename?: string) {
  const parsed = parseAnalyticsCsv(csv, filename)
  await db.insert(analyticsImports).values({
    gameId,
    kind: parsed.kind,
    filename: filename ?? null,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    rows: parsed.rows.length,
    rowsJson: JSON.stringify(parsed.rows),
  })
  return { kind: parsed.kind, imported: parsed.rows.length, dateFrom: parsed.dateFrom, dateTo: parsed.dateTo }
}

export const analyticsRouter = router({
  impact: publicProcedure
    .input(z.object({ gameId: z.string(), windowDays: z.number().int().min(1).max(60).optional() }))
    .query(async ({ ctx, input }) => {
      const evs = await ctx.db
        .select()
        .from(events)
        .where(and(eq(events.gameId, input.gameId), eq(events.showOnWishlist, true)))
        .orderBy(asc(events.occurredAt))
      const pts = await ctx.db
        .select()
        .from(wishlistPoints)
        .where(eq(wishlistPoints.gameId, input.gameId))
        .orderBy(asc(wishlistPoints.date))
      return computeImpact(evs, pts, input.windowDays ?? 3)
    }),

  importTrafficCsv: publicProcedure
    .input(z.object({ gameId: z.string(), csv: z.string(), filename: z.string().optional() }))
    .mutation(({ ctx, input }) => storeAnalyticsImport(ctx.db, input.gameId, input.csv, input.filename)),

  /** One entry point for every CSV accepted by the Analytics drop zone. */
  importCsv: publicProcedure
    .input(z.object({ gameId: z.string(), csv: z.string(), filename: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        parseAnalyticsCsv(input.csv, input.filename)
      } catch (analyticsError) {
        try {
          const result = await importWishlistCsv(ctx.db, input)
          return { kind: 'wishlists' as const, imported: result.imported, dateFrom: null, dateTo: null }
        } catch {
          const reason = analyticsError instanceof Error ? analyticsError.message : String(analyticsError)
          throw new Error(`CSV format was not recognized. ${reason}`)
        }
      }
      return storeAnalyticsImport(ctx.db, input.gameId, input.csv, input.filename)
    }),

  overview: publicProcedure
    .input(z.object({ gameId: z.string(), dateFrom: z.string().optional(), dateTo: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const imports = await ctx.db
        .select()
        .from(analyticsImports)
        .where(eq(analyticsImports.gameId, input.gameId))
        .orderBy(desc(analyticsImports.importedAt))
        .limit(30)
      const latest = new Map<AnalyticsImportKind, (typeof imports)[number]>()
      for (const item of imports) if (!latest.has(item.kind)) latest.set(item.kind, item)

      const daily = latest.get('utm_daily')
      const country = latest.get('utm_country')
      const traffic = latest.get('steam_traffic')
      const dailyRows = rowsOf<UtmMetricRow>(daily?.rowsJson).filter(
        (row) =>
          !row.date || ((!input.dateFrom || row.date >= input.dateFrom) && (!input.dateTo || row.date <= input.dateTo)),
      )
      const utm = summarizeUtm(dailyRows)

      const trafficRows = rowsOf<SteamTrafficRow>(traffic?.rowsJson)
      const external = trafficRows
        .filter((row) => steamTrafficBucket(row.category) === 'external')
        .sort((a, b) => b.visits - a.visits)
        .slice(0, 8)
      const discovery = trafficRows
        .filter((row) => steamTrafficBucket(row.category) === 'discovery')
        .sort((a, b) => b.visits - a.visits)
        .slice(0, 8)
      const botVisits = trafficRows
        .filter((row) => steamTrafficBucket(row.category) === 'bots')
        .reduce((sum, row) => sum + row.visits, 0)

      const countries = new Map<
        string,
        { country: string; trustedVisits: number; trackedVisits: number; wishlists: number }
      >()
      for (const row of rowsOf<UtmMetricRow>(country?.rowsJson)) {
        if (!row.country) continue
        const current = countries.get(row.country) ?? {
          country: row.country,
          trustedVisits: 0,
          trackedVisits: 0,
          wishlists: 0,
        }
        current.trustedVisits += row.trustedVisits
        current.trackedVisits += row.trackedVisits
        current.wishlists += row.wishlists
        countries.set(row.country, current)
      }

      const meta = (item: (typeof imports)[number] | undefined) =>
        item
          ? {
              filename: item.filename,
              dateFrom: item.dateFrom,
              dateTo: item.dateTo,
              rows: item.rows,
              importedAt: item.importedAt,
            }
          : null

      return {
        utm,
        traffic: { external, discovery, botVisits },
        countries: [...countries.values()]
          .sort((a, b) => b.wishlists - a.wishlists || b.trustedVisits - a.trustedVisits)
          .slice(0, 8),
        imports: {
          utmDaily: meta(daily),
          utmCountry: meta(country),
          steamTraffic: meta(traffic),
        },
      }
    }),
})
