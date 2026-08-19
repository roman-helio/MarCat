import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  apiSpend,
  creatorDiscoveryApiRequests,
  creatorDiscoveryCandidates,
  creatorDiscoveryContacts,
  creatorDiscoveryEvidence,
  creatorDiscoveryRunCandidates,
  creatorDiscoveryRuns,
  providerSettings,
  type DB,
} from '@marcat/db'
import type { DiscoveryProfileSnapshot, DiscoveryReferenceSnapshot } from './youtubeDiscovery'

export type SocialDiscoveryPlatform = 'instagram' | 'tiktok' | 'twitter'

export const SOCIAL_DISCOVERY_PLATFORMS: SocialDiscoveryPlatform[] = ['instagram', 'tiktok', 'twitter']
export const SCRAPECREATORS_CREDIT_USD = 47 / 25_000

const PROVIDER = 'scrapecreators'
const API_BASE = 'https://api.scrapecreators.com'
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 30_000
const WEBSITE_TIMEOUT_MS = 8_000
const WEBSITE_MAX_BYTES = 512 * 1_024
const WEBSITE_MAX_REDIRECTS = 3

type JsonRecord = Record<string, unknown>

type PublicContact = {
  type: 'business_email' | 'website'
  value: string
  normalizedValue: string
  sourceUrl: string
  confidence: number
  gated: boolean
}

type SocialEvidence = {
  reference: DiscoveryReferenceSnapshot
  externalId: string
  title: string
  url: string
  text: string
  publishedAt: string | null
  viewCount: number | null
  matchedTerms: string[]
}

type SocialCandidate = {
  platform: SocialDiscoveryPlatform
  externalId: string
  handle: string
  name: string
  channelUrl: string
  thumbnailUrl: string | null
  description: string
  country: string | null
  language: string | null
  subscriberCount: number | null
  totalViewCount: number | null
  videoCount: number | null
  websiteUrls: string[]
  evidence: SocialEvidence[]
}

type RequestBudget = {
  charged: number
  limit: number
}

export class SocialRequestUncertainError extends Error {
  constructor(readonly endpoint: string) {
    super(`Paid discovery request may have consumed a credit: ${endpoint}`)
  }
}

export class SocialBudgetError extends Error {
  constructor() {
    super('ScrapeCreators daily budget reached')
  }
}

export class SocialRunInterruptedError extends Error {
  constructor(readonly status: 'paused' | 'cancelled') {
    super(`Discovery run ${status}`)
  }
}

class SocialRunLimitError extends Error {
  constructor() {
    super('Creator discovery run credit limit reached')
  }
}

class SocialResponseError extends Error {}

function now(): string {
  return new Date().toISOString()
}

function cacheExpiresAt(): string {
  return new Date(Date.now() + CACHE_TTL_MS).toISOString()
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringOf(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim()
  return ''
}

function numberOf(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
    if (Number.isFinite(parsed)) return Math.round(parsed)
  }
  return null
}

function isoOf(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const numeric = typeof value === 'number' && value < 10_000_000_000 ? value * 1_000 : value
    const date = new Date(numeric)
    if (Number.isFinite(date.getTime())) return date.toISOString()
  }
  return null
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}+#'&.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = normalizeText(phrase)
  return !!needle && (` ${haystack} `.includes(` ${needle} `) || haystack.includes(needle))
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function keyFingerprint(apiKey: string): string {
  return hash(apiKey).slice(0, 16)
}

