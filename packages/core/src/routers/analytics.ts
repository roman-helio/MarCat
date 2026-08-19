import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { analyticsImports, campaignTouchpoints, events, marketingCampaigns, wishlistPoints, type DB } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { computeImpact } from '../analytics'
import {
  parseAnalyticsCsv,
  buildCampaignHighlights,
  campaignKeyOf,
  steamTrafficBucket,
  summarizeManagedCampaigns,
  summarizeUtm,
  type AnalyticsImportKind,
  type SteamTrafficRow,
  type UtmMetricRow,
} from '../trafficAnalytics'
import { importWishlistCsv, WISHLIST_COHORT_ERROR } from '../wishlistImport'

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
  const checksum = createHash('sha256').update(csv).digest('hex')
  const existing = await db
    .select({ id: analyticsImports.id })
    .from(analyticsImports)
    .where(and(eq(analyticsImports.gameId, gameId), eq(analyticsImports.checksum, checksum)))
    .limit(1)
  if (existing[0]) {
    return {
      kind: parsed.kind,
      imported: 0,
      dateFrom: parsed.dateFrom,
      dateTo: parsed.dateTo,
      warnings: parsed.warnings,
      provisionalRows: 0,
      duplicate: true,
    }
  }
  await db.insert(analyticsImports).values({
    gameId,
    kind: parsed.kind,
    filename: filename ?? null,
    checksum,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    rows: parsed.rows.length,
    rowsJson: JSON.stringify(parsed.rows),
    warningsJson: JSON.stringify(parsed.warnings),
    parserVersion: 2,
  })
  return {
    kind: parsed.kind,
    imported: parsed.rows.length,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    warnings: parsed.warnings,
    provisionalRows: 0,
    duplicate: false,
  }
}

