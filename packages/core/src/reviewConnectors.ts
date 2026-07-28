import { createHash } from 'node:crypto'
import { load, type CheerioAPI } from 'cheerio'

export const REVIEW_PLATFORMS = [
  'steam_reviews',
  'google_play_reviews',
  'itch_comments',
  'gamejolt_comments',
  'poki_comments',
  'crazygames_comments',
  'incrementaldb_comments',
] as const

export type ReviewPlatform = (typeof REVIEW_PLATFORMS)[number]

export interface RemoteInboxComment {
  externalId: string
  kind: 'review' | 'comment'
  authorName: string | null
  authorUrl: string | null
  body: string
  rating: number | null
  language: string | null
  url: string
  publishedAt: string
  updatedAt: string | null
  developerReply: string | null
  developerRepliedAt: string | null
}

export const isReviewPlatform = (value: string): value is ReviewPlatform =>
  REVIEW_PLATFORMS.includes(value as ReviewPlatform)

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36 MarCat/0.3'

const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value == null ? '' : String(value).trim()

const isoDate = (value: unknown, fallback = new Date().toISOString()): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1_000
    const date = new Date(millis)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  const text = clean(value)
  if (/^\d{10,13}$/.test(text)) return isoDate(Number(text), fallback)
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

const absoluteUrl = (href: string, baseUrl: string): string => {
  try {
    return new URL(href || baseUrl, baseUrl).toString()
  } catch {
    return baseUrl
  }
}

const stableId = (...parts: unknown[]): string =>
  createHash('sha256').update(parts.map(clean).join('\u241f')).digest('hex').slice(0, 32)

const numberOf = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const match = clean(value)
      .replace(',', '.')
      .match(/(?:^|\s)([0-5](?:\.\d+)?)(?:\s|$)/)
    if (match) return Number(match[1])
  }
  return null
}

async function getText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
      },
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${clean(body).slice(0, 240)}`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

function steamAppId(target: string): string {
  const value = target.trim()
  const match = value.match(/(?:\/app\/|^)(\d{3,})(?:\/|$)/)
  if (!match) throw new Error('Укажите Steam App ID или ссылку вида https://store.steampowered.com/app/123456/')
  return match[1]!
}

interface SteamReview {
  recommendationid?: string
  review?: string
  timestamp_created?: number
  timestamp_updated?: number
  voted_up?: boolean
  language?: string
  developer_response?: string
  timestamp_dev_responded?: number
  author?: { steamid?: string }
}

interface SteamReviewsResponse {
  success?: number
  cursor?: string
  reviews?: SteamReview[]
}

async function fetchSteamReviews(target: string): Promise<RemoteInboxComment[]> {
  const appId = steamAppId(target)
  const storeUrl = `https://store.steampowered.com/app/${appId}/`
  const items: RemoteInboxComment[] = []
  let cursor = '*'
  for (let page = 0; page < 5; page++) {
    const endpoint = new URL(`https://store.steampowered.com/appreviews/${appId}`)
    endpoint.searchParams.set('json', '1')
    endpoint.searchParams.set('filter', 'updated')
    endpoint.searchParams.set('language', 'all')
    endpoint.searchParams.set('review_type', 'all')
    endpoint.searchParams.set('purchase_type', 'all')
    endpoint.searchParams.set('num_per_page', '100')
    endpoint.searchParams.set('cursor', cursor)
    const parsed = JSON.parse(await getText(endpoint.toString())) as SteamReviewsResponse
    const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : []
    for (const review of reviews) {
      const body = clean(review.review)
      if (!body) continue
      const externalId =
        clean(review.recommendationid) || stableId(review.author?.steamid, review.timestamp_created, body)
      items.push({
        externalId,
        kind: 'review',
        authorName: review.author?.steamid ? `Steam ${review.author.steamid}` : null,
        authorUrl: review.author?.steamid ? `https://steamcommunity.com/profiles/${review.author.steamid}` : null,
        body,
        rating: review.voted_up === true ? 5 : review.voted_up === false ? 1 : null,
        language: clean(review.language) || null,
        url: `${storeUrl}#app_reviews_hash`,
        publishedAt: isoDate(review.timestamp_created),
        updatedAt: review.timestamp_updated ? isoDate(review.timestamp_updated) : null,
        developerReply: clean(review.developer_response) || null,
        developerRepliedAt: review.timestamp_dev_responded ? isoDate(review.timestamp_dev_responded) : null,
      })
    }
    const next = clean(parsed.cursor)
    if (!reviews.length || !next || next === cursor) break
    cursor = next
  }
  return items
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)

function recordText(record: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && clean(value)) return clean(value)
    if (isRecord(value) && typeof value.name === 'string') return clean(value.name)
  }
  return ''
}

