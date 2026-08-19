import { parseCsv, parseIntLoose } from './util/csv'

export type AnalyticsImportKind = 'utm_daily' | 'utm_country' | 'steam_traffic'

export interface UtmMetricRow {
  date: string | null
  source: string
  campaign: string
  medium: string
  content: string
  term: string
  country: string | null
  device: string | null
  visits: number
  trustedVisits: number
  trackedVisits: number
  returningVisits: number
  wishlists: number
  purchases: number
  activations: number
}

export interface SteamTrafficRow {
  category: string
  feature: string
  impressions: number
  visits: number
}

export type AnalyticsMetricRow = UtmMetricRow | SteamTrafficRow

const normalized = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.join('') ?? ''

const canonicalDimension = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')

export interface CampaignDimensions {
  source: string
  campaign: string
  medium: string
  content: string
  term?: string | null
}

/** Stable identity for an imported UTM tuple; preserves punctuation while normalising casing and whitespace. */
export function campaignKeyOf(value: CampaignDimensions): string {
  return [value.source, value.campaign, value.medium, value.content, value.term ?? '']
    .map(canonicalDimension)
    .join('\u001f')
}

function header(headers: string[], candidates: string[]): string | undefined {
  const wanted = new Set(candidates.map(normalized))
  return headers.find((value) => wanted.has(normalized(value)))
}

