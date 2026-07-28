const STEAM_TOP_WISHLISTS_URL = 'https://store.steampowered.com/search/?filter=popularwishlist&ignore_preferences=1'
const STEAM_SEARCH_RESULTS_URL = 'https://store.steampowered.com/search/results/'
const TOP_LIMIT = 1_000
const PAGE_SIZE = 100
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000

interface SteamSearchResponse {
  success?: number
  results_html?: string
}

interface CachedRanking {
  appIds: Array<number | null>
  checkedAt: string
  expiresAt: number
}

export interface SteamWishlistRank {
  rank: number | null
  limit: number
  checkedAt: string
  sourceUrl: string
  stale: boolean
}

let cachedRanking: CachedRanking | null = null
let rankingRequest: Promise<CachedRanking> | null = null

/**
 * Read Steam search rows without depending on their presentational markup.
 * Non-app rows are retained as nulls because they still occupy a position in
 * the public ranking.
 */
export function parseSteamWishlistRows(html: string): Array<number | null> {
  const rows = html.match(/<a\b[^>]*>/gi) ?? []
  return rows
    .filter((tag) => /\bclass=(['"])[^'"]*\bsearch_result_row\b[^'"]*\1/i.test(tag))
    .map((tag) => {
      const itemKey = tag.match(/\bdata-ds-itemkey=(['"])App_(\d+)\1/i)
      if (itemKey?.[2]) return Number(itemKey[2])
      const appId = tag.match(/\bdata-ds-appid=(['"])(\d+)\1/i)
      return appId?.[2] ? Number(appId[2]) : null
    })
}

async function fetchRankingPage(start: number): Promise<Array<number | null>> {
  const url = new URL(STEAM_SEARCH_RESULTS_URL)
  url.search = new URLSearchParams({
    filter: 'popularwishlist',
    ignore_preferences: '1',
    start: String(start),
    count: String(PAGE_SIZE),
    infinite: '1',
    l: 'english',
  }).toString()

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.8',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Steam ranking request failed (${response.status})`)

  const body = (await response.json()) as SteamSearchResponse
  if (body.success !== 1 || typeof body.results_html !== 'string') {
    throw new Error('Steam returned an invalid ranking response')
  }
  const rows = parseSteamWishlistRows(body.results_html)
  if (rows.length === 0) throw new Error('Steam ranking response contained no products')
  return rows
}

async function crawlRanking(): Promise<CachedRanking> {
  const starts = Array.from({ length: TOP_LIMIT / PAGE_SIZE }, (_, index) => index * PAGE_SIZE)
  const pages: Array<Array<number | null>> = new Array(starts.length)
  let nextPage = 0

  // A small worker pool keeps the cold load quick without hitting Steam with
  // all ten requests at once.
  const worker = async () => {
    while (nextPage < starts.length) {
      const index = nextPage++
      pages[index] = await fetchRankingPage(starts[index]!)
    }
  }
  await Promise.all([worker(), worker(), worker()])

  return {
    appIds: pages.flat().slice(0, TOP_LIMIT),
    checkedAt: new Date().toISOString(),
    expiresAt: Date.now() + CACHE_TTL_MS,
  }
}

async function currentRanking(): Promise<{ value: CachedRanking; stale: boolean }> {
  if (cachedRanking && cachedRanking.expiresAt > Date.now()) return { value: cachedRanking, stale: false }

  try {
    rankingRequest ??= crawlRanking()
    cachedRanking = await rankingRequest
    return { value: cachedRanking, stale: false }
  } catch (error) {
    if (cachedRanking) return { value: cachedRanking, stale: true }
    throw error
  } finally {
    rankingRequest = null
  }
}

/** Find an app's position in Steam's public "Top Wishlists" search order. */
export async function getSteamWishlistRank(appId: number): Promise<SteamWishlistRank> {
  const { value, stale } = await currentRanking()
  const index = value.appIds.findIndex((candidate) => candidate === appId)
  return {
    rank: index >= 0 ? index + 1 : null,
    limit: TOP_LIMIT,
    checkedAt: value.checkedAt,
    sourceUrl: STEAM_TOP_WISHLISTS_URL,
    stale,
  }
}
