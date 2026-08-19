import { desc, eq } from 'drizzle-orm'
import { games, settings, wishlistPoints, type DB } from '@marcat/db'

const SIX_HOURS = 6 * 60 * 60 * 1_000
const FETCH_TIMEOUT = 15_000

type Cached<T> = { expiresAt: number; value: T }
const reviewCache = new Map<number, Cached<SteamReviews | null>>()
const criticCache = new Map<string, Cached<CriticScore | null>>()

export interface SteamReviews {
  total: number
  positive: number
  negative: number
  positivePercent: number
  description: string
}

export interface CriticScore {
  provider: 'metacritic' | 'opencritic'
  score: number
  reviewCount: number | null
  url: string
}

export interface SteamSalesSummary {
  netUnits: number | null
  netSalesUsd: number | null
  lastSyncedAt: string | null
  lastError: string | null
}

type SalesDay = Record<string, { netUnits: number; netSalesUsd: number }>
interface FinancialState {
  highwatermark: string
  days: Record<string, SalesDay>
  lastSyncedAt: string | null
  lastError: string | null
}

const FINANCIAL_STATE_KEY = 'steam-financial-sales-v1'
const emptyFinancialState = (): FinancialState => ({
  highwatermark: '0',
  days: {},
  lastSyncedAt: null,
  lastError: null,
})

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MarCat/1.0 storefront metrics' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!response.ok) throw new Error(`Remote service returned HTTP ${response.status}`)
  return response.json()
}

export async function getSteamReviews(appId: number): Promise<SteamReviews | null> {
  const cached = reviewCache.get(appId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const url = new URL(`https://store.steampowered.com/appreviews/${appId}`)
  url.searchParams.set('json', '1')
  url.searchParams.set('language', 'all')
  url.searchParams.set('purchase_type', 'all')
  const json = (await fetchJson(url)) as {
    success?: number
    query_summary?: {
      total_reviews?: number
      total_positive?: number
      total_negative?: number
      review_score_desc?: string
    }
  }
  const summary = json.success === 1 ? json.query_summary : undefined
  const total = Number(summary?.total_reviews ?? 0)
  const value =
    total > 0
      ? {
          total,
          positive: Number(summary?.total_positive ?? 0),
          negative: Number(summary?.total_negative ?? 0),
          positivePercent: Math.round((Number(summary?.total_positive ?? 0) / total) * 100),
          description: summary?.review_score_desc ?? '',
        }
      : null
  reviewCache.set(appId, { value, expiresAt: Date.now() + SIX_HOURS })
  return value
}

function allowedCriticProvider(url: URL): CriticScore['provider'] | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'metacritic.com') return 'metacritic'
  if (host === 'opencritic.com') return 'opencritic'
  return null
}

function findAggregateRating(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAggregateRating(item)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const type = record['@type']
  if (type === 'AggregateRating' || (Array.isArray(type) && type.includes('AggregateRating'))) return record
  for (const item of Object.values(record)) {
    const found = findAggregateRating(item)
    if (found) return found
  }
  return null
}

export function parseCriticScoreHtml(html: string, provider: CriticScore['provider'], url: string): CriticScore | null {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
  let rating: Record<string, unknown> | null = null
  for (const match of scripts) {
    try {
      rating = findAggregateRating(JSON.parse(match[1]!))
      if (rating) break
    } catch {
      // Some pages contain unrelated malformed JSON-LD; keep looking.
    }
  }
  const score = Number(rating?.ratingValue)
  const reviewCount = Number(rating?.reviewCount ?? rating?.ratingCount)
  return Number.isFinite(score)
    ? { provider, score, reviewCount: Number.isFinite(reviewCount) ? reviewCount : null, url }
    : null
}