function structuredFeedback($: CheerioAPI, pageUrl: string): RemoteInboxComment[] {
  const found: RemoteInboxComment[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!isRecord(value)) return
    const type = clean(value['@type']).toLowerCase()
    if (type === 'review' || type === 'comment') {
      const body = recordText(value, 'reviewBody', 'text', 'description')
      if (body) {
        const authorValue = value.author
        const author = isRecord(authorValue) ? recordText(authorValue, 'name') : clean(authorValue)
        const ratingValue = isRecord(value.reviewRating) ? value.reviewRating.ratingValue : value.ratingValue
        const publishedAt = isoDate(value.datePublished ?? value.dateCreated)
        const url = absoluteUrl(recordText(value, 'url') || pageUrl, pageUrl)
        found.push({
          externalId: recordText(value, '@id', 'identifier') || stableId(author, publishedAt, body),
          kind: type === 'review' ? 'review' : 'comment',
          authorName: author || null,
          authorUrl: isRecord(authorValue) ? absoluteUrl(recordText(authorValue, 'url'), pageUrl) : null,
          body,
          rating: numberOf(ratingValue),
          language: recordText(value, 'inLanguage') || null,
          url,
          publishedAt,
          updatedAt: value.dateModified ? isoDate(value.dateModified) : null,
          developerReply: null,
          developerRepliedAt: null,
        })
      }
    }
    Object.values(value).forEach(visit)
  }
  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      visit(JSON.parse($(element).text()))
    } catch {
      // Invalid third-party JSON-LD should not prevent the platform parser.
    }
  })
  return found
}

interface HtmlSelectorSet {
  blocks: string
  body: string
  author: string
  authorLink: string
  date: string
  rating?: string
  reply?: string
  kind: 'review' | 'comment'
}

const HTML_SELECTORS: Record<Exclude<ReviewPlatform, 'steam_reviews'>, HtmlSelectorSet> = {
  google_play_reviews: {
    blocks: '.RHo1pe, [data-review-id]',
    body: '.h3YV2d, [jsname="fbQN7e"], [data-review-body]',
    author: '.X5PpBb, [data-review-author]',
    authorLink: 'a[href*="/store/people/details"]',
    date: '.bp9Aid, time',
    rating: '.iXRFPc, [role="img"][aria-label*="star"], [data-rating]',
    reply: '.ras4vb, [data-developer-reply]',
    kind: 'review',
  },
  itch_comments: {
    blocks: '.community_post, .post_grid, [data-post-id]',
    body: '.post_body, .post_content, [data-post-body]',
    author: '.post_header .user_link, .user_link, [data-post-author]',
    authorLink: '.user_link[href], a[href*="itch.io/profile/"]',
    date: 'abbr.timeago, time, .post_date',
    reply: '.post_reply.developer, [data-developer-reply]',
    kind: 'comment',
  },
  gamejolt_comments: {
    blocks: '[data-comment-id], .comment, [class*="comment-item"]',
    body: '[data-comment-content], .comment-content, .comment-text, [class*="comment-content"]',
    author: '[data-comment-author], .user-card-meta-name, .comment-author',
    authorLink: 'a[href^="/@"], a[href*="gamejolt.com/@"]',
    date: 'time, [data-timestamp]',
    rating: '[data-rating], [aria-label*="star"]',
    reply: '[data-developer-reply], .developer-reply',
    kind: 'comment',
  },
  poki_comments: {
    blocks: '[data-review-id], .review, [class*="review-card"], [class*="comment"]',
    body: '[data-review-body], .review-body, .review-text, [class*="comment-text"]',
    author: '[data-review-author], .review-author, [class*="author"]',
    authorLink: 'a[href]',
    date: 'time, [data-date]',
    rating: '[data-rating], [aria-label*="star"]',
    reply: '[data-developer-reply], .developer-reply',
    kind: 'review',
  },
  crazygames_comments: {
    blocks: '[data-review-id], .review, [class*="review-card"], [class*="comment"]',
    body: '[data-review-body], .review-body, .review-text, [class*="comment-text"]',
    author: '[data-review-author], .review-author, [class*="author"]',
    authorLink: 'a[href]',
    date: 'time, [data-date]',
    rating: '[data-rating], [aria-label*="star"]',
    reply: '[data-developer-reply], .developer-reply',
    kind: 'review',
  },
  incrementaldb_comments: {
    blocks: '[data-comment-id], [data-review-id], .comment, .review, [class*="comment-card"]',
    body: '[data-comment-body], [data-review-body], .comment-body, .review-body, [class*="comment-text"]',
    author: '[data-comment-author], [data-review-author], .comment-author, .review-author',
    authorLink: 'a[href]',
    date: 'time, [data-date], [data-timestamp]',
    rating: '[data-rating], [aria-label*="star"]',
    reply: '[data-developer-reply], .developer-reply',
    kind: 'comment',
  },
}