function datesFromFilename(filename?: string): { dateFrom: string | null; dateTo: string | null } {
  const match = filename?.match(/_(\d{8})_(\d{8})(?:_|\.)/)
  const iso = (raw: string) => `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  return match ? { dateFrom: iso(match[1]!), dateTo: iso(match[2]!) } : { dateFrom: null, dateTo: null }
}

/** Detect and normalize the three Steam traffic CSV formats Analytics accepts. */
export function parseAnalyticsCsv(
  csv: string,
  filename?: string,
): {
  kind: AnalyticsImportKind
  dateFrom: string | null
  dateTo: string | null
  rows: AnalyticsMetricRow[]
  warnings: string[]
} {
  const { headers, rows } = parseCsv(csv)
  const warnings: string[] = []
  const warn = (message: string) => {
    if (warnings.length < 20) warnings.push(message)
  }
  const count = (row: Record<string, string>, key: string | undefined, rowNumber: number, label: string) => {
    if (!key) return 0
    const raw = row[key]
    const value = parseIntLoose(raw)
    if (raw?.trim() && value == null) warn(`Row ${rowNumber}: ${label} is not a valid integer.`)
    return value ?? 0
  }
  const dateKey = header(headers, ['Date', 'Дата'])
  const sourceKey = header(headers, ['Source', 'Источник'])
  const countryKey = header(headers, ['Country', 'Страна'])
  const visitsKey = header(headers, ['Visits (GMT)', 'Visits', 'Посещения (время по Гринвичу)', 'Посещений'])
  const trustedKey = header(headers, ['Trusted Visits', 'Проверенные посещения'])
  const trackedKey = header(headers, ['Tracked Visits', 'Отслеживаемые посещения'])
  const categoryKey = header(headers, ['Page / Category', 'Страница / Категория'])
  const featureKey = header(headers, ['Page / Feature', 'Страница / Раздел'])
  const impressionsKey = header(headers, ['Impressions', 'Показов'])

  if (categoryKey && featureKey && impressionsKey && visitsKey) {
    const range = datesFromFilename(filename)
    return {
      kind: 'steam_traffic',
      ...range,
      rows: rows.map(
        (row, index) =>
          ({
            category: row[categoryKey]?.trim() ?? '',
            feature: row[featureKey]?.trim() ?? '',
            impressions: count(row, impressionsKey, index + 2, impressionsKey),
            visits: count(row, visitsKey, index + 2, visitsKey),
          }) satisfies SteamTrafficRow,
      ),
      warnings,
    }
  }

  if (sourceKey && visitsKey && trustedKey && trackedKey && (dateKey || countryKey)) {
    const campaignKey = header(headers, ['Campaign', 'Кампания'])
    const mediumKey = header(headers, ['Medium', 'Средство'])
    const contentKey = header(headers, ['Content', 'Контент'])
    const termKey = header(headers, ['Term', 'Keyword', 'Ключевое слово'])
    const deviceKey = header(headers, ['Device Type', 'Тип устройства'])
    const returningKey = header(headers, ['Returning Visits', 'Повторные посещения'])
    const wishlistsKey = header(headers, ['Wishlists', 'Добавления в желаемое'])
    const purchasesKey = header(headers, ['Purchases', 'Покупки'])
    const activationsKey = header(headers, ['Activations', 'Активации'])
    const normalizedRows: UtmMetricRow[] = rows.map((row, index) => ({
      date: dateKey ? row[dateKey]?.trim() || null : null,
      source: row[sourceKey]?.trim() ?? '',
      campaign: campaignKey ? (row[campaignKey]?.trim() ?? '') : '',
      medium: mediumKey ? (row[mediumKey]?.trim() ?? '') : '',
      content: contentKey ? (row[contentKey]?.trim() ?? '') : '',
      term: termKey ? (row[termKey]?.trim() ?? '') : '',
      country: countryKey ? row[countryKey]?.trim() || null : null,
      device: deviceKey ? row[deviceKey]?.trim() || null : null,
      visits: count(row, visitsKey, index + 2, visitsKey),
      trustedVisits: count(row, trustedKey, index + 2, trustedKey),
      trackedVisits: count(row, trackedKey, index + 2, trackedKey),
      returningVisits: count(row, returningKey, index + 2, returningKey ?? 'Returning Visits'),
      wishlists: count(row, wishlistsKey, index + 2, wishlistsKey ?? 'Wishlists'),
      purchases: count(row, purchasesKey, index + 2, purchasesKey ?? 'Purchases'),
      activations: count(row, activationsKey, index + 2, activationsKey ?? 'Activations'),
    }))
    const dates = normalizedRows
      .map((row) => row.date)
      .filter((value): value is string => Boolean(value))
      .sort()
    const range = datesFromFilename(filename)
    return {
      kind: dateKey ? 'utm_daily' : 'utm_country',
      dateFrom: dates.at(0) ?? range.dateFrom,
      dateTo: dates.at(-1) ?? range.dateTo,
      rows: normalizedRows,
      warnings,
    }
  }

  throw new Error('This CSV is not a Steam traffic or UTM Analytics export.')
}

export type SteamTrafficBucket = 'external' | 'country' | 'bots' | 'discovery'

/** Normalize localized Steam traffic categories into stable analytics buckets. */
export function steamTrafficBucket(category: string): SteamTrafficBucket {
  const value = normalized(category)
  if (['externalwebsite', 'стороннийсайт'].includes(value)) return 'external'
  if (['country', 'страна'].includes(value)) return 'country'
  if (['bottraffic', 'трафикботов'].includes(value)) return 'bots'
  return 'discovery'
}

export interface CampaignPerformance {
  key: string
  source: string
  campaign: string
  medium: string
  content: string
  term: string
  visits: number
  trustedVisits: number
  trackedVisits: number
  returningVisits: number
  wishlists: number
  purchases: number
  activations: number
  trackedCoverage: number | null
  conversion: number | null
  conversionLowerBound: number | null
  effectiveYield: number | null
  evidence: 'confirmed' | 'traffic' | 'weak'
}

export function summarizeUtm(rows: UtmMetricRow[]) {
  const grouped = new Map<string, CampaignPerformance>()
  for (const row of rows) {
    const key = campaignKeyOf(row)
    const current = grouped.get(key) ?? {
      key,
      source: row.source,
      campaign: row.campaign,
      medium: row.medium,
      content: row.content,
      term: row.term ?? '',
      visits: 0,
      trustedVisits: 0,
      trackedVisits: 0,
      returningVisits: 0,
      wishlists: 0,
      purchases: 0,
      activations: 0,
      trackedCoverage: null,
      conversion: null,
      conversionLowerBound: null,
      effectiveYield: null,
      evidence: 'weak' as const,
    }
    current.visits += row.visits
    current.trustedVisits += row.trustedVisits
    current.trackedVisits += row.trackedVisits
    current.returningVisits += row.returningVisits
    current.wishlists += row.wishlists
    current.purchases += row.purchases
    current.activations += row.activations
    grouped.set(key, current)
  }
  const campaigns = [...grouped.values()].map((row) => ({
    ...row,
    trackedCoverage: row.trustedVisits ? row.trackedVisits / row.trustedVisits : null,
    conversion: row.trackedVisits ? row.wishlists / row.trackedVisits : null,
    conversionLowerBound: row.trackedVisits ? wilsonLowerBound(row.wishlists, row.trackedVisits) : null,
    effectiveYield: row.trustedVisits ? row.wishlists / row.trustedVisits : null,
    evidence:
      row.wishlists > 0 ? ('confirmed' as const) : row.trackedVisits >= 10 ? ('traffic' as const) : ('weak' as const),
  }))
  campaigns.sort((a, b) => b.wishlists - a.wishlists || b.trustedVisits - a.trustedVisits)
  const totals = campaigns.reduce(
    (sum, row) => ({
      visits: sum.visits + row.visits,
      trustedVisits: sum.trustedVisits + row.trustedVisits,
      trackedVisits: sum.trackedVisits + row.trackedVisits,
      returningVisits: sum.returningVisits + row.returningVisits,
      wishlists: sum.wishlists + row.wishlists,
      purchases: sum.purchases + row.purchases,
      activations: sum.activations + row.activations,
    }),
    { visits: 0, trustedVisits: 0, trackedVisits: 0, returningVisits: 0, wishlists: 0, purchases: 0, activations: 0 },
  )
  return {
    campaigns,
    totals: {
      ...totals,
      trackedCoverage: totals.trustedVisits ? totals.trackedVisits / totals.trustedVisits : null,
      conversion: totals.trackedVisits ? totals.wishlists / totals.trackedVisits : null,
      effectiveYield: totals.trustedVisits ? totals.wishlists / totals.trustedVisits : null,
    },
  }
}

/** Conservative conversion estimate so tiny samples such as 2/2 do not outrank mature campaigns. */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number | null {
  if (total <= 0) return null
  const p = Math.min(total, Math.max(0, successes)) / total
  const denominator = 1 + (z * z) / total
  const centre = p + (z * z) / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)
  return Math.max(0, (centre - margin) / denominator)
}

export type CampaignHighlightKind = 'scale_winner' | 'efficient_candidate' | 'tracking_gap'

export interface CampaignHighlight {
  kind: CampaignHighlightKind
  campaignKey: string
  source: string
  campaign: string
  content: string
  wishlists: number
  trustedVisits: number
  trackedVisits: number
  trackedCoverage: number | null
  conversion: number | null
  confidence: 'high' | 'medium' | 'low'
}

export interface ManagedCampaignPlan {
  id: string
  name: string
  objective: 'wishlist_growth' | 'traffic' | 'sales' | 'awareness'
  status: 'planned' | 'active' | 'completed' | 'archived'
  plannedStart: string | null
  plannedEnd: string | null
  evaluationWindowDays: number
  budgetCents: number | null
  spendCents: number | null
  currency: string
  notes: string | null
}

export interface ManagedCampaignTouchpoint extends CampaignDimensions {
  id: string
  campaignId: string
  canonicalKey: string
  eventId: string | null
}

/** Aggregate several UTM creatives/touchpoints into one decision and economics unit. */
export function summarizeManagedCampaigns(
  plans: ManagedCampaignPlan[],
  touchpoints: ManagedCampaignTouchpoint[],
  performances: CampaignPerformance[],
  economicsComparable: boolean,
) {
  const performanceByKey = new Map(performances.map((row) => [row.key, row]))
  return plans.map((plan) => {
    const linked = touchpoints.filter((touchpoint) => touchpoint.campaignId === plan.id)
    const rows = linked
      .map((touchpoint) => performanceByKey.get(touchpoint.canonicalKey))
      .filter(Boolean) as CampaignPerformance[]
    const totals = rows.reduce(
      (sum, row) => ({
        visits: sum.visits + row.visits,
        trustedVisits: sum.trustedVisits + row.trustedVisits,
        trackedVisits: sum.trackedVisits + row.trackedVisits,
        returningVisits: sum.returningVisits + row.returningVisits,
        wishlists: sum.wishlists + row.wishlists,
        purchases: sum.purchases + row.purchases,
        activations: sum.activations + row.activations,
      }),
      { visits: 0, trustedVisits: 0, trackedVisits: 0, returningVisits: 0, wishlists: 0, purchases: 0, activations: 0 },
    )
    return {
      ...plan,
      touchpoints: linked,
      performance: {
        ...totals,
        trackedCoverage: totals.trustedVisits ? totals.trackedVisits / totals.trustedVisits : null,
        conversion: totals.trackedVisits ? totals.wishlists / totals.trackedVisits : null,
        effectiveYield: totals.trustedVisits ? totals.wishlists / totals.trustedVisits : null,
      },
      economicsComparable,
      costPerWishlistCents:
        economicsComparable && plan.spendCents != null && totals.wishlists > 0
          ? plan.spendCents / totals.wishlists
          : null,
      budgetUtilization:
        plan.budgetCents != null && plan.budgetCents > 0 && plan.spendCents != null
          ? plan.spendCents / plan.budgetCents
          : null,
    }
  })
}

/** Select a small decision queue rather than repeating the entire campaign table as cards. */
export function buildCampaignHighlights(campaigns: CampaignPerformance[]): CampaignHighlight[] {
  const result: CampaignHighlight[] = []
  const unused = (row: CampaignPerformance) => !result.some((item) => item.campaignKey === row.key)
  const add = (kind: CampaignHighlightKind, row: CampaignPerformance | undefined) => {
    if (!row || result.some((item) => item.kind === kind || item.campaignKey === row.key)) return
    result.push({
      kind,
      campaignKey: row.key,
      source: row.source,
      campaign: row.campaign,
      content: row.content,
      wishlists: row.wishlists,
      trustedVisits: row.trustedVisits,
      trackedVisits: row.trackedVisits,
      trackedCoverage: row.trackedCoverage,
      conversion: row.conversion,
      confidence: row.trackedVisits >= 30 ? 'high' : row.trackedVisits >= 10 ? 'medium' : 'low',
    })
  }

  add(
    'scale_winner',
    campaigns.find((row) => row.wishlists > 0),
  )
  add(
    'efficient_candidate',
    campaigns
      .filter((row) => unused(row) && row.trackedVisits >= 10 && row.wishlists > 0)
      .sort((a, b) => (b.conversionLowerBound ?? -1) - (a.conversionLowerBound ?? -1) || b.wishlists - a.wishlists)[0],
  )
  add(
    'tracking_gap',
    campaigns
      .filter((row) => unused(row) && row.trustedVisits >= 10 && row.trackedCoverage != null)
      .sort((a, b) => (a.trackedCoverage ?? 1) - (b.trackedCoverage ?? 1) || b.trustedVisits - a.trustedVisits)[0],
  )
  return result
}