function requestIdentity(endpoint: string, params: Record<string, string>): string {
  const query = new URLSearchParams(Object.entries(params).sort(([left], [right]) => left.localeCompare(right)))
  return hash(`${endpoint}?${query.toString()}`)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function ensureProviderBudget(db: DB): Promise<void> {
  const [spend] = await db
    .select()
    .from(apiSpend)
    .where(and(eq(apiSpend.provider, PROVIDER), eq(apiSpend.date, today())))
    .limit(1)
  const [settings] = await db.select().from(providerSettings).where(eq(providerSettings.provider, PROVIDER)).limit(1)
  if (settings?.dailyBudgetUsd != null && (spend?.costUsd ?? 0) + SCRAPECREATORS_CREDIT_USD > settings.dailyBudgetUsd) {
    throw new SocialBudgetError()
  }
}

async function addProviderSpend(db: DB, credits: number): Promise<void> {
  if (credits <= 0) return
  const date = today()
  const cost = credits * SCRAPECREATORS_CREDIT_USD
  const [existing] = await db
    .select()
    .from(apiSpend)
    .where(and(eq(apiSpend.provider, PROVIDER), eq(apiSpend.date, date)))
    .limit(1)
  if (existing) {
    await db
      .update(apiSpend)
      .set({
        requests: sql`${apiSpend.requests} + ${credits}`,
        costUsd: sql`${apiSpend.costUsd} + ${cost}`,
      })
      .where(eq(apiSpend.id, existing.id))
  } else {
    await db.insert(apiSpend).values({ provider: PROVIDER, date, requests: credits, costUsd: cost })
  }
}

async function updateRunUsage(db: DB, runId: string, kind: 'search' | 'data', credits: number): Promise<void> {
  if (credits <= 0) return
  const column = kind === 'search' ? creatorDiscoveryRuns.searchRequestsUsed : creatorDiscoveryRuns.dataUnitsUsed
  await db
    .update(creatorDiscoveryRuns)
    .set({
      [kind === 'search' ? 'searchRequestsUsed' : 'dataUnitsUsed']: sql`${column} + ${credits}`,
      heartbeatAt: now(),
    })
    .where(eq(creatorDiscoveryRuns.id, runId))
}

async function scrapeCreatorsRequest<T>(
  db: DB,
  apiKey: string,
  runId: string,
  endpoint: string,
  params: Record<string, string>,
  kind: 'search' | 'data',
  budget: RequestBudget,
): Promise<{ data: T; cached: boolean }> {
  const fingerprint = keyFingerprint(apiKey)
  const identity = requestIdentity(endpoint, params)
  const timestamp = now()
  const [cached] = await db
    .select()
    .from(creatorDiscoveryApiRequests)
    .where(
      and(
        eq(creatorDiscoveryApiRequests.provider, PROVIDER),
        eq(creatorDiscoveryApiRequests.keyFingerprint, fingerprint),
        eq(creatorDiscoveryApiRequests.requestHash, identity),
      ),
    )
    .limit(1)
  if (
    cached?.status === 'succeeded' &&
    cached.responseJson &&
    cached.cacheExpiresAt &&
    cached.cacheExpiresAt > timestamp
  ) {
    // A cached response is free now, but still occupies its place in this
    // logical run's cap so resuming cannot allocate a fresh full budget.
    budget.charged += Math.max(0, cached.creditsCharged)
    await db
      .update(creatorDiscoveryApiRequests)
      .set({ lastRunId: runId, updatedAt: timestamp })
      .where(eq(creatorDiscoveryApiRequests.id, cached.id))
    return { data: JSON.parse(cached.responseJson) as T, cached: true }
  }
  if (budget.charged >= budget.limit) {
    throw new SocialRunLimitError()
  }
  if (cached?.status === 'running' || cached?.status === 'uncertain') {
    await db
      .update(creatorDiscoveryApiRequests)
      .set({ status: 'uncertain', lastRunId: runId, updatedAt: timestamp })
      .where(eq(creatorDiscoveryApiRequests.id, cached.id))
    throw new SocialRequestUncertainError(endpoint)
  }

  await ensureProviderBudget(db)
  if (cached) {
    await db
      .update(creatorDiscoveryApiRequests)
      .set({
        lastRunId: runId,
        endpoint,
        status: 'running',
        responseJson: null,
        error: null,
        requestedAt: timestamp,
        completedAt: null,
        updatedAt: timestamp,
      })
      .where(eq(creatorDiscoveryApiRequests.id, cached.id))
  } else {
    await db.insert(creatorDiscoveryApiRequests).values({
      lastRunId: runId,
      provider: PROVIDER,
      keyFingerprint: fingerprint,
      endpoint,
      requestHash: identity,
      status: 'running',
      requestedAt: timestamp,
    })
  }

  const url = new URL(endpoint, API_BASE)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  try {
    const response = await fetch(url, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const body = await response.text()
    let parsed: JsonRecord
    try {
      parsed = asRecord(JSON.parse(body))
    } catch {
      parsed = {}
    }
    if (!response.ok || parsed.success === false) {
      const detail = stringOf(parsed.message, parsed.error, body.slice(0, 300))
      const uncertain = response.status >= 500
      await db
        .update(creatorDiscoveryApiRequests)
        .set({
          status: uncertain ? 'uncertain' : 'failed',
          error: `HTTP ${response.status}: ${detail}`,
          completedAt: now(),
          updatedAt: now(),
        })
        .where(
          and(
            eq(creatorDiscoveryApiRequests.provider, PROVIDER),
            eq(creatorDiscoveryApiRequests.keyFingerprint, fingerprint),
            eq(creatorDiscoveryApiRequests.requestHash, identity),
          ),
        )
      if (uncertain) throw new SocialRequestUncertainError(endpoint)
      throw new SocialResponseError(`ScrapeCreators HTTP ${response.status}: ${detail}`)
    }
    const charged = Math.max(0, numberOf(parsed.credits_charged) ?? 1)
    const remaining = numberOf(parsed.credits_remaining, parsed.creditCount)
    budget.charged += charged
    await db
      .update(creatorDiscoveryApiRequests)
      .set({
        status: 'succeeded',
        responseJson: JSON.stringify(parsed),
        creditsCharged: charged,
        creditsRemaining: remaining,
        cacheExpiresAt: cacheExpiresAt(),
        error: null,
        completedAt: now(),
        updatedAt: now(),
      })
      .where(
        and(
          eq(creatorDiscoveryApiRequests.provider, PROVIDER),
          eq(creatorDiscoveryApiRequests.keyFingerprint, fingerprint),
          eq(creatorDiscoveryApiRequests.requestHash, identity),
        ),
      )
    await Promise.all([addProviderSpend(db, charged), updateRunUsage(db, runId, kind, charged)])
    return { data: parsed as T, cached: false }
  } catch (error) {
    if (
      error instanceof SocialRequestUncertainError ||
      error instanceof SocialBudgetError ||
      error instanceof SocialResponseError
    ) {
      throw error
    }
    await db
      .update(creatorDiscoveryApiRequests)
      .set({
        status: 'uncertain',
        error: error instanceof Error ? error.message : String(error),
        completedAt: now(),
        updatedAt: now(),
      })
      .where(
        and(
          eq(creatorDiscoveryApiRequests.provider, PROVIDER),
          eq(creatorDiscoveryApiRequests.keyFingerprint, fingerprint),
          eq(creatorDiscoveryApiRequests.requestHash, identity),
        ),
      )
    throw new SocialRequestUncertainError(endpoint)
  }
}

function extractPublicContacts(text: string, sourceUrl: string): PublicContact[] {
  const deobfuscated = text
    .replace(/\s*(?:\[|\()\s*at\s*(?:\]|\))\s*/gi, '@')
    .replace(/\s+[aA][tT]\s+/g, '@')
    .replace(/\s*(?:\[|\()\s*dot\s*(?:\]|\))\s*/gi, '.')
  const emails = deobfuscated.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? []
  const urls = text.match(/https?:\/\/[^\s<>()\]"']+/gi) ?? []
  return [
    ...uniqueStrings(emails).map((email) => ({
      type: 'business_email' as const,
      value: email,
      normalizedValue: email.toLocaleLowerCase(),
      sourceUrl,
      confidence: /business|contact|press|work|inquir|collab/i.test(text) ? 0.9 : 0.75,
      gated: false,
    })),
    ...uniqueStrings(urls)
      .map((value) => value.replace(/[.,;:!?]+$/, ''))
      .filter((value) => !/instagram\.com|tiktok\.com|(?:twitter|x)\.com/i.test(value))
      .map((value) => ({
        type: 'website' as const,
        value,
        normalizedValue: value.toLocaleLowerCase().replace(/\/$/, ''),
        sourceUrl,
        confidence: 0.7,
        gated: false,
      })),
  ]
}

function uniqueContacts(contacts: PublicContact[]): PublicContact[] {
  const seen = new Set<string>()
  return contacts.filter((contact) => {
    const identity = `${contact.type}:${contact.normalizedValue}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function isPrivateAddress(address: string): boolean {
  const ipv4Mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]
  if (ipv4Mapped) return isPrivateAddress(ipv4Mapped)
  if (address === '::1' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd'))
    return true
  if (!address.includes('.')) return false
  const octets = address.split('.').map(Number)
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127)
  )
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported public contact URL')
  const hostname = url.hostname.toLocaleLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('Local contact URL rejected')
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Private contact URL rejected')
  }
}

async function readLimitedText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > WEBSITE_MAX_BYTES) throw new Error('Contact page is too large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > WEBSITE_MAX_BYTES) {
      await reader.cancel()
      throw new Error('Contact page is too large')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function fetchPublicPage(input: string): Promise<{ url: string; html: string }> {
  let current = new URL(input)
  for (let redirect = 0; redirect <= WEBSITE_MAX_REDIRECTS; redirect++) {
    await assertPublicUrl(current)
    const response = await fetch(current, {
      headers: { 'User-Agent': 'MarCat/0.3 creator contact discovery' },
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBSITE_TIMEOUT_MS),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('Contact page redirected without a target')
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw new Error(`Contact page HTTP ${response.status}`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!/text\/(?:html|plain)|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error('Contact URL is not a text page')
    }
    return { url: current.toString(), html: await readLimitedText(response) }
  }
  throw new Error('Too many contact page redirects')
}

function htmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&commat;|&#64;/gi, '@')
    .replace(/&period;|&#46;/gi, '.')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
}

function contactPageUrl(html: string, baseUrl: string): string | null {
  const links = [...html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)]
  for (const match of links) {
    const href = match[1] ?? ''
    if (!/(?:contact|about|press|business|collab|advertis)/i.test(href)) continue
    try {
      const resolved = new URL(href, baseUrl)
      if (resolved.origin === new URL(baseUrl).origin) return resolved.toString()
    } catch {
      // Ignore malformed links from third-party pages.
    }
  }
  return null
}

async function contactsFromWebsite(url: string): Promise<PublicContact[]> {
  try {
    const home = await fetchPublicPage(url)
    const contacts = extractPublicContacts(htmlText(home.html), home.url).filter(
      (contact) => contact.type === 'business_email',
    )
    if (contacts.length) return contacts
    const contactUrl = contactPageUrl(home.html, home.url)
    if (!contactUrl || contactUrl === home.url) return []
    const page = await fetchPublicPage(contactUrl)
    return extractPublicContacts(htmlText(page.html), page.url).filter((contact) => contact.type === 'business_email')
  } catch {
    return []
  }
}

function queryFor(reference: DiscoveryReferenceSnapshot): string {
  return reference.queryTerms[0] || reference.label
}

function matchedTerms(reference: DiscoveryReferenceSnapshot, text: string): string[] {
  const normalized = normalizeText(text)
  const terms = uniqueStrings([reference.label, ...reference.aliases, ...reference.queryTerms])
  return terms.filter((term) => containsPhrase(normalized, term))
}

function candidateKey(platform: SocialDiscoveryPlatform, externalId: string): string {
  return `${platform}:${externalId.toLocaleLowerCase()}`
}

function addCandidate(map: Map<string, SocialCandidate>, incoming: SocialCandidate): SocialCandidate {
  const key = candidateKey(incoming.platform, incoming.externalId)
  const existing = map.get(key)
  if (!existing) {
    map.set(key, incoming)
    return incoming
  }
  existing.name = incoming.name || existing.name
  existing.thumbnailUrl ||= incoming.thumbnailUrl
  existing.description = [existing.description, incoming.description].filter(Boolean).join('\n')
  existing.country ||= incoming.country
  existing.language ||= incoming.language
  existing.subscriberCount = incoming.subscriberCount ?? existing.subscriberCount
  existing.totalViewCount = incoming.totalViewCount ?? existing.totalViewCount
  existing.videoCount = incoming.videoCount ?? existing.videoCount
  existing.websiteUrls = uniqueStrings([...existing.websiteUrls, ...incoming.websiteUrls])
  for (const item of incoming.evidence) {
    if (!existing.evidence.some((candidate) => candidate.externalId === item.externalId)) existing.evidence.push(item)
  }
  return existing
}

async function discoverInstagram(
  db: DB,
  apiKey: string,
  runId: string,
  profile: DiscoveryProfileSnapshot,
  candidates: Map<string, SocialCandidate>,
  budget: RequestBudget,
): Promise<void> {
  for (const reference of profile.references.slice(0, profile.maxSearchRequests)) {
    await assertRunActive(db, runId)
    const query = queryFor(reference)
    const { data } = await scrapeCreatorsRequest<JsonRecord>(
      db,
      apiKey,
      runId,
      '/v1/instagram/search/profiles',
      { query },
      'search',
      budget,
    )
    for (const raw of asArray(data.profiles)) {
      const profileData = asRecord(raw)
      if (profileData.is_private === true) continue
      const username = stringOf(profileData.username)
      const externalId = stringOf(profileData.id, username)
      if (!username || !externalId) continue
      const biography = stringOf(profileData.biography)
      const googleDescription = stringOf(profileData.google_description)
      const profileUrl = stringOf(profileData.url) || `https://www.instagram.com/${username}/`
      const bioLinks = asArray(profileData.bio_links).map(asRecord)
      const websites = uniqueStrings([
        stringOf(profileData.external_url),
        ...bioLinks.map((link) => stringOf(link.url)),
      ])
      const evidenceText = `${biography}\n${googleDescription}`
      const evidenceTerms = matchedTerms(reference, evidenceText)
      if (!evidenceTerms.length) continue
      addCandidate(candidates, {
        platform: 'instagram',
        externalId,
        handle: username,
        name: stringOf(profileData.full_name, username),
        channelUrl: profileUrl,
        thumbnailUrl: stringOf(profileData.profile_pic_url) || null,
        description: biography,
        country: null,
        language: profile.languages[0] ?? null,
        subscriberCount: numberOf(profileData.follower_count),
        totalViewCount: null,
        videoCount: numberOf(profileData.media_count),
        websiteUrls: websites,
        evidence: [
          {
            reference,
            externalId: `instagram-search:${externalId}:${reference.id}`,
            title: stringOf(profileData.google_title, profileData.full_name, username),
            url: profileUrl,
            text: evidenceText,
            publishedAt: null,
            viewCount: null,
            matchedTerms: evidenceTerms,
          },
        ],
      })
    }
  }
}

async function discoverTikTok(
  db: DB,
  apiKey: string,
  runId: string,
  profile: DiscoveryProfileSnapshot,
  candidates: Map<string, SocialCandidate>,
  budget: RequestBudget,
): Promise<void> {
  for (const reference of profile.references.slice(0, profile.maxSearchRequests)) {
    await assertRunActive(db, runId)
    const query = queryFor(reference)
    const { data } = await scrapeCreatorsRequest<JsonRecord>(
      db,
      apiKey,
      runId,
      '/v1/tiktok/search/keyword',
      {
        query,
        trim: 'true',
        sort_by: 'relevance',
        ...(profile.languages[0]?.includes('-')
          ? { region: profile.languages[0].split('-').at(-1)!.toUpperCase() }
          : {}),
      },
      'search',
      budget,
    )
    for (const raw of asArray(data.search_item_list)) {
      const item = asRecord(raw)
      const author = asRecord(item.author)
      const statistics = asRecord(item.statistics)
      const handle = stringOf(author.unique_id, author.uniqueId)
      const externalId = stringOf(author.uid, author.id, author.sec_uid, handle)
      const videoId = stringOf(item.aweme_id, item.id)
      if (!handle || !externalId || !videoId) continue
      const description = stringOf(item.desc, item.description)
      const evidenceTerms = matchedTerms(reference, description)
      if (!evidenceTerms.length) continue
      const videoUrl = stringOf(item.url) || `https://www.tiktok.com/@${handle}/video/${videoId}`
      addCandidate(candidates, {
        platform: 'tiktok',
        externalId,
        handle,
        name: stringOf(author.nickname, handle),
        channelUrl: `https://www.tiktok.com/@${handle}`,
        thumbnailUrl:
          stringOf(asArray(asRecord(author.avatar_medium).url_list)[0], author.avatarMedium, author.avatarLarger) ||
          null,
        description: stringOf(author.signature),
        country: stringOf(item.region) || null,
        language: stringOf(item.desc_language) || profile.languages[0] || null,
        subscriberCount: numberOf(author.follower_count, author.followerCount),
        totalViewCount: null,
        videoCount: null,
        websiteUrls: [],
        evidence: [
          {
            reference,
            externalId: videoId,
            title: description || videoId,
            url: videoUrl,
            text: description,
            publishedAt: isoOf(item.create_time_utc, item.create_time),
            viewCount: numberOf(statistics.play_count, statistics.playCount),
            matchedTerms: evidenceTerms,
          },
        ],
      })
    }
  }
}

function twitterHandle(value: string): string | null {
  try {
    const url = new URL(value)
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(url.hostname)) return null
    const handle = url.pathname.split('/').filter(Boolean)[0] ?? ''
    if (!handle || /^(?:home|search|explore|intent|share|i)$/i.test(handle)) return null
    return handle.replace(/^@/, '')
  } catch {
    return null
  }
}

async function discoverTwitter(
  db: DB,
  apiKey: string,
  runId: string,
  profile: DiscoveryProfileSnapshot,
  candidates: Map<string, SocialCandidate>,
  budget: RequestBudget,
): Promise<void> {
  for (const reference of profile.references.slice(0, profile.maxSearchRequests)) {
    await assertRunActive(db, runId)
    const query = queryFor(reference)
    const { data } = await scrapeCreatorsRequest<JsonRecord>(
      db,
      apiKey,
      runId,
      '/v1/google/search',
      { query: `site:x.com ${query}` },
      'search',
      budget,
    )
    for (const raw of asArray(data.results)) {
      const result = asRecord(raw)
      const resultUrl = stringOf(result.url)
      const handle = twitterHandle(resultUrl)
      if (!handle) continue
      const description = stringOf(result.description)
      const evidenceText = `${result.title ?? ''} ${description}`
      const evidenceTerms = matchedTerms(reference, evidenceText)
      if (!evidenceTerms.length) continue
      addCandidate(candidates, {
        platform: 'twitter',
        externalId: handle.toLocaleLowerCase(),
        handle,
        name: stringOf(result.title, handle).replace(/\s*[✓✔]\s*$/, ''),
        channelUrl: `https://x.com/${handle}`,
        thumbnailUrl: null,
        description,
        country: null,
        language: profile.languages[0] ?? null,
        subscriberCount: null,
        totalViewCount: null,
        videoCount: null,
        websiteUrls: [],
        evidence: [
          {
            reference,
            externalId: `x-search:${hash(`${reference.id}:${resultUrl}`).slice(0, 20)}`,
            title: stringOf(result.title, handle),
            url: resultUrl || `https://x.com/${handle}`,
            text: description,
            publishedAt: null,
            viewCount: null,
            matchedTerms: evidenceTerms,
          },
        ],
      })
    }
  }
}

async function enrichTikTok(
  db: DB,
  apiKey: string,
  runId: string,
  candidate: SocialCandidate,
  budget: RequestBudget,
): Promise<void> {
  const { data } = await scrapeCreatorsRequest<JsonRecord>(
    db,
    apiKey,
    runId,
    '/v1/tiktok/profile',
    { handle: candidate.handle, cache_max_age: '30d' },
    'data',
    budget,
  )
  const user = asRecord(data.user)
  const stats = asRecord(data.stats)
  candidate.name = stringOf(user.nickname, candidate.name)
  candidate.description = stringOf(user.signature, candidate.description)
  candidate.thumbnailUrl =
    stringOf(user.avatarMedium, user.avatarLarger, user.avatarThumb, candidate.thumbnailUrl) || null
  candidate.language = stringOf(user.language, candidate.language) || null
  candidate.subscriberCount = numberOf(stats.followerCount, candidate.subscriberCount)
  candidate.videoCount = numberOf(stats.videoCount, candidate.videoCount)
  const bioLink = asRecord(user.bioLink)
  candidate.websiteUrls = uniqueStrings([...candidate.websiteUrls, stringOf(bioLink.link)])
}

async function enrichTwitter(
  db: DB,
  apiKey: string,
  runId: string,
  candidate: SocialCandidate,
  budget: RequestBudget,
): Promise<void> {
  const { data } = await scrapeCreatorsRequest<JsonRecord>(
    db,
    apiKey,
    runId,
    '/v1/twitter/profile',
    { handle: candidate.handle, cache_max_age: '30d' },
    'data',
    budget,
  )
  const legacy = asRecord(data.legacy)
  const entities = asRecord(legacy.entities)
  const urlEntities = asArray(asRecord(entities.url).urls).map(asRecord)
  const descriptionEntities = asArray(asRecord(entities.description).urls).map(asRecord)
  candidate.externalId = stringOf(data.rest_id, candidate.externalId)
  candidate.name = stringOf(legacy.name, candidate.name)
  candidate.handle = stringOf(legacy.screen_name, candidate.handle)
  candidate.channelUrl = `https://x.com/${candidate.handle}`
  candidate.description = stringOf(legacy.description, candidate.description)
  candidate.thumbnailUrl = stringOf(legacy.profile_image_url_https, candidate.thumbnailUrl) || null
  candidate.country = stringOf(legacy.location, candidate.country) || null
  candidate.subscriberCount = numberOf(legacy.followers_count, candidate.subscriberCount)
  candidate.videoCount = numberOf(legacy.statuses_count, candidate.videoCount)
  candidate.websiteUrls = uniqueStrings([
    ...candidate.websiteUrls,
    ...urlEntities.map((url) => stringOf(url.expanded_url)),
    ...descriptionEntities.map((url) => stringOf(url.expanded_url)),
  ])
}

function fitCandidate(
  profile: DiscoveryProfileSnapshot,
  references: DiscoveryReferenceSnapshot[],
  evidence: SocialEvidence[],
  latestAt: string | null,
  audience: number | null,
  avgViews: number | null,
  contacts: PublicContact[],
): { score: number; reasons: string[] } {
  const totalWeight = profile.references.reduce((sum, reference) => sum + Math.max(0.1, reference.weight), 0)
  const matchedWeight = references.reduce((sum, reference) => sum + Math.max(0.1, reference.weight), 0)
  const coverage = totalWeight ? matchedWeight / totalWeight : 0
  const evidenceScore = Math.min(1, evidence.length / Math.max(3, profile.references.length * 2))
  const activeDays = latestAt ? (Date.now() - new Date(latestAt).getTime()) / 86_400_000 : Infinity
  const recency = activeDays <= 45 ? 1 : activeDays <= 180 ? 0.7 : activeDays <= 365 ? 0.3 : 0
  const reachSignal = Math.max(avgViews ?? 0, Math.round((audience ?? 0) * 0.08))
  const reach = Math.min(1, Math.log10(Math.max(1, reachSignal)) / 6)
  const contact = contacts.some((item) => item.type === 'business_email') ? 1 : contacts.length ? 0.4 : 0
  return {
    score: Math.round(Math.min(100, coverage * 60 + evidenceScore * 15 + recency * 10 + reach * 10 + contact * 5)),
    reasons: [
      `${references.length}/${profile.references.length} reference matches`,
      `${evidence.length} matching posts`,
      ...(recency >= 0.7 ? ['active account'] : []),
      ...(contact === 1 ? ['public email found'] : []),
    ],
  }
}

async function stageCandidate(
  db: DB,
  runId: string,
  profile: DiscoveryProfileSnapshot,
  candidate: SocialCandidate,
): Promise<{ staged: boolean; emails: number }> {
  const corpus = normalizeText(
    [candidate.name, candidate.description, ...candidate.evidence.map((item) => item.text)].join(' '),
  )
  if (profile.includeTerms.length && !profile.includeTerms.some((term) => containsPhrase(corpus, term))) {
    return { staged: false, emails: 0 }
  }
  if (profile.excludeTerms.some((term) => containsPhrase(corpus, term))) {
    return { staged: false, emails: 0 }
  }
  const references = profile.references.filter((reference) =>
    candidate.evidence.some((item) => item.reference.id === reference.id),
  )
  if (!references.length) return { staged: false, emails: 0 }

  const websiteUrls = uniqueStrings(candidate.websiteUrls).slice(0, 3)
  const contacts = profile.discoverContacts
    ? uniqueContacts([
        ...extractPublicContacts(candidate.description, candidate.channelUrl),
        ...candidate.evidence.flatMap((item) => extractPublicContacts(item.text, item.url)),
        ...websiteUrls.map((url) => ({
          type: 'website' as const,
          value: url,
          normalizedValue: url.toLocaleLowerCase().replace(/\/$/, ''),
          sourceUrl: candidate.channelUrl,
          confidence: 0.85,
          gated: false,
        })),
        ...(await Promise.all(websiteUrls.slice(0, 1).map(contactsFromWebsite))).flat(),
      ])
    : []
  const viewCounts = candidate.evidence.map((item) => item.viewCount).filter((value): value is number => value != null)
  const avgViews = viewCounts.length
    ? Math.round(viewCounts.reduce((sum, value) => sum + value, 0) / viewCounts.length)
    : null
  const latestAt =
    candidate.evidence
      .map((item) => item.publishedAt)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null
  const totalViews = viewCounts.length ? viewCounts.reduce((sum, value) => sum + value, 0) : null
  const values = {
    platform: candidate.platform,
    externalId: candidate.externalId,
    name: candidate.name,
    handle: candidate.handle,
    channelUrl: candidate.channelUrl,
    thumbnailUrl: candidate.thumbnailUrl,
    description: candidate.description || null,
    country: candidate.country,
    defaultLanguage: candidate.language,
    subscriberCount: candidate.subscriberCount,
    totalViewCount: totalViews ?? candidate.totalViewCount,
    videoCount: candidate.videoCount,
    avgViews,
    cadencePerMonth: null,
    latestVideoAt: latestAt,
    uploadsPlaylistId: null,
    fetchedAt: now(),
    expiresAt: cacheExpiresAt(),
  }
  const [existing] = await db
    .select({ id: creatorDiscoveryCandidates.id })
    .from(creatorDiscoveryCandidates)
    .where(
      and(
        eq(creatorDiscoveryCandidates.platform, candidate.platform),
        eq(creatorDiscoveryCandidates.externalId, candidate.externalId),
      ),
    )
    .limit(1)
  let candidateId: string
  if (existing) {
    candidateId = existing.id
    await db.update(creatorDiscoveryCandidates).set(values).where(eq(creatorDiscoveryCandidates.id, candidateId))
  } else {
    const [inserted] = await db
      .insert(creatorDiscoveryCandidates)
      .values(values)
      .returning({ id: creatorDiscoveryCandidates.id })
    candidateId = inserted!.id
  }
  const fit = fitCandidate(
    profile,
    references,
    candidate.evidence,
    latestAt,
    candidate.subscriberCount,
    avgViews,
    contacts,
  )
  await db
    .insert(creatorDiscoveryRunCandidates)
    .values({
      runId,
      candidateId,
      fitScore: fit.score,
      matchedReferenceCount: references.length,
      matchedReferencesJson: JSON.stringify(references.map((reference) => reference.label)),
      matchedVideoCount: candidate.evidence.length,
      fitReasonsJson: JSON.stringify(fit.reasons),
    })
    .onConflictDoUpdate({
      target: [creatorDiscoveryRunCandidates.runId, creatorDiscoveryRunCandidates.candidateId],
      set: {
        fitScore: fit.score,
        matchedReferenceCount: references.length,
        matchedReferencesJson: JSON.stringify(references.map((reference) => reference.label)),
        matchedVideoCount: candidate.evidence.length,
        fitReasonsJson: JSON.stringify(fit.reasons),
        updatedAt: now(),
      },
    })
  for (const item of candidate.evidence) {
    await db
      .insert(creatorDiscoveryEvidence)
      .values({
        runId,
        candidateId,
        referenceId: item.reference.id,
        videoId: item.externalId,
        videoTitle: item.title,
        videoUrl: item.url,
        publishedAt: item.publishedAt,
        viewCount: item.viewCount,
        matchedTermsJson: JSON.stringify(item.matchedTerms),
      })
      .onConflictDoNothing()
  }
  for (const contact of contacts) {
    await db
      .insert(creatorDiscoveryContacts)
      .values({ runId, candidateId, ...contact })
      .onConflictDoNothing()
  }
  return {
    staged: true,
    emails: contacts.filter((contact) => contact.type === 'business_email').length,
  }
}

async function assertRunActive(db: DB, runId: string): Promise<void> {
  const [run] = await db
    .select({ status: creatorDiscoveryRuns.status })
    .from(creatorDiscoveryRuns)
    .where(eq(creatorDiscoveryRuns.id, runId))
    .limit(1)
  if (run?.status === 'paused' || run?.status === 'cancelled') throw new SocialRunInterruptedError(run.status)
}

export async function runSocialDiscovery(
  db: DB,
  apiKey: string,
  run: typeof creatorDiscoveryRuns.$inferSelect,
  platforms: SocialDiscoveryPlatform[],
): Promise<void> {
  const profile = JSON.parse(run.profileSnapshotJson) as DiscoveryProfileSnapshot
  const budget: RequestBudget = { charged: 0, limit: Math.max(10, profile.maxSearchRequests * 10) }
  const candidates = new Map<string, SocialCandidate>()
  await db
    .update(creatorDiscoveryRuns)
    .set({ phase: 'searching_social', heartbeatAt: now() })
    .where(eq(creatorDiscoveryRuns.id, run.id))

  if (platforms.includes('instagram')) await discoverInstagram(db, apiKey, run.id, profile, candidates, budget)
  if (platforms.includes('tiktok')) await discoverTikTok(db, apiKey, run.id, profile, candidates, budget)
  if (platforms.includes('twitter')) await discoverTwitter(db, apiKey, run.id, profile, candidates, budget)

  await db
    .update(creatorDiscoveryRuns)
    .set({
      phase: 'enriching_social',
      channelsFound: sql`${creatorDiscoveryRuns.channelsFound} + ${candidates.size}`,
      heartbeatAt: now(),
    })
    .where(eq(creatorDiscoveryRuns.id, run.id))

  const ranked = [...candidates.values()].sort((left, right) => {
    const leftReferences = new Set(left.evidence.map((item) => item.reference.id)).size
    const rightReferences = new Set(right.evidence.map((item) => item.reference.id)).size
    return rightReferences - leftReferences || (right.subscriberCount ?? 0) - (left.subscriberCount ?? 0)
  })
  for (const candidate of ranked) {
    await assertRunActive(db, run.id)
    try {
      if (candidate.platform === 'tiktok') await enrichTikTok(db, apiKey, run.id, candidate, budget)
      if (candidate.platform === 'twitter') await enrichTwitter(db, apiKey, run.id, candidate, budget)
    } catch (error) {
      if (error instanceof SocialRunLimitError) break
      throw error
    }
  }

  let scanned = 0
  let staged = 0
  let emails = 0
  const [beforeStaging] = await db
    .select({
      channelsScanned: creatorDiscoveryRuns.channelsScanned,
      candidatesStaged: creatorDiscoveryRuns.candidatesStaged,
      contactsFound: creatorDiscoveryRuns.contactsFound,
    })
    .from(creatorDiscoveryRuns)
    .where(eq(creatorDiscoveryRuns.id, run.id))
    .limit(1)
  await db
    .update(creatorDiscoveryRuns)
    .set({ phase: 'staging_social', heartbeatAt: now() })
    .where(eq(creatorDiscoveryRuns.id, run.id))
  for (const candidate of ranked.slice(0, profile.maxChannels)) {
    await assertRunActive(db, run.id)
    const result = await stageCandidate(db, run.id, profile, candidate)
    scanned++
    if (result.staged) {
      staged++
      emails += result.emails
    }
    if (scanned % 10 === 0 || scanned === ranked.length) {
      await db
        .update(creatorDiscoveryRuns)
        .set({
          channelsScanned: (beforeStaging?.channelsScanned ?? 0) + scanned,
          candidatesStaged: (beforeStaging?.candidatesStaged ?? 0) + staged,
          contactsFound: (beforeStaging?.contactsFound ?? 0) + emails,
          heartbeatAt: now(),
        })
        .where(eq(creatorDiscoveryRuns.id, run.id))
    }
  }
  await db
    .update(creatorDiscoveryRuns)
    .set({
      phase: 'staging',
      channelsScanned: (beforeStaging?.channelsScanned ?? 0) + scanned,
      videosScanned: sql`${creatorDiscoveryRuns.videosScanned} + ${ranked.reduce(
        (sum, candidate) => sum + candidate.evidence.length,
        0,
      )}`,
      candidatesStaged: (beforeStaging?.candidatesStaged ?? 0) + staged,
      contactsFound: (beforeStaging?.contactsFound ?? 0) + emails,
      heartbeatAt: now(),
    })
    .where(eq(creatorDiscoveryRuns.id, run.id))
}

export async function scrapeCreatorsStatus(db: DB, apiKey?: string) {
  const [spend] = await db
    .select()
    .from(apiSpend)
    .where(and(eq(apiSpend.provider, PROVIDER), eq(apiSpend.date, today())))
    .limit(1)
  const [settings] = await db.select().from(providerSettings).where(eq(providerSettings.provider, PROVIDER)).limit(1)
  if (!apiKey) {
    return {
      configured: false,
      creditsRemaining: null,
      creditsUpdatedAt: null,
      creditsUsedToday: spend?.requests ?? 0,
      estimatedCostToday: spend?.costUsd ?? 0,
      dailyBudgetUsd: settings?.dailyBudgetUsd ?? null,
    }
  }
  const [latest] = await db
    .select({
      creditsRemaining: creatorDiscoveryApiRequests.creditsRemaining,
      updatedAt: creatorDiscoveryApiRequests.updatedAt,
    })
    .from(creatorDiscoveryApiRequests)
    .where(
      and(
        eq(creatorDiscoveryApiRequests.provider, PROVIDER),
        eq(creatorDiscoveryApiRequests.keyFingerprint, keyFingerprint(apiKey)),
        eq(creatorDiscoveryApiRequests.status, 'succeeded'),
      ),
    )
    .orderBy(desc(creatorDiscoveryApiRequests.updatedAt))
    .limit(1)
  return {
    configured: true,
    creditsRemaining: latest?.creditsRemaining ?? null,
    creditsUpdatedAt: latest?.updatedAt ?? null,
    creditsUsedToday: spend?.requests ?? 0,
    estimatedCostToday: spend?.costUsd ?? 0,
    dailyBudgetUsd: settings?.dailyBudgetUsd ?? null,
  }
}