function selectedText(root: ReturnType<CheerioAPI>, selector: string): string {
  return clean(root.find(selector).first().text())
}

function selectedAttr(root: ReturnType<CheerioAPI>, selector: string, ...attributes: string[]): string {
  const element = root.find(selector).first()
  for (const attribute of attributes) {
    const value = clean(element.attr(attribute))
    if (value) return value
  }
  return ''
}

function selectorFeedback(platform: Exclude<ReviewPlatform, 'steam_reviews'>, $: CheerioAPI, pageUrl: string) {
  const config = HTML_SELECTORS[platform]
  const found: RemoteInboxComment[] = []
  $(config.blocks).each((_index, element) => {
    const root = $(element)
    const body = selectedText(root, config.body)
    if (!body || body.length < 2) return
    const author = selectedText(root, config.author)
    const rawDate =
      selectedAttr(root, config.date, 'datetime', 'title', 'data-timestamp') || selectedText(root, config.date)
    const publishedAt = isoDate(rawDate)
    const href = selectedAttr(root, 'a[href*="#"], a[href*="/post/"], a[href*="/review/"]', 'href')
    const itemUrl = absoluteUrl(href || pageUrl, pageUrl)
    const id =
      clean(root.attr('data-review-id')) ||
      clean(root.attr('data-comment-id')) ||
      clean(root.attr('data-post-id')) ||
      selectedAttr(
        root,
        '[data-review-id], [data-comment-id], [data-post-id]',
        'data-review-id',
        'data-comment-id',
        'data-post-id',
      ) ||
      clean(root.attr('id')) ||
      stableId(platform, author, rawDate, body)
    const ratingText = config.rating
      ? selectedAttr(root, config.rating, 'data-rating', 'aria-label', 'title') || selectedText(root, config.rating)
      : ''
    const reply = config.reply ? selectedText(root, config.reply) : ''
    const authorHref = selectedAttr(root, config.authorLink, 'href')
    found.push({
      externalId: id,
      kind: config.kind,
      authorName: author || null,
      authorUrl: authorHref ? absoluteUrl(authorHref, pageUrl) : null,
      body,
      rating: numberOf(ratingText),
      language: null,
      url: itemUrl,
      publishedAt,
      updatedAt: null,
      developerReply: reply || null,
      developerRepliedAt: null,
    })
  })
  return found
}

function normalizeTarget(platform: Exclude<ReviewPlatform, 'steam_reviews'>, target: string): string {
  const value = target.trim()
  if (!value) throw new Error('Укажите публичную страницу игры или приложения')
  if (platform === 'google_play_reviews' && !/^https?:\/\//i.test(value)) {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(value)}&hl=en&gl=US`
  }
  if (!/^https?:\/\//i.test(value)) return `https://${value}`
  const url = new URL(value)
  if (platform === 'google_play_reviews') {
    url.searchParams.set('hl', 'en')
    url.searchParams.set('gl', 'US')
  }
  return url.toString()
}

function dedupe(items: RemoteInboxComment[]): RemoteInboxComment[] {
  const byId = new Map<string, RemoteInboxComment>()
  for (const item of items) {
    if (!item.body) continue
    const existing = byId.get(item.externalId)
    if (!existing || item.body.length > existing.body.length) byId.set(item.externalId, item)
  }
  return [...byId.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
}

async function fetchHtmlFeedback(
  platform: Exclude<ReviewPlatform, 'steam_reviews'>,
  target: string,
): Promise<RemoteInboxComment[]> {
  const pageUrl = normalizeTarget(platform, target)
  const html = await getText(pageUrl)
  return parseReviewPageHtml(platform, pageUrl, html)
}

/** Pure parser kept public for fixtures and connector maintenance. */
export function parseReviewPageHtml(
  platform: Exclude<ReviewPlatform, 'steam_reviews'>,
  pageUrl: string,
  html: string,
): RemoteInboxComment[] {
  const $ = load(html)
  return dedupe([...structuredFeedback($, pageUrl), ...selectorFeedback(platform, $, pageUrl)])
}

/** Deterministic feedback import: documented JSON where available, otherwise DOM/JSON-LD parsing. */
export async function fetchReviewItems(platform: ReviewPlatform, target: string): Promise<RemoteInboxComment[]> {
  if (platform === 'steam_reviews') return dedupe(await fetchSteamReviews(target))
  return fetchHtmlFeedback(platform, target)
}
