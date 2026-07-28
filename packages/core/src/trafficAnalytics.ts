import { parseCsv, parseIntLoose } from './util/csv'

export type AnalyticsImportKind = 'utm_daily' | 'utm_country' | 'steam_traffic'

export interface UtmMetricRow {
  date: string | null
  source: string
  campaign: string
  medium: string
  content: string
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
} {
  const { headers, rows } = parseCsv(csv)
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
        (row) =>
          ({
            category: row[categoryKey]?.trim() ?? '',
            feature: row[featureKey]?.trim() ?? '',
            impressions: parseIntLoose(row[impressionsKey]) ?? 0,
            visits: parseIntLoose(row[visitsKey]) ?? 0,
          }) satisfies SteamTrafficRow,
      ),
    }
  }

  if (sourceKey && visitsKey && trustedKey && trackedKey && (dateKey || countryKey)) {
    const campaignKey = header(headers, ['Campaign', 'Кампания'])
    const mediumKey = header(headers, ['Medium', 'Средство'])
    const contentKey = header(headers, ['Content', 'Контент'])
    const deviceKey = header(headers, ['Device Type', 'Тип устройства'])
    const returningKey = header(headers, ['Returning Visits', 'Повторные посещения'])
    const wishlistsKey = header(headers, ['Wishlists', 'Добавления в желаемое'])
    const purchasesKey = header(headers, ['Purchases', 'Покупки'])
    const activationsKey = header(headers, ['Activations', 'Активации'])
    const normalizedRows: UtmMetricRow[] = rows.map((row) => ({
      date: dateKey ? row[dateKey]?.trim() || null : null,
      source: row[sourceKey]?.trim() ?? '',
      campaign: campaignKey ? (row[campaignKey]?.trim() ?? '') : '',
      medium: mediumKey ? (row[mediumKey]?.trim() ?? '') : '',
      content: contentKey ? (row[contentKey]?.trim() ?? '') : '',
      country: countryKey ? row[countryKey]?.trim() || null : null,
      device: deviceKey ? row[deviceKey]?.trim() || null : null,
      visits: parseIntLoose(row[visitsKey]) ?? 0,
      trustedVisits: parseIntLoose(row[trustedKey]) ?? 0,
      trackedVisits: parseIntLoose(row[trackedKey]) ?? 0,
      returningVisits: returningKey ? (parseIntLoose(row[returningKey]) ?? 0) : 0,
      wishlists: wishlistsKey ? (parseIntLoose(row[wishlistsKey]) ?? 0) : 0,
      purchases: purchasesKey ? (parseIntLoose(row[purchasesKey]) ?? 0) : 0,
      activations: activationsKey ? (parseIntLoose(row[activationsKey]) ?? 0) : 0,
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
  visits: number
  trustedVisits: number
  trackedVisits: number
  returningVisits: number
  wishlists: number
  trackedCoverage: number | null
  conversion: number | null
  evidence: 'confirmed' | 'traffic' | 'weak'
}

export function summarizeUtm(rows: UtmMetricRow[]) {
  const grouped = new Map<string, CampaignPerformance>()
  for (const row of rows) {
    const key = [row.source, row.campaign, row.medium, row.content].join('\u001f')
    const current = grouped.get(key) ?? {
      key,
      source: row.source,
      campaign: row.campaign,
      medium: row.medium,
      content: row.content,
      visits: 0,
      trustedVisits: 0,
      trackedVisits: 0,
      returningVisits: 0,
      wishlists: 0,
      trackedCoverage: null,
      conversion: null,
      evidence: 'weak' as const,
    }
    current.visits += row.visits
    current.trustedVisits += row.trustedVisits
    current.trackedVisits += row.trackedVisits
    current.returningVisits += row.returningVisits
    current.wishlists += row.wishlists
    grouped.set(key, current)
  }
  const campaigns = [...grouped.values()].map((row) => ({
    ...row,
    trackedCoverage: row.trustedVisits ? row.trackedVisits / row.trustedVisits : null,
    conversion: row.trackedVisits ? row.wishlists / row.trackedVisits : null,
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
    }),
    { visits: 0, trustedVisits: 0, trackedVisits: 0, returningVisits: 0, wishlists: 0 },
  )
  return {
    campaigns,
    totals: {
      ...totals,
      trackedCoverage: totals.trustedVisits ? totals.trackedVisits / totals.trustedVisits : null,
      conversion: totals.trackedVisits ? totals.wishlists / totals.trackedVisits : null,
    },
  }
}