function addDays(iso: string, days: number): string {
  const value = new Date(`${iso}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const campaignTouchpointInput = z.object({
  source: z.string().max(200),
  campaign: z.string().max(300),
  medium: z.string().max(200),
  content: z.string().max(500),
  term: z.string().max(300).default(''),
  eventId: z.string().nullable().optional(),
})

const campaignPlanInput = z.object({
  id: z.string().optional(),
  gameId: z.string(),
  name: z.string().trim().min(1).max(200),
  objective: z.enum(['wishlist_growth', 'traffic', 'sales', 'awareness']),
  status: z.enum(['planned', 'active', 'completed', 'archived']),
  plannedStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  plannedEnd: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  evaluationWindowDays: z.number().int().min(1).max(60),
  budgetCents: z.number().int().nonnegative().nullable(),
  spendCents: z.number().int().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  notes: z.string().max(4000).nullable(),
  touchpoints: z.array(campaignTouchpointInput).min(1).max(100),
})

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
    .input(
      z.object({
        gameId: z.string(),
        csv: z.string(),
        filename: z.string().optional(),
        fileModifiedAt: z.string().datetime().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        parseAnalyticsCsv(input.csv, input.filename)
      } catch (analyticsError) {
        try {
          const result = await importWishlistCsv(ctx.db, input)
          return {
            kind: 'wishlists' as const,
            imported: result.imported,
            dateFrom: null,
            dateTo: null,
            warnings: result.warnings,
            provisionalRows: result.provisionalRows,
            duplicate: result.duplicate,
          }
        } catch (wishlistError) {
          if (wishlistError instanceof Error && wishlistError.message.includes(WISHLIST_COHORT_ERROR)) {
            throw wishlistError
          }
          const reason = analyticsError instanceof Error ? analyticsError.message : String(analyticsError)
          throw new Error(`CSV format was not recognized. ${reason}`)
        }
      }
      return storeAnalyticsImport(ctx.db, input.gameId, input.csv, input.filename)
    }),

  upsertCampaign: publicProcedure.input(campaignPlanInput).mutation(async ({ ctx, input }) => {
    if (input.plannedStart && input.plannedEnd && input.plannedEnd < input.plannedStart) {
      throw new Error('Campaign end date must not be earlier than its start date.')
    }
    const id = input.id ?? crypto.randomUUID()
    const touchpoints = [
      ...new Map(input.touchpoints.map((touchpoint) => [campaignKeyOf(touchpoint), touchpoint] as const)).entries(),
    ].map(([canonicalKey, touchpoint]) => ({ canonicalKey, touchpoint }))

    await ctx.db.transaction(async (tx) => {
      if (input.id) {
        const existing = await tx
          .select({ id: marketingCampaigns.id })
          .from(marketingCampaigns)
          .where(and(eq(marketingCampaigns.id, input.id), eq(marketingCampaigns.gameId, input.gameId)))
          .limit(1)
        if (!existing[0]) throw new Error('Campaign was not found in this project.')
      }

      const eventIds = [...new Set(touchpoints.map((item) => item.touchpoint.eventId).filter(Boolean))] as string[]
      if (eventIds.length) {
        const matchingEvents = await tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.gameId, input.gameId), inArray(events.id, eventIds)))
        if (matchingEvents.length !== eventIds.length) {
          throw new Error('One of the linked activities does not belong to this project.')
        }
      }

      const keys = touchpoints.map((item) => item.canonicalKey)
      const conflicts = keys.length
        ? await tx
            .select({ campaignId: campaignTouchpoints.campaignId, canonicalKey: campaignTouchpoints.canonicalKey })
            .from(campaignTouchpoints)
            .where(and(eq(campaignTouchpoints.gameId, input.gameId), inArray(campaignTouchpoints.canonicalKey, keys)))
        : []
      const conflict = conflicts.find((item) => item.campaignId !== id)
      if (conflict) throw new Error('One of these UTM touchpoints already belongs to another campaign.')

      const values = {
        gameId: input.gameId,
        name: input.name,
        objective: input.objective,
        status: input.status,
        plannedStart: input.plannedStart,
        plannedEnd: input.plannedEnd,
        evaluationWindowDays: input.evaluationWindowDays,
        budgetCents: input.budgetCents,
        spendCents: input.spendCents,
        currency: input.currency,
        notes: input.notes,
        updatedAt: new Date().toISOString(),
      }
      if (input.id) {
        await tx.update(marketingCampaigns).set(values).where(eq(marketingCampaigns.id, id))
        await tx.delete(campaignTouchpoints).where(eq(campaignTouchpoints.campaignId, id))
      } else {
        await tx.insert(marketingCampaigns).values({ id, ...values })
      }
      await tx.insert(campaignTouchpoints).values(
        touchpoints.map(({ canonicalKey, touchpoint }) => ({
          gameId: input.gameId,
          campaignId: id,
          canonicalKey,
          source: touchpoint.source,
          campaign: touchpoint.campaign,
          medium: touchpoint.medium,
          content: touchpoint.content,
          term: touchpoint.term,
          eventId: touchpoint.eventId ?? null,
        })),
      )
    })
    return { id }
  }),

  overview: publicProcedure
    .input(z.object({ gameId: z.string(), dateFrom: z.string().optional(), dateTo: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const [imports, campaignPlans, campaignPoints] = await Promise.all([
        ctx.db
          .select()
          .from(analyticsImports)
          .where(eq(analyticsImports.gameId, input.gameId))
          .orderBy(desc(analyticsImports.importedAt))
          .limit(30),
        ctx.db
          .select()
          .from(marketingCampaigns)
          .where(eq(marketingCampaigns.gameId, input.gameId))
          .orderBy(desc(marketingCampaigns.updatedAt)),
        ctx.db
          .select()
          .from(campaignTouchpoints)
          .where(eq(campaignTouchpoints.gameId, input.gameId))
          .orderBy(asc(campaignTouchpoints.createdAt)),
      ])
      const latest = new Map<AnalyticsImportKind, (typeof imports)[number]>()
      for (const item of imports) if (!latest.has(item.kind)) latest.set(item.kind, item)

      const daily = latest.get('utm_daily')
      const country = latest.get('utm_country')
      const traffic = latest.get('steam_traffic')
      const dailyRows = rowsOf<UtmMetricRow>(daily?.rowsJson)
      const countryRows = rowsOf<UtmMetricRow>(country?.rowsJson)
      const filteredDailyRows = dailyRows.filter(
        (row) =>
          !row.date || ((!input.dateFrom || row.date >= input.dateFrom) && (!input.dateTo || row.date <= input.dateTo)),
      )
      // Country and daily exports contain the same UTM conversion dimensions, grouped
      // differently. A dated range requires the daily export; all-time analytics should
      // use the most recently imported UTM report instead of silently ignoring a newer
      // country export (which previously left the headline total stale).
      const hasDateRange = Boolean(input.dateFrom || input.dateTo)
      const latestAllTimeUtm = [daily, country]
        .filter((item): item is (typeof imports)[number] => Boolean(item))
        .sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0]
      const selectedUtm = hasDateRange ? daily : latestAllTimeUtm
      const selectedUtmRows = selectedUtm?.kind === 'utm_country' ? countryRows : filteredDailyRows
      const utm = summarizeUtm(selectedUtmRows)
      const campaignNameById = new Map(campaignPlans.map((plan) => [plan.id, plan.name]))
      const campaignIdByKey = new Map(campaignPoints.map((point) => [point.canonicalKey, point.campaignId]))
      const campaignRows = utm.campaigns.map((row) => {
        const managedCampaignId = campaignIdByKey.get(row.key) ?? null
        return {
          ...row,
          managedCampaignId,
          managedCampaignName: managedCampaignId ? (campaignNameById.get(managedCampaignId) ?? null) : null,
        }
      })
      const managedCampaigns = summarizeManagedCampaigns(campaignPlans, campaignPoints, utm.campaigns, !hasDateRange)
      const dailySummary = summarizeUtm(dailyRows)
      const countrySummary = summarizeUtm(countryRows)
      const sameUtmScope = Boolean(
        daily && country && daily.dateFrom === country.dateFrom && daily.dateTo === country.dateTo,
      )
      const reconciliationMetrics = ['visits', 'trustedVisits', 'trackedVisits', 'wishlists'] as const
      const reconciliationDeltas = Object.fromEntries(
        reconciliationMetrics.map((metric) => [metric, countrySummary.totals[metric] - dailySummary.totals[metric]]),
      ) as Record<(typeof reconciliationMetrics)[number], number>
      const reconciliationStatus =
        !daily || !country
          ? ('missing' as const)
          : !sameUtmScope
            ? ('not_comparable' as const)
            : reconciliationMetrics.every((metric) => reconciliationDeltas[metric] === 0)
              ? ('matched' as const)
              : ('mismatch' as const)

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
      for (const row of countryRows) {
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
              warnings: rowsOf<string>(item.warningsJson),
              parserVersion: item.parserVersion,
            }
          : null

      const today = new Date().toISOString().slice(0, 10)
      const latestCompleteDate = selectedUtm?.dateTo ? addDays(selectedUtm.dateTo, -3) : null
      const maturity = !selectedUtm?.dateTo
        ? ('unknown' as const)
        : selectedUtm.dateTo > addDays(today, -3)
          ? ('maturing' as const)
          : ('mature' as const)

      return {
        utm: { ...utm, campaigns: campaignRows, source: meta(selectedUtm) },
        highlights: buildCampaignHighlights(utm.campaigns),
        managedCampaigns,
        traffic: { external, discovery, botVisits },
        countries: [...countries.values()]
          .sort((a, b) => b.wishlists - a.wishlists || b.trustedVisits - a.trustedVisits)
          .slice(0, 8),
        imports: {
          utmDaily: meta(daily),
          utmCountry: meta(country),
          steamTraffic: meta(traffic),
        },
        dataQuality: {
          sourceKind: selectedUtm?.kind ?? null,
          timezone: selectedUtm ? 'GMT' : null,
          maturity,
          latestCompleteDate,
          reconciliation: {
            status: reconciliationStatus,
            sameScope: sameUtmScope,
            deltas: reconciliationDeltas,
          },
          warningCount: [daily, country, traffic]
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
            .reduce((total, item) => total + rowsOf<string>(item.warningsJson).length, 0),
        },
      }
    }),
})