export async function getCriticScore(rawUrl: string): Promise<CriticScore | null> {
  const parsed = new URL(rawUrl)
  const provider = allowedCriticProvider(parsed)
  if (!provider || parsed.protocol !== 'https:') throw new Error('Unsupported critic score URL')
  const cached = criticCache.get(parsed.href)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const response = await fetch(parsed, {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0 (compatible; MarCat/1.0; +https://github.com/helio-games)',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!response.ok) throw new Error(`Critic service returned HTTP ${response.status}`)
  const html = await response.text()
  const value = parseCriticScoreHtml(html, provider, parsed.href)
  criticCache.set(parsed.href, { value, expiresAt: Date.now() + SIX_HOURS })
  return value
}

async function readFinancialState(db: DB): Promise<FinancialState> {
  const rows = await db.select().from(settings).where(eq(settings.key, FINANCIAL_STATE_KEY)).limit(1)
  try {
    const parsed = JSON.parse(rows[0]?.value ?? '') as Partial<FinancialState>
    return {
      highwatermark: String(parsed.highwatermark ?? '0'),
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      lastSyncedAt: parsed.lastSyncedAt ?? null,
      lastError: parsed.lastError ?? null,
    }
  } catch {
    return emptyFinancialState()
  }
}

async function writeFinancialState(db: DB, state: FinancialState): Promise<void> {
  const updatedAt = new Date().toISOString()
  await db
    .insert(settings)
    .values({ key: FINANCIAL_STATE_KEY, value: JSON.stringify(state), updatedAt })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(state), updatedAt },
    })
}

export async function getSteamSalesSummary(db: DB, appId: number): Promise<SteamSalesSummary> {
  const state = await readFinancialState(db)
  let netUnits = 0
  let netSalesUsd = 0
  for (const day of Object.values(state.days)) {
    netUnits += day[String(appId)]?.netUnits ?? 0
    netSalesUsd += day[String(appId)]?.netSalesUsd ?? 0
  }
  return {
    netUnits: netUnits > 0 ? netUnits : null,
    netSalesUsd: netSalesUsd > 0 ? netSalesUsd : null,
    lastSyncedAt: state.lastSyncedAt,
    lastError: state.lastError,
  }
}

const responseRecord = (value: unknown): Record<string, unknown> => {
  const root = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return root.response && typeof root.response === 'object' ? (root.response as Record<string, unknown>) : root
}

const resultRows = (record: Record<string, unknown>): Record<string, unknown>[] => {
  const value = record.result ?? record.results ?? record.dates
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : []
}

const numberOf = (value: unknown): number => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function summarizeSteamSalesRows(rows: Record<string, unknown>[], configuredAppIds: number[]): SalesDay {
  const appIds = new Set(configuredAppIds)
  const day: SalesDay = {}
  for (const row of rows) {
    if (String(row.line_item_type ?? '').toLowerCase() !== 'package') continue
    if (String(row.package_sale_type ?? '').toLowerCase() !== 'steam') continue
    const appId = numberOf(row.primary_appid)
    if (!appIds.has(appId)) continue
    const key = String(appId)
    const current = day[key] ?? { netUnits: 0, netSalesUsd: 0 }
    current.netUnits += numberOf(row.net_units_sold)
    current.netSalesUsd += numberOf(row.net_sales_usd)
    day[key] = current
  }
  return day
}

let financialSync: Promise<void> | null = null

const nextIsoDate = (date: string): string => {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

async function syncWishlistReporting(db: DB, apiKey: string, configuredGames: { id: string; appId: number | null }[]) {
  const today = new Date().toISOString().slice(0, 10)
  for (const game of configuredGames) {
    if (!game.appId) continue
    const recent = await db
      .select()
      .from(wishlistPoints)
      .where(eq(wishlistPoints.gameId, game.id))
      .orderBy(desc(wishlistPoints.date))
      .limit(2)
    const latest = recent[0]
    if (latest?.balance == null) continue

    const refreshLatestApiDay = latest.source === 'api' && recent[1]?.balance != null
    let date = refreshLatestApiDay ? latest.date : nextIsoDate(latest.date)
    let balance = refreshLatestApiDay ? recent[1]!.balance! : latest.balance

    // A bounded catch-up avoids monopolising the background worker after a long
    // offline period. Each six-hour run continues from the newest stored day.
    for (let day = 0; day < 32 && date <= today; day++, date = nextIsoDate(date)) {
      const url = new URL('https://partner.steam-api.com/IPartnerFinancialsService/GetAppWishlistReporting/v001/')
      url.searchParams.set('key', apiKey)
      url.searchParams.set('appid', String(game.appId))
      url.searchParams.set('date', date)
      const report = responseRecord(await fetchJson(url))
      const summary =
        report.wishlist_summary && typeof report.wishlist_summary === 'object'
          ? (report.wishlist_summary as Record<string, unknown>)
          : null
      if (!summary) break
      const adds = numberOf(summary.wishlist_adds)
      const deletes = numberOf(summary.wishlist_deletes)
      const purchases = numberOf(summary.wishlist_purchases)
      const gifts = numberOf(summary.wishlist_gifts)
      const net = adds - deletes - purchases - gifts
      balance += net
      await db
        .insert(wishlistPoints)
        .values({
          gameId: game.id,
          date,
          adds,
          deletes,
          purchasesAndActivations: purchases,
          gifts,
          net,
          balance,
          source: 'api',
        })
        .onConflictDoUpdate({
          target: [wishlistPoints.gameId, wishlistPoints.date],
          set: { adds, deletes, purchasesAndActivations: purchases, gifts, net, balance, source: 'api' },
        })
    }
  }
}

/** Incrementally imports exact Steam package sales for every configured game. */
export function syncSteamFinancials(db: DB, apiKey: string): Promise<void> {
  if (financialSync) return financialSync
  financialSync = (async () => {
    const state = await readFinancialState(db)
    try {
      const configuredGames = await db.select({ id: games.id, appId: games.steamAppId }).from(games)
      const appIds = configuredGames.map((game) => game.appId).filter((id): id is number => id != null)
      const changedUrl = new URL(
        'https://partner.steam-api.com/IPartnerFinancialsService/GetChangedDatesForPartner/v001/',
      )
      changedUrl.searchParams.set('key', apiKey)
      changedUrl.searchParams.set('highwatermark', state.highwatermark)
      const changed = responseRecord(await fetchJson(changedUrl))
      const dates = Array.isArray(changed.dates) ? changed.dates.map((date) => String(date)).filter(Boolean) : []

      for (const date of dates) {
        const day: SalesDay = {}
        let cursor = '0'
        for (let page = 0; page < 10_000; page++) {
          const detailUrl = new URL('https://partner.steam-api.com/IPartnerFinancialsService/GetDetailedSales/v001/')
          detailUrl.searchParams.set('key', apiKey)
          detailUrl.searchParams.set('date', date)
          detailUrl.searchParams.set('highwatermark_id', cursor)
          const detail = responseRecord(await fetchJson(detailUrl))
          const rows = resultRows(detail)
          const pageSummary = summarizeSteamSalesRows(rows, appIds)
          for (const [appId, summary] of Object.entries(pageSummary)) {
            const current = day[appId] ?? { netUnits: 0, netSalesUsd: 0 }
            current.netUnits += summary.netUnits
            current.netSalesUsd += summary.netSalesUsd
            day[appId] = current
          }
          const nextCursor = String(detail.max_id ?? detail.highwatermark_id ?? cursor)
          if (!rows.length || nextCursor === cursor) break
          cursor = nextCursor
        }
        state.days[date] = day
        await writeFinancialState(db, state)
      }

      state.highwatermark = String(changed.result_highwatermark ?? state.highwatermark)
      state.lastSyncedAt = new Date().toISOString()
      state.lastError = null
      await writeFinancialState(db, state)
      await syncWishlistReporting(db, apiKey, configuredGames)
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
      await writeFinancialState(db, state)
      throw error
    }
  })().finally(() => {
    financialSync = null
  })
  return financialSync
}
