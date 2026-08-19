import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import {
  creatorDiscoveryCandidates,
  creatorDiscoveryApiRequests,
  creatorDiscoveryContacts,
  creatorDiscoveryEvidence,
  creatorDiscoveryRunChannels,
  creatorDiscoveryRunCandidates,
  creatorDiscoveryRuns,
  creatorDiscoveryRunSearches,
  creators,
  creatorPicks,
  youtubeApiRequests,
  youtubeQuotaUsage,
  withSqliteBusyRetry,
  type DB,
} from '@marcat/db'
import type { SecretsStore } from './context'
import {
  runSocialDiscovery,
  scrapeCreatorsStatus,
  SOCIAL_DISCOVERY_PLATFORMS,
  SocialBudgetError,
  SocialRequestUncertainError,
  SocialRunInterruptedError,
  type SocialDiscoveryPlatform,
} from './socialDiscovery'
import type { MarkdownWorkspaceCoordinator } from './workspace/coordinator'

export const YOUTUBE_SEARCH_DAILY_LIMIT = 100
export const YOUTUBE_DATA_DAILY_LIMIT = 10_000
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3'
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const STALE_REQUEST_MS = 2 * 60 * 1_000
const STALE_RUN_MS = 5 * 60 * 1_000

export type DiscoveryMode = 'games' | 'topic'
export type DiscoveryPlatform = 'youtube' | SocialDiscoveryPlatform
export type DiscoveryRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_for_quota'
  | 'partial'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type DiscoveryRunIssue = {
  code:
    | 'quota_wait'
    | 'request_uncertain'
    | 'youtube_setup'
    | 'social_setup'
    | 'social_credits'
    | 'provider_budget'
    | 'temporary_failure'
    | 'unexpected_failure'
  recovery: 'automatic' | 'retry' | 'settings'
  operation?:
    | 'search_results'
    | 'channel_details'
    | 'recent_videos'
    | 'video_details'
    | 'youtube_request'
    | 'social_request'
}

export interface YouTubeDiscoveryArchiveSyncResult {
  runs: number
  written: number
}

export function youtubeDiscoveryRequestOperation(
  endpoint: string | null | undefined,
): NonNullable<DiscoveryRunIssue['operation']> {
  if (endpoint === 'search') return 'search_results'
  if (endpoint === 'channels') return 'channel_details'
  if (endpoint === 'playlistItems') return 'recent_videos'
  if (endpoint === 'videos') return 'video_details'
  return 'youtube_request'
}

/** Stable, non-technical issue metadata for desktop and MCP clients. */
export function youtubeDiscoveryRunIssue(
  status: DiscoveryRunStatus | string,
  error: string | null | undefined,
  operation?: DiscoveryRunIssue['operation'],
): DiscoveryRunIssue | null {
  if (status === 'waiting_for_quota') return { code: 'quota_wait', recovery: 'automatic' }
  if (status === 'partial') {
    const inferredOperation = /Paid discovery request|ScrapeCreators/i.test(error ?? '') ? 'social_request' : operation
    return {
      code: 'request_uncertain',
      recovery: 'retry',
      ...(inferredOperation && { operation: inferredOperation }),
    }
  }
  if (status !== 'failed') return null
  const detail = error ?? ''
  if (/ScrapeCreators daily budget reached/i.test(detail)) {
    return { code: 'provider_budget', recovery: 'settings' }
  }
  if (/ScrapeCreators HTTP (?:401|403)|ScrapeCreators.*(?:API key|unauthorized|forbidden)/i.test(detail)) {
    return { code: 'social_setup', recovery: 'settings' }
  }
  if (/ScrapeCreators HTTP 402|insufficient credits|credits exhausted/i.test(detail)) {
    return { code: 'social_credits', recovery: 'settings' }
  }
  if (/quotaExceeded|dailyLimitExceeded|quota exhausted/i.test(detail)) {
    return { code: 'quota_wait', recovery: 'retry' }
  }
  if (
    /API key|keyInvalid|API_KEY_INVALID|accessNotConfigured|SERVICE_DISABLED|has not been used|not enabled/i.test(
      detail,
    )
  ) {
    return { code: 'youtube_setup', recovery: 'settings' }
  }
  if (/timed? ?out|TimeoutError|fetch failed|network|ECONN|EAI_AGAIN|YouTube API 5\d\d/i.test(detail)) {
    return { code: 'temporary_failure', recovery: 'retry' }
  }
  return { code: 'unexpected_failure', recovery: 'retry' }
}

export interface DiscoveryReferenceSnapshot {
  id: string
  label: string
  aliases: string[]
  queryTerms: string[]
  weight: number
}

export interface DiscoveryProfileSnapshot {
  profileId: string
  gameId: string
  name: string
  mode: DiscoveryMode
  languages: string[]
  includeTerms: string[]
  excludeTerms: string[]
  seedChannels: string[]
  maxSearchRequests: number
  maxChannels: number
  recentVideoLimit: number
  discoverContacts: boolean
  /** Providers selected automatically from the protected keys available when the run was queued. */
  platforms: DiscoveryPlatform[]
  references: DiscoveryReferenceSnapshot[]
}

type YoutubeList<T> = { items?: T[]; nextPageToken?: string }
type SearchItem = {
  id?: { videoId?: string; channelId?: string }
  snippet?: { channelId?: string; channelTitle?: string; title?: string; description?: string; publishedAt?: string }
}
type ChannelItem = {
  id?: string
  snippet?: {
    title?: string
    description?: string
    customUrl?: string
    country?: string
    defaultLanguage?: string
    thumbnails?: Record<string, { url?: string }>
  }
  statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean }
  contentDetails?: { relatedPlaylists?: { uploads?: string } }
}
type PlaylistItem = {
  snippet?: {
    title?: string
    description?: string
    publishedAt?: string
    channelId?: string
    resourceId?: { videoId?: string }
  }
}
type VideoItem = {
  id?: string
  snippet?: {
    title?: string
    description?: string
    publishedAt?: string
    channelId?: string
    defaultAudioLanguage?: string
  }
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }
}

type PublicContact = {
  type: 'business_email' | 'website'
  value: string
  normalizedValue: string
  sourceUrl: string
  confidence: number
  gated: boolean
}

class QuotaExhaustedError extends Error {
  constructor(
    readonly bucket: 'search' | 'data',
    readonly used: number,
    readonly limit: number,
  ) {
    super(`YouTube ${bucket} quota exhausted (${used}/${limit})`)
  }
}

class RunInterruptedError extends Error {
  constructor(readonly status: 'paused' | 'cancelled') {
    super(`Discovery run ${status}`)
  }
}

class UncertainRequestError extends Error {}

const now = () => new Date().toISOString()
const expiresAt = () => new Date(Date.now() + CACHE_TTL_MS).toISOString()

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}+#'&.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = normalizeText(phrase)
  if (!needle) return false
  return ` ${haystack} `.includes(` ${needle} `) || haystack.includes(needle)
}

function numberOrNull(value: string | undefined): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

function quotaDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function youtubeKeyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
}

export function hashDiscoveryProfile(snapshot: DiscoveryProfileSnapshot): string {
  const canonical = {
    ...snapshot,
    platforms: [...snapshot.platforms].sort(),
    languages: [...snapshot.languages].sort(),
    includeTerms: [...snapshot.includeTerms].sort(),
    excludeTerms: [...snapshot.excludeTerms].sort(),
    seedChannels: [...snapshot.seedChannels].sort(),
    references: [...snapshot.references]
      .map((reference) => ({
        ...reference,
        aliases: [...reference.aliases].sort(),
        queryTerms: [...reference.queryTerms].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function requestHash(endpoint: string, params: Record<string, string>): string {
  const canonical = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))).toString()
  return createHash('sha256').update(`${endpoint}?${canonical}`).digest('hex')
}

async function assertRunActive(db: DB, runId: string): Promise<void> {
  const row = (
    await db
      .select({ status: creatorDiscoveryRuns.status })
      .from(creatorDiscoveryRuns)
      .where(eq(creatorDiscoveryRuns.id, runId))
      .limit(1)
  )[0]
  if (!row) throw new Error('Discovery run not found')
  if (row.status === 'paused' || row.status === 'cancelled') throw new RunInterruptedError(row.status)
}

async function setRunProgress(
  db: DB,
  runId: string,
  values: Partial<typeof creatorDiscoveryRuns.$inferInsert>,
): Promise<void> {
  await db
    .update(creatorDiscoveryRuns)
    .set({ ...values, heartbeatAt: now() })
    .where(eq(creatorDiscoveryRuns.id, runId))
}

async function reserveQuota(
  db: DB,
  input: {
    runId: string
    fingerprint: string
    endpoint: string
    hash: string
    bucket: 'search' | 'data'
    cost: number
  },
): Promise<void> {
  const date = quotaDate()
  const limit = input.bucket === 'search' ? YOUTUBE_SEARCH_DAILY_LIMIT : YOUTUBE_DATA_DAILY_LIMIT
  await db.transaction(async (tx) => {
    const usage = (
      await tx
        .select()
        .from(youtubeQuotaUsage)
        .where(
          and(
            eq(youtubeQuotaUsage.keyFingerprint, input.fingerprint),
            eq(youtubeQuotaUsage.quotaDate, date),
            eq(youtubeQuotaUsage.bucket, input.bucket),
          ),
        )
        .limit(1)
    )[0]
    const used = usage?.used ?? 0
    if (used + input.cost > limit) throw new QuotaExhaustedError(input.bucket, used, limit)
    if (usage) {
      await tx
        .update(youtubeQuotaUsage)
        .set({ used: sql`${youtubeQuotaUsage.used} + ${input.cost}`, limit, updatedAt: now() })
        .where(eq(youtubeQuotaUsage.id, usage.id))
    } else {
      await tx.insert(youtubeQuotaUsage).values({
        keyFingerprint: input.fingerprint,
        quotaDate: date,
        bucket: input.bucket,
        used: input.cost,
        limit,
      })
    }
    await tx
      .insert(youtubeApiRequests)
      .values({
        lastRunId: input.runId,
        keyFingerprint: input.fingerprint,
        endpoint: input.endpoint,
        requestHash: input.hash,
        status: 'running',
        quotaBucket: input.bucket,
        quotaCost: input.cost,
        quotaDate: date,
        reservedAt: now(),
        requestedAt: now(),
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: [youtubeApiRequests.keyFingerprint, youtubeApiRequests.requestHash],
        set: {
          lastRunId: input.runId,
          status: 'running',
          quotaBucket: input.bucket,
          quotaCost: input.cost,
          quotaDate: date,
          error: null,
          reservedAt: now(),
          requestedAt: now(),
          completedAt: null,
          updatedAt: now(),
        },
      })
    const counter = input.bucket === 'search' ? 'searchRequestsUsed' : 'dataUnitsUsed'
    await tx
      .update(creatorDiscoveryRuns)
      .set({ [counter]: sql`${creatorDiscoveryRuns[counter]} + ${input.cost}`, heartbeatAt: now() })
      .where(eq(creatorDiscoveryRuns.id, input.runId))
  })
}

async function youtubeRequest<T>(
  db: DB,
  apiKey: string,
  runId: string,
  endpoint: string,
  params: Record<string, string>,
  bucket: 'search' | 'data',
  cost = 1,
): Promise<T> {
  await assertRunActive(db, runId)
  const fingerprint = youtubeKeyFingerprint(apiKey)
  const hash = requestHash(endpoint, params)
  const existing = (
    await db
      .select({
        id: youtubeApiRequests.id,
        status: youtubeApiRequests.status,
        requestedAt: youtubeApiRequests.requestedAt,
      })
      .from(youtubeApiRequests)
      .where(and(eq(youtubeApiRequests.keyFingerprint, fingerprint), eq(youtubeApiRequests.requestHash, hash)))
      .limit(1)
  )[0]
  if (existing?.status === 'uncertain') {
    throw new UncertainRequestError(
      'A previous identical YouTube request has uncertain delivery; not retrying automatically',
    )
  }
  if (
    existing?.status === 'running' &&
    existing.requestedAt &&
    Date.now() - new Date(existing.requestedAt).getTime() < STALE_REQUEST_MS
  ) {
    throw new UncertainRequestError('An identical YouTube request is already in progress')
  }
  if (existing?.status === 'running') {
    await db
      .update(youtubeApiRequests)
      .set({ status: 'uncertain', error: 'Worker stopped after quota reservation', updatedAt: now() })
      .where(eq(youtubeApiRequests.id, existing.id))
    throw new UncertainRequestError(
      'A stale identical YouTube request may have consumed quota; not retrying automatically',
    )
  }

  await reserveQuota(db, { runId, fingerprint, endpoint, hash, bucket, cost })
  const url = new URL(`${YOUTUBE_API}/${endpoint}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  url.searchParams.set('key', apiKey)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    const body = await response.text()
    if (!response.ok) {
      await db
        .update(youtubeApiRequests)
        .set({
          status: 'failed',
          error: `HTTP ${response.status}: ${body.slice(0, 500)}`,
          completedAt: now(),
          updatedAt: now(),
        })
        .where(and(eq(youtubeApiRequests.keyFingerprint, fingerprint), eq(youtubeApiRequests.requestHash, hash)))
      if (response.status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(body)) {
        const limit = bucket === 'search' ? YOUTUBE_SEARCH_DAILY_LIMIT : YOUTUBE_DATA_DAILY_LIMIT
        throw new QuotaExhaustedError(bucket, limit, limit)
      }
      throw new Error(`YouTube API ${response.status}: ${body.slice(0, 300) || response.statusText}`)
    }
    const parsed = JSON.parse(body) as T
    // The parsed response belongs to this worker invocation only. Once it has
    // reached memory, the in-flight safety row is no longer needed.
    await db
      .delete(youtubeApiRequests)
      .where(and(eq(youtubeApiRequests.keyFingerprint, fingerprint), eq(youtubeApiRequests.requestHash, hash)))
    return parsed
  } catch (error) {
    const current = (
      await db
        .select({ status: youtubeApiRequests.status })
        .from(youtubeApiRequests)
        .where(and(eq(youtubeApiRequests.keyFingerprint, fingerprint), eq(youtubeApiRequests.requestHash, hash)))
        .limit(1)
    )[0]
    if (current?.status !== 'failed') {
      await db
        .update(youtubeApiRequests)
        .set({
          status: 'uncertain',
          error: error instanceof Error ? error.message : String(error),
          completedAt: now(),
          updatedAt: now(),
        })
        .where(and(eq(youtubeApiRequests.keyFingerprint, fingerprint), eq(youtubeApiRequests.requestHash, hash)))
    }
    throw error
  }
}

function channelIdFromSeed(seed: string): string | null {
  const value = seed.trim()
  if (/^UC[\w-]{20,}$/.test(value)) return value
  const match = value.match(/youtube\.com\/channel\/(UC[\w-]{20,})/i)
  return match?.[1] ?? null
}

function thumbnailOf(channel: ChannelItem): string | null {
  const thumbs = channel.snippet?.thumbnails
  return thumbs?.high?.url ?? thumbs?.medium?.url ?? thumbs?.default?.url ?? null
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
      confidence: /business|contact|press|work|inquir/i.test(text) ? 0.9 : 0.75,
      gated: false,
    })),
    ...uniqueStrings(urls)
      .map((value) => value.replace(/[.,;:!?]+$/, ''))
      .filter((value) => !/youtube\.com|youtu\.be/i.test(value))
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

function channelCadence(videos: VideoItem[]): number | null {
  const dates = videos
    .map((video) => video.snippet?.publishedAt)
    .filter((value): value is string => !!value)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)
  if (dates.length < 2) return dates.length ? 1 : null
  const spanDays = Math.max(1, (dates[0]! - dates[dates.length - 1]!) / (24 * 60 * 60 * 1_000))
  return Math.round(((dates.length - 1) / spanDays) * 30 * 10) / 10
}

function fitCandidate(input: {
  profile: DiscoveryProfileSnapshot
  matchedReferences: DiscoveryReferenceSnapshot[]
  matchedVideoCount: number
  latestVideoAt: string | null
  subscriberCount: number | null
  avgViews: number | null
  contacts: PublicContact[]
}): { score: number; reasons: string[] } {
  const totalWeight = input.profile.references.reduce((sum, reference) => sum + Math.max(0.1, reference.weight), 0)
  const matchedWeight = input.matchedReferences.reduce((sum, reference) => sum + Math.max(0.1, reference.weight), 0)
  const coverage = totalWeight ? matchedWeight / totalWeight : 0
  const evidence = Math.min(1, input.matchedVideoCount / Math.max(3, input.profile.references.length * 2))
  const activeDays = input.latestVideoAt
    ? (Date.now() - new Date(input.latestVideoAt).getTime()) / 86_400_000
    : Infinity
  const recency = activeDays <= 45 ? 1 : activeDays <= 180 ? 0.7 : activeDays <= 365 ? 0.3 : 0
  const reachSignal = Math.max(input.avgViews ?? 0, Math.round((input.subscriberCount ?? 0) * 0.08))
  const reach = Math.min(1, Math.log10(Math.max(1, reachSignal)) / 6)
  const contact = input.contacts.some((item) => item.type === 'business_email') ? 1 : input.contacts.length ? 0.4 : 0
  const score = Math.round(Math.min(100, coverage * 60 + evidence * 15 + recency * 10 + reach * 10 + contact * 5))
  const reasons = [
    `${input.matchedReferences.length}/${input.profile.references.length} reference matches`,
    `${input.matchedVideoCount} matching videos`,
  ]
  if (recency >= 0.7) reasons.push('active channel')
  if (contact === 1) reasons.push('public email found')
  return { score, reasons }
}

async function upsertCandidate(db: DB, channel: ChannelItem, videos: VideoItem[]) {
  const externalId = channel.id!
  const views = videos.map((video) => numberOrNull(video.statistics?.viewCount)).filter((v): v is number => v != null)
  const avgViews = views.length ? Math.round(views.reduce((sum, value) => sum + value, 0) / views.length) : null
  const latestVideoAt =
    videos
      .map((video) => video.snippet?.publishedAt)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null
  const values = {
    platform: 'youtube',
    externalId,
    name: channel.snippet?.title?.trim() || externalId,
    handle: channel.snippet?.customUrl ?? null,
    channelUrl: `https://www.youtube.com/channel/${externalId}`,
    thumbnailUrl: thumbnailOf(channel),
    description: channel.snippet?.description ?? null,
    country: channel.snippet?.country ?? null,
    defaultLanguage: channel.snippet?.defaultLanguage ?? null,
    subscriberCount: channel.statistics?.hiddenSubscriberCount
      ? null
      : numberOrNull(channel.statistics?.subscriberCount),
    totalViewCount: numberOrNull(channel.statistics?.viewCount),
    videoCount: numberOrNull(channel.statistics?.videoCount),
    avgViews,
    cadencePerMonth: channelCadence(videos),
    latestVideoAt,
    uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads ?? null,
    fetchedAt: now(),
    expiresAt: expiresAt(),
  }
  const existing = (
    await db
      .select({ id: creatorDiscoveryCandidates.id })
      .from(creatorDiscoveryCandidates)
      .where(
        and(eq(creatorDiscoveryCandidates.platform, 'youtube'), eq(creatorDiscoveryCandidates.externalId, externalId)),
      )
      .limit(1)
  )[0]
  if (existing) {
    await db.update(creatorDiscoveryCandidates).set(values).where(eq(creatorDiscoveryCandidates.id, existing.id))
    return { id: existing.id, ...values }
  }
  const rows = await db.insert(creatorDiscoveryCandidates).values(values).returning()
  return rows[0]!
}

async function stageChannel(
  db: DB,
  runId: string,
  profile: DiscoveryProfileSnapshot,
  channel: ChannelItem,
  videos: VideoItem[],
): Promise<number | null> {
  if (!channel.id) return null
  const channelText = normalizeText(`${channel.snippet?.title ?? ''} ${channel.snippet?.description ?? ''}`)
  const corpus = [
    channelText,
    ...videos.map((video) => normalizeText(`${video.snippet?.title ?? ''} ${video.snippet?.description ?? ''}`)),
  ]
  const includeMatched =
    !profile.includeTerms.length ||
    profile.includeTerms.some((term) => corpus.some((text) => containsPhrase(text, term)))
  const excluded = profile.excludeTerms.some((term) => corpus.some((text) => containsPhrase(text, term)))
  if (!includeMatched || excluded) return null

  const matchedReferences: DiscoveryReferenceSnapshot[] = []
  const evidence: { reference: DiscoveryReferenceSnapshot; video: VideoItem; terms: string[] }[] = []
  const descriptionMatchCounts = new Map<string, number>()
  for (const reference of profile.references) {
    for (const term of uniqueStrings([reference.label, ...reference.aliases])) {
      const key = normalizeText(term)
      const count = videos.filter((video) =>
        containsPhrase(normalizeText(video.snippet?.description ?? ''), term),
      ).length
      descriptionMatchCounts.set(key, count)
    }
  }
  const descriptionMatchLimit = Math.max(2, Math.ceil(videos.length * 0.2))
  for (const reference of profile.references) {
    const terms = uniqueStrings([reference.label, ...reference.aliases])
    const matches = videos.flatMap((video) => {
      const title = normalizeText(video.snippet?.title ?? '')
      const description = normalizeText(video.snippet?.description ?? '')
      const matched = terms.filter(
        (term) =>
          containsPhrase(title, term) ||
          (containsPhrase(description, term) &&
            (descriptionMatchCounts.get(normalizeText(term)) ?? 0) <= descriptionMatchLimit),
      )
      return matched.length ? [{ reference, video, terms: matched }] : []
    })
    if (matches.length) {
      matchedReferences.push(reference)
      evidence.push(...matches)
    }
  }
  if (!matchedReferences.length) return null

  const candidate = await upsertCandidate(db, channel, videos)
  const contacts = profile.discoverContacts
    ? uniqueContacts([
        ...extractPublicContacts(channel.snippet?.description ?? '', candidate.channelUrl),
        ...videos.flatMap((video) =>
          extractPublicContacts(video.snippet?.description ?? '', `https://www.youtube.com/watch?v=${video.id}`),
        ),
      ])
    : []
  const fit = fitCandidate({
    profile,
    matchedReferences,
    matchedVideoCount: evidence.length,
    latestVideoAt: candidate.latestVideoAt,
    subscriberCount: candidate.subscriberCount,
    avgViews: candidate.avgViews,
    contacts,
  })
  await db
    .insert(creatorDiscoveryRunCandidates)
    .values({
      runId,
      candidateId: candidate.id,
      fitScore: fit.score,
      matchedReferenceCount: matchedReferences.length,
      matchedReferencesJson: JSON.stringify(matchedReferences.map((reference) => reference.label)),
      matchedVideoCount: evidence.length,
      fitReasonsJson: JSON.stringify(fit.reasons),
    })
    .onConflictDoUpdate({
      target: [creatorDiscoveryRunCandidates.runId, creatorDiscoveryRunCandidates.candidateId],
      set: {
        fitScore: fit.score,
        matchedReferenceCount: matchedReferences.length,
        matchedReferencesJson: JSON.stringify(matchedReferences.map((reference) => reference.label)),
        matchedVideoCount: evidence.length,
        fitReasonsJson: JSON.stringify(fit.reasons),
        updatedAt: now(),
      },
    })
  for (const item of evidence) {
    if (!item.video.id) continue
    await db
      .insert(creatorDiscoveryEvidence)
      .values({
        runId,
        candidateId: candidate.id,
        referenceId: item.reference.id,
        videoId: item.video.id,
        videoTitle: item.video.snippet?.title ?? item.video.id,
        videoUrl: `https://www.youtube.com/watch?v=${item.video.id}`,
        publishedAt: item.video.snippet?.publishedAt ?? null,
        viewCount: numberOrNull(item.video.statistics?.viewCount),
        matchedTermsJson: JSON.stringify(item.terms),
      })
      .onConflictDoNothing()
  }
  for (const contact of contacts) {
    await db
      .insert(creatorDiscoveryContacts)
      .values({ runId, candidateId: candidate.id, ...contact })
      .onConflictDoNothing()
  }
  return contacts.filter((contact) => contact.type === 'business_email').length
}

function youtubeSearchTaskKey(query: string, relevanceLanguage?: string, pageToken?: string): string {
  return createHash('sha256')
    .update(`${query}\n${relevanceLanguage ?? ''}\n${pageToken ?? ''}`)
    .digest('hex')
}

async function runResultCounts(db: DB, runId: string): Promise<{ candidates: number; businessEmails: number }> {
  const [candidateCount, emailCount] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(creatorDiscoveryRunCandidates)
      .where(eq(creatorDiscoveryRunCandidates.runId, runId)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(creatorDiscoveryContacts)
      .where(and(eq(creatorDiscoveryContacts.runId, runId), eq(creatorDiscoveryContacts.type, 'business_email'))),
  ])
  return {
    candidates: Number(candidateCount[0]?.count ?? 0),
    businessEmails: Number(emailCount[0]?.count ?? 0),
  }
}

async function ensureYoutubeRunState(
  db: DB,
  run: typeof creatorDiscoveryRuns.$inferSelect,
  profile: DiscoveryProfileSnapshot,
): Promise<void> {
  const [existingSearch, existingChannel] = await Promise.all([
    db
      .select({ id: creatorDiscoveryRunSearches.id })
      .from(creatorDiscoveryRunSearches)
      .where(eq(creatorDiscoveryRunSearches.runId, run.id))
      .limit(1),
    db
      .select({ id: creatorDiscoveryRunChannels.id })
      .from(creatorDiscoveryRunChannels)
      .where(eq(creatorDiscoveryRunChannels.runId, run.id))
      .limit(1),
  ])
  if (existingSearch.length || existingChannel.length) return

  const seedChannelIds = uniqueStrings(
    profile.seedChannels.map(channelIdFromSeed).filter((value): value is string => !!value),
  ).slice(0, profile.maxChannels)
  const initialSearches = new Map<
    string,
    { taskKey: string; query: string; relevanceLanguage: string | null; priority: number }
  >()
  for (const reference of profile.references) {
    const queries = uniqueStrings([reference.queryTerms[0] ?? '', reference.label, ...reference.queryTerms.slice(1)])
    queries.forEach((query, index) => {
      const relevanceLanguage = profile.languages[0] ?? null
      const taskKey = youtubeSearchTaskKey(query, relevanceLanguage ?? undefined)
      const priority = index === 0 ? 100 : 10 - index
      const existing = initialSearches.get(taskKey)
      if (!existing || priority > existing.priority) {
        initialSearches.set(taskKey, { taskKey, query, relevanceLanguage, priority })
      }
    })
  }
  const resultCounts = await runResultCounts(db, run.id)
  await db.transaction(async (tx) => {
    if (seedChannelIds.length) {
      await tx
        .insert(creatorDiscoveryRunChannels)
        .values(seedChannelIds.map((channelId) => ({ runId: run.id, channelId })))
        .onConflictDoNothing()
    }
    if (initialSearches.size) {
      await tx
        .insert(creatorDiscoveryRunSearches)
        .values([...initialSearches.values()].map((task) => ({ runId: run.id, ...task })))
        .onConflictDoNothing()
    }
    await tx
      .update(creatorDiscoveryRuns)
      .set({
        channelsFound: seedChannelIds.length,
        channelsScanned: 0,
        videosScanned: 0,
        candidatesStaged: resultCounts.candidates,
        contactsFound: resultCounts.businessEmails,
        heartbeatAt: now(),
      })
      .where(eq(creatorDiscoveryRuns.id, run.id))
  })
}

async function finishYoutubeChannel(
  db: DB,
  runId: string,
  queueId: string,
  status: 'scanned' | 'skipped',
  videosScanned: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(creatorDiscoveryRunChannels)
      .set({ status, updatedAt: now() })
      .where(and(eq(creatorDiscoveryRunChannels.id, queueId), eq(creatorDiscoveryRunChannels.status, 'queued')))
      .returning({ id: creatorDiscoveryRunChannels.id })
    if (!changed.length) return
    await tx
      .update(creatorDiscoveryRuns)
      .set({
        channelsScanned: sql`${creatorDiscoveryRuns.channelsScanned} + 1`,
        videosScanned: sql`${creatorDiscoveryRuns.videosScanned} + ${videosScanned}`,
        heartbeatAt: now(),
      })
      .where(eq(creatorDiscoveryRuns.id, runId))
  })
}

async function runYouTubeDiscovery(
  db: DB,
  apiKey: string,
  run: typeof creatorDiscoveryRuns.$inferSelect,
  maxChannelsPerInvocation?: number,
): Promise<boolean> {
  const profile = JSON.parse(run.profileSnapshotJson) as DiscoveryProfileSnapshot
  if (!profile.references.length) throw new Error('Discovery profile has no references')
  await ensureYoutubeRunState(db, run, profile)
  const storedChannels = await db
    .select({ channelId: creatorDiscoveryRunChannels.channelId })
    .from(creatorDiscoveryRunChannels)
    .where(eq(creatorDiscoveryRunChannels.runId, run.id))
  const persistedChannelIds = new Set(storedChannels.map((row) => row.channelId))
  const channelIds = new Set(persistedChannelIds)
  let searches = run.searchRequestsUsed
  await setRunProgress(db, run.id, { phase: 'searching', status: 'running', channelsFound: channelIds.size })
  while (searches < profile.maxSearchRequests && channelIds.size < profile.maxChannels) {
    const task = (
      await db
        .select()
        .from(creatorDiscoveryRunSearches)
        .where(and(eq(creatorDiscoveryRunSearches.runId, run.id), eq(creatorDiscoveryRunSearches.status, 'queued')))
        .orderBy(desc(creatorDiscoveryRunSearches.priority), asc(creatorDiscoveryRunSearches.createdAt))
        .limit(1)
    )[0]
    if (!task) break
    const before = channelIds.size
    const result = await youtubeRequest<YoutubeList<SearchItem>>(
      db,
      apiKey,
      run.id,
      'search',
      {
        part: 'snippet',
        type: 'video',
        maxResults: '50',
        order: 'relevance',
        q: task.query,
        ...(task.relevanceLanguage ? { relevanceLanguage: task.relevanceLanguage } : {}),
        ...(task.pageToken ? { pageToken: task.pageToken } : {}),
      },
      'search',
    )
    searches++
    for (const item of result.items ?? []) {
      const channelId = item.snippet?.channelId ?? item.id?.channelId
      if (channelId) channelIds.add(channelId)
      if (channelIds.size >= profile.maxChannels) break
    }
    const yieldCount = channelIds.size - before
    const newChannelIds = [...channelIds].filter((channelId) => !persistedChannelIds.has(channelId))
    await db.transaction(async (tx) => {
      if (newChannelIds.length) {
        await tx
          .insert(creatorDiscoveryRunChannels)
          .values(newChannelIds.map((channelId) => ({ runId: run.id, channelId })))
          .onConflictDoNothing()
        newChannelIds.forEach((channelId) => persistedChannelIds.add(channelId))
      }
      if (result.nextPageToken && yieldCount > 0 && channelIds.size < profile.maxChannels) {
        await tx
          .insert(creatorDiscoveryRunSearches)
          .values({
            runId: run.id,
            taskKey: youtubeSearchTaskKey(task.query, task.relevanceLanguage ?? undefined, result.nextPageToken),
            query: task.query,
            pageToken: result.nextPageToken,
            relevanceLanguage: task.relevanceLanguage,
            priority: Math.min(80, yieldCount),
          })
          .onConflictDoNothing()
      }
      await tx
        .update(creatorDiscoveryRunSearches)
        .set({ status: 'completed', completedAt: now(), updatedAt: now() })
        .where(eq(creatorDiscoveryRunSearches.id, task.id))
      await tx
        .update(creatorDiscoveryRuns)
        .set({ channelsFound: channelIds.size, heartbeatAt: now() })
        .where(eq(creatorDiscoveryRuns.id, run.id))
    })
  }

  await assertRunActive(db, run.id)
  await setRunProgress(db, run.id, { phase: 'scanning_channels', channelsFound: channelIds.size })
  const sliceLimit = Math.min(50, Math.max(1, maxChannelsPerInvocation ?? profile.maxChannels))
  const queuedChannels = await db
    .select()
    .from(creatorDiscoveryRunChannels)
    .where(and(eq(creatorDiscoveryRunChannels.runId, run.id), eq(creatorDiscoveryRunChannels.status, 'queued')))
    .orderBy(asc(creatorDiscoveryRunChannels.createdAt), asc(creatorDiscoveryRunChannels.id))
    .limit(sliceLimit)
  let channelItems = new Map<string, ChannelItem>()
  if (queuedChannels.length) {
    const result = await youtubeRequest<YoutubeList<ChannelItem>>(
      db,
      apiKey,
      run.id,
      'channels',
      {
        part: 'snippet,statistics,contentDetails',
        id: queuedChannels.map((row) => row.channelId).join(','),
        maxResults: String(Math.min(50, queuedChannels.length)),
      },
      'data',
    )
    channelItems = new Map((result.items ?? []).flatMap((item) => (item.id ? [[item.id, item] as const] : [])))
  }

  for (const queuedChannel of queuedChannels) {
    await assertRunActive(db, run.id)
    const channel = channelItems.get(queuedChannel.channelId)
    if (!channel) {
      await finishYoutubeChannel(db, run.id, queuedChannel.id, 'skipped', 0)
      continue
    }
    const playlistId = channel.contentDetails?.relatedPlaylists?.uploads
    if (!playlistId || !channel.id) {
      await finishYoutubeChannel(db, run.id, queuedChannel.id, 'skipped', 0)
      continue
    }
    const videoIds: string[] = []
    let pageToken: string | undefined
    while (videoIds.length < profile.recentVideoLimit) {
      const result = await youtubeRequest<YoutubeList<PlaylistItem>>(
        db,
        apiKey,
        run.id,
        'playlistItems',
        {
          part: 'snippet',
          playlistId,
          maxResults: String(Math.min(50, profile.recentVideoLimit - videoIds.length)),
          ...(pageToken ? { pageToken } : {}),
        },
        'data',
      )
      for (const item of result.items ?? []) {
        const videoId = item.snippet?.resourceId?.videoId
        if (!videoId) continue
        videoIds.push(videoId)
      }
      pageToken = result.nextPageToken
      if (!pageToken || !(result.items?.length ?? 0)) break
    }
    const videos: VideoItem[] = []
    for (let offset = 0; offset < videoIds.length; offset += 50) {
      const result = await youtubeRequest<YoutubeList<VideoItem>>(
        db,
        apiKey,
        run.id,
        'videos',
        { part: 'snippet,statistics', id: videoIds.slice(offset, offset + 50).join(','), maxResults: '50' },
        'data',
      )
      videos.push(...(result.items ?? []))
    }
    await stageChannel(db, run.id, profile, channel, videos)
    await finishYoutubeChannel(db, run.id, queuedChannel.id, 'scanned', videos.length)
  }

  const [remaining, resultCounts] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(creatorDiscoveryRunChannels)
      .where(and(eq(creatorDiscoveryRunChannels.runId, run.id), eq(creatorDiscoveryRunChannels.status, 'queued'))),
    runResultCounts(db, run.id),
  ])
  await setRunProgress(db, run.id, {
    candidatesStaged: resultCounts.candidates,
    contactsFound: resultCounts.businessEmails,
  })
  if (Number(remaining[0]?.count ?? 0) > 0) return false

  await setRunProgress(db, run.id, { phase: 'matching_references' })
  await db.transaction(async (tx) => {
    await tx.delete(creatorDiscoveryRunSearches).where(eq(creatorDiscoveryRunSearches.runId, run.id))
    await tx.delete(creatorDiscoveryRunChannels).where(eq(creatorDiscoveryRunChannels.runId, run.id))
    await tx
      .update(creatorDiscoveryRuns)
      .set({
        phase: 'staging',
        youtubeCompletedAt: now(),
        candidatesStaged: resultCounts.candidates,
        contactsFound: resultCounts.businessEmails,
        heartbeatAt: now(),
      })
      .where(eq(creatorDiscoveryRuns.id, run.id))
  })
  return true
}

async function runDiscovery(
  db: DB,
  youtubeApiKey: string | undefined,
  scrapeCreatorsApiKey: string | undefined,
  run: typeof creatorDiscoveryRuns.$inferSelect,
  options?: { maxYoutubeChannelsPerInvocation?: number },
): Promise<boolean> {
  const snapshot = JSON.parse(run.profileSnapshotJson) as Partial<DiscoveryProfileSnapshot>
  const platforms: DiscoveryPlatform[] = Array.isArray(snapshot.platforms) ? snapshot.platforms : ['youtube']
  if (platforms.includes('youtube') && !run.youtubeCompletedAt) {
    if (!youtubeApiKey) throw new Error('YouTube API key is not configured')
    const youtubeComplete = await runYouTubeDiscovery(db, youtubeApiKey, run, options?.maxYoutubeChannelsPerInvocation)
    if (!youtubeComplete) return false
  }
  const socialPlatforms = SOCIAL_DISCOVERY_PLATFORMS.filter((platform) => platforms.includes(platform))
  if (socialPlatforms.length) {
    if (!scrapeCreatorsApiKey) throw new Error('ScrapeCreators API key is not configured')
    await runSocialDiscovery(db, scrapeCreatorsApiKey, run, socialPlatforms)
  }
  return true
}

function uniqueContacts(contacts: PublicContact[]): PublicContact[] {
  const seen = new Set<string>()
  return contacts.filter((contact) => {
    const key = `${contact.type}:${contact.normalizedValue}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

let workerRunning = false

/** Recover the run owned by a terminated discovery utility process. */
export async function recoverInterruptedDiscoveryRuns(db: DB): Promise<{ requeued: number; partial: number }> {
  const runningRuns = await db
    .select({ id: creatorDiscoveryRuns.id })
    .from(creatorDiscoveryRuns)
    .where(eq(creatorDiscoveryRuns.status, 'running'))
  let requeued = 0
  let partial = 0
  for (const run of runningRuns) {
    const [youtubeInFlight, socialInFlight] = await Promise.all([
      db
        .select({ id: youtubeApiRequests.id })
        .from(youtubeApiRequests)
        .where(and(eq(youtubeApiRequests.lastRunId, run.id), eq(youtubeApiRequests.status, 'running')))
        .limit(1),
      db
        .select({ id: creatorDiscoveryApiRequests.id })
        .from(creatorDiscoveryApiRequests)
        .where(
          and(eq(creatorDiscoveryApiRequests.lastRunId, run.id), eq(creatorDiscoveryApiRequests.status, 'running')),
        )
        .limit(1),
    ])
    const timestamp = now()
    if (youtubeInFlight.length || socialInFlight.length) {
      await db.transaction(async (tx) => {
        if (youtubeInFlight.length) {
          await tx
            .update(youtubeApiRequests)
            .set({ status: 'uncertain', error: 'Worker stopped during a reserved request', updatedAt: timestamp })
            .where(and(eq(youtubeApiRequests.lastRunId, run.id), eq(youtubeApiRequests.status, 'running')))
        }
        if (socialInFlight.length) {
          await tx
            .update(creatorDiscoveryApiRequests)
            .set({ status: 'uncertain', error: 'Worker stopped during a reserved request', updatedAt: timestamp })
            .where(
              and(eq(creatorDiscoveryApiRequests.lastRunId, run.id), eq(creatorDiscoveryApiRequests.status, 'running')),
            )
        }
        await tx
          .update(creatorDiscoveryRuns)
          .set({
            status: 'partial',
            phase: 'partial',
            error: 'Discovery worker stopped during a provider request; retry requires confirmation',
            finishedAt: timestamp,
            heartbeatAt: timestamp,
          })
          .where(eq(creatorDiscoveryRuns.id, run.id))
      })
      partial += 1
    } else {
      await db
        .update(creatorDiscoveryRuns)
        .set({ status: 'queued', phase: 'queued', error: 'Recovered after worker restart', heartbeatAt: timestamp })
        .where(eq(creatorDiscoveryRuns.id, run.id))
      requeued += 1
    }
  }
  return { requeued, partial }
}

/** Process one durable multi-platform creator-discovery run while the desktop application is open. */
export async function processYouTubeDiscoveryQueue(
  db: DB,
  secrets?: SecretsStore,
  options?: { maxYoutubeChannelsPerInvocation?: number },
): Promise<string | null> {
  if (workerRunning) return null
  const youtubeApiKey = secrets?.getApiKey('youtube')
  const scrapeCreatorsApiKey = secrets?.getApiKey('scrapecreators')
  if (!youtubeApiKey && !scrapeCreatorsApiKey) return null
  workerRunning = true
  try {
    const today = quotaDate()
    const waitingRuns = await db
      .select({ id: creatorDiscoveryRuns.id, heartbeatAt: creatorDiscoveryRuns.heartbeatAt })
      .from(creatorDiscoveryRuns)
      .where(eq(creatorDiscoveryRuns.status, 'waiting_for_quota'))
    for (const waiting of waitingRuns) {
      const exhaustedOn = waiting.heartbeatAt ? quotaDate(new Date(waiting.heartbeatAt)) : ''
      if (exhaustedOn && exhaustedOn === today) continue
      await db
        .update(creatorDiscoveryRuns)
        .set({ status: 'queued', phase: 'queued', error: null, heartbeatAt: now() })
        .where(eq(creatorDiscoveryRuns.id, waiting.id))
    }
    const staleBefore = new Date(Date.now() - STALE_RUN_MS).toISOString()
    await db
      .update(creatorDiscoveryRuns)
      .set({ status: 'queued', phase: 'queued', error: 'Recovered after worker restart' })
      .where(
        and(
          eq(creatorDiscoveryRuns.status, 'running'),
          or(lt(creatorDiscoveryRuns.heartbeatAt, staleBefore), isNull(creatorDiscoveryRuns.heartbeatAt)),
        ),
      )
    let run = (
      await db
        .select()
        .from(creatorDiscoveryRuns)
        .where(eq(creatorDiscoveryRuns.status, 'queued'))
        .orderBy(asc(creatorDiscoveryRuns.createdAt))
        .limit(1)
    )[0]
    if (!run) return null
    const queuedSnapshot = JSON.parse(run.profileSnapshotJson) as Partial<DiscoveryProfileSnapshot>
    if (Array.isArray(queuedSnapshot.platforms) && queuedSnapshot.platforms.length === 0) {
      const resolvedPlatforms: DiscoveryPlatform[] = [
        ...(youtubeApiKey ? (['youtube'] as const) : []),
        ...(scrapeCreatorsApiKey ? SOCIAL_DISCOVERY_PLATFORMS : []),
      ]
      const resolvedSnapshot = { ...queuedSnapshot, platforms: resolvedPlatforms } as DiscoveryProfileSnapshot
      const resolvedHash = hashDiscoveryProfile(resolvedSnapshot)
      await db
        .update(creatorDiscoveryRuns)
        .set({ profileSnapshotJson: JSON.stringify(resolvedSnapshot), profileHash: resolvedHash })
        .where(eq(creatorDiscoveryRuns.id, run.id))
      run = { ...run, profileSnapshotJson: JSON.stringify(resolvedSnapshot), profileHash: resolvedHash }
    }
    await db
      .update(creatorDiscoveryRuns)
      .set({
        status: 'running',
        phase: 'searching',
        error: null,
        startedAt: run.startedAt ?? now(),
        heartbeatAt: now(),
      })
      .where(eq(creatorDiscoveryRuns.id, run.id))
    try {
      const completed = await runDiscovery(db, youtubeApiKey, scrapeCreatorsApiKey, run, options)
      await db
        .update(creatorDiscoveryRuns)
        .set(
          completed
            ? { status: 'completed', phase: 'completed', finishedAt: now(), heartbeatAt: now() }
            : { status: 'queued', phase: 'scanning_channels', error: null, heartbeatAt: now() },
        )
        .where(and(eq(creatorDiscoveryRuns.id, run.id), eq(creatorDiscoveryRuns.status, 'running')))
    } catch (error) {
      if (error instanceof RunInterruptedError || error instanceof SocialRunInterruptedError) {
        if (error.status === 'cancelled') {
          await db
            .update(creatorDiscoveryRuns)
            .set({ phase: 'cancelled', finishedAt: now(), heartbeatAt: now() })
            .where(eq(creatorDiscoveryRuns.id, run.id))
        }
      } else if (error instanceof QuotaExhaustedError) {
        await db
          .update(creatorDiscoveryRuns)
          .set({ status: 'waiting_for_quota', phase: 'waiting_for_quota', error: error.message, heartbeatAt: now() })
          .where(eq(creatorDiscoveryRuns.id, run.id))
      } else if (error instanceof UncertainRequestError) {
        await db
          .update(creatorDiscoveryRuns)
          .set({ status: 'partial', phase: 'partial', error: error.message, finishedAt: now(), heartbeatAt: now() })
          .where(eq(creatorDiscoveryRuns.id, run.id))
      } else if (error instanceof SocialRequestUncertainError) {
        await db
          .update(creatorDiscoveryRuns)
          .set({ status: 'partial', phase: 'partial', error: error.message, finishedAt: now(), heartbeatAt: now() })
          .where(eq(creatorDiscoveryRuns.id, run.id))
      } else if (error instanceof SocialBudgetError) {
        await db
          .update(creatorDiscoveryRuns)
          .set({ status: 'failed', phase: 'failed', error: error.message, finishedAt: now(), heartbeatAt: now() })
          .where(eq(creatorDiscoveryRuns.id, run.id))
      } else {
        await db
          .update(creatorDiscoveryRuns)
          .set({
            status: 'failed',
            phase: 'failed',
            error: error instanceof Error ? error.message : String(error),
            finishedAt: now(),
            heartbeatAt: now(),
          })
          .where(eq(creatorDiscoveryRuns.id, run.id))
      }
    }
    return run.id
  } finally {
    workerRunning = false
  }
}

export async function youtubeQuotaStatus(db: DB, apiKey?: string) {
  const date = quotaDate()
  if (!apiKey) {
    return {
      configured: false,
      quotaDate: date,
      timeZone: 'America/Los_Angeles',
      source: 'local_ledger' as const,
      search: { used: 0, limit: YOUTUBE_SEARCH_DAILY_LIMIT, remaining: YOUTUBE_SEARCH_DAILY_LIMIT },
      data: { used: 0, limit: YOUTUBE_DATA_DAILY_LIMIT, remaining: YOUTUBE_DATA_DAILY_LIMIT },
    }
  }
  const fingerprint = youtubeKeyFingerprint(apiKey)
  const rows = await db
    .select()
    .from(youtubeQuotaUsage)
    .where(and(eq(youtubeQuotaUsage.keyFingerprint, fingerprint), eq(youtubeQuotaUsage.quotaDate, date)))
  const bucket = (name: 'search' | 'data', limit: number) => {
    const used = rows.find((row) => row.bucket === name)?.used ?? 0
    return { used, limit, remaining: Math.max(0, limit - used) }
  }
  return {
    configured: true,
    quotaDate: date,
    timeZone: 'America/Los_Angeles',
    source: 'local_ledger' as const,
    keyFingerprint: fingerprint,
    search: bucket('search', YOUTUBE_SEARCH_DAILY_LIMIT),
    data: bucket('data', YOUTUBE_DATA_DAILY_LIMIT),
  }
}

export async function creatorDiscoveryProviderStatus(db: DB, keys: { youtube?: string; scrapecreators?: string }) {
  const [youtube, social] = await Promise.all([
    youtubeQuotaStatus(db, keys.youtube),
    scrapeCreatorsStatus(db, keys.scrapecreators),
  ])
  const platforms: DiscoveryPlatform[] = [
    ...(youtube.configured ? (['youtube'] as const) : []),
    ...(social.configured ? SOCIAL_DISCOVERY_PLATFORMS : []),
  ]
  return {
    configured: platforms.length > 0,
    platforms,
    youtube,
    social,
  }
}

type CreatorRow = typeof creators.$inferSelect
type DiscoveryCandidateRow = typeof creatorDiscoveryCandidates.$inferSelect

function parseJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  try {
    const value = raw ? JSON.parse(raw) : []
    return Array.isArray(value) ? (value as T[]) : []
  } catch {
    return []
  }
}

function discoveryChannelKey(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value.trim())
    const host = url.host.replace(/^www\./, '').toLocaleLowerCase()
    const path = url.pathname.replace(/\/+$/, '').toLocaleLowerCase()
    return `${host}${path}` || null
  } catch {
    const normalized = value
      .trim()
      .toLocaleLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
    return normalized || null
  }
}

function platformHandleUrl(platform: string, handle: string): string {
  const normalized = handle.replace(/^@/, '')
  if (platform === 'youtube') return `https://youtube.com/@${normalized}`
  if (platform === 'instagram') return `https://instagram.com/${normalized}`
  if (platform === 'tiktok') return `https://tiktok.com/@${normalized}`
  if (platform === 'twitter') return `https://x.com/${normalized}`
  return handle
}

function candidateIdentityKeys(candidate: DiscoveryCandidateRow): Set<string> {
  const values = [candidate.channelUrl]
  if (candidate.handle) values.push(platformHandleUrl(candidate.platform, candidate.handle))
  return new Set(values.map(discoveryChannelKey).filter((value): value is string => !!value))
}

function creatorIdentityKeys(creator: CreatorRow, platform: string): Set<string> {
  const values: Array<string | null | undefined> = []
  if (creator.primaryPlatform === platform) values.push(creator.channelKey, creator.handle)
  for (const channel of parseJsonArray<Record<string, unknown>>(creator.channelsJson)) {
    if (String(channel.platform ?? '').toLocaleLowerCase() !== platform) continue
    const handle = typeof channel.handle === 'string' ? channel.handle : null
    values.push(typeof channel.url === 'string' ? channel.url : null)
    if (handle) values.push(platformHandleUrl(platform, handle))
  }
  return new Set(values.map(discoveryChannelKey).filter((value): value is string => !!value))
}

function emailIdentityKeys(contacts: Array<Record<string, unknown>>): Set<string> {
  const keys = new Set<string>()
  for (const contact of contacts) {
    const type = String(contact.type ?? '')
      .trim()
      .toLocaleLowerCase()
    if (!['email', 'business_email'].includes(type)) continue
    const value = String(contact.normalizedValue ?? contact.value ?? '')
      .trim()
      .toLocaleLowerCase()
    if (value) keys.add(value)
  }
  return keys
}

function existingCreatorForCandidate(
  allCreators: CreatorRow[],
  candidate: DiscoveryCandidateRow,
  discoveredContacts: Array<Record<string, unknown>> = [],
): CreatorRow | undefined {
  const exact =
    candidate.platform === 'youtube'
      ? allCreators.find((creator) => creator.youtubeChannelId === candidate.externalId)
      : undefined
  if (exact) return exact
  const candidateKeys = candidateIdentityKeys(candidate)
  const sameChannel = allCreators.find((creator) => {
    for (const key of creatorIdentityKeys(creator, candidate.platform)) if (candidateKeys.has(key)) return true
    return false
  })
  if (sameChannel) return sameChannel
  const candidateEmails = emailIdentityKeys(discoveredContacts)
  if (!candidateEmails.size) return undefined
  return allCreators.find((creator) => {
    // A shared agency address must never merge two accounts from the same platform.
    // Across platforms, an exact public email is the only non-channel identity signal we accept.
    if (creator.primaryPlatform === candidate.platform) return false
    for (const email of emailIdentityKeys(parseJsonArray<Record<string, unknown>>(creator.contactsJson))) {
      if (candidateEmails.has(email)) return true
    }
    return false
  })
}

function mergeStringLists(existingRaw: string | null | undefined, incomingRaw: string): string {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const value of [...parseJsonArray(existingRaw), ...parseJsonArray(incomingRaw)]) {
    if (typeof value !== 'string') continue
    const normalized = value.trim().toLocaleLowerCase()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    merged.push(value.trim())
  }
  return JSON.stringify(merged)
}

function contactIdentity(contact: Record<string, unknown>): string {
  const type = String(contact.type ?? '')
    .trim()
    .toLocaleLowerCase()
  const value = String(contact.value ?? '')
    .trim()
    .toLocaleLowerCase()
  return `${type}:${value}`
}

function mergeContacts(existingRaw: string | null | undefined, discovered: Record<string, unknown>[]): string {
  const existing = parseJsonArray<Record<string, unknown>>(existingRaw)
  const merged = [...existing]
  const seen = new Set(existing.map(contactIdentity))
  for (const contact of discovered) {
    const key = contactIdentity(contact)
    if (key === ':' || seen.has(key)) continue
    seen.add(key)
    merged.push(contact)
  }
  return JSON.stringify(merged)
}

function mergeDiscoveryChannels(existingRaw: string | null | undefined, candidate: DiscoveryCandidateRow): string {
  const channels = parseJsonArray<Record<string, unknown>>(existingRaw)
  const incoming: Record<string, unknown> = {
    platform: candidate.platform,
    source: 'scrape',
    metricsSource: candidate.platform === 'youtube' ? 'youtube_api' : 'scrapecreators',
    url: candidate.channelUrl,
    handle: candidate.handle,
    ...(candidate.platform === 'youtube' ? { youtubeChannelId: candidate.externalId } : {}),
    subscribers: candidate.subscriberCount,
    avgViews: candidate.avgViews,
    lastPostAt: candidate.latestVideoAt,
    postsPerMonth: candidate.cadencePerMonth,
  }
  const candidateKeys = candidateIdentityKeys(candidate)
  let channelIndex = channels.findIndex((channel) => {
    if (String(channel.platform ?? '').toLocaleLowerCase() !== candidate.platform) return false
    const values = [channel.url, channel.handle]
    return values.some((value) => {
      if (typeof value !== 'string') return false
      const normalized = discoveryChannelKey(
        value === channel.handle ? platformHandleUrl(candidate.platform, value) : value,
      )
      return !!normalized && candidateKeys.has(normalized)
    })
  })
  if (channelIndex < 0) {
    channelIndex = channels.findIndex(
      (channel) => String(channel.platform ?? '').toLocaleLowerCase() === candidate.platform,
    )
  }
  if (channelIndex < 0) channels.push(incoming)
  else {
    const current = channels[channelIndex]!
    channels[channelIndex] = {
      ...incoming,
      ...current,
      source: current.source ?? 'manual',
      metricsSource: candidate.platform === 'youtube' ? 'youtube_api' : 'scrapecreators',
      ...(candidate.platform === 'youtube' ? { youtubeChannelId: candidate.externalId } : {}),
      subscribers: candidate.subscriberCount,
      avgViews: candidate.avgViews,
      lastPostAt: candidate.latestVideoAt,
      postsPerMonth: candidate.cadencePerMonth,
    }
  }
  return JSON.stringify(channels)
}

export async function previewDiscoveryPromotions(db: DB, runId: string, candidateIds: string[]) {
  if (!candidateIds.length) return { created: 0, updated: 0 }
  const [candidateRows, allCreators, contacts] = await Promise.all([
    db
      .select({ candidate: creatorDiscoveryCandidates })
      .from(creatorDiscoveryRunCandidates)
      .innerJoin(
        creatorDiscoveryCandidates,
        eq(creatorDiscoveryCandidates.id, creatorDiscoveryRunCandidates.candidateId),
      )
      .where(
        and(
          eq(creatorDiscoveryRunCandidates.runId, runId),
          inArray(creatorDiscoveryRunCandidates.candidateId, candidateIds),
        ),
      ),
    db.select().from(creators),
    db
      .select()
      .from(creatorDiscoveryContacts)
      .where(
        and(eq(creatorDiscoveryContacts.runId, runId), inArray(creatorDiscoveryContacts.candidateId, candidateIds)),
      ),
  ])
  const simulatedCreators = [...allCreators]
  let updated = 0
  for (const { candidate } of candidateRows) {
    const candidateContacts = contacts.filter((contact) => contact.candidateId === candidate.id)
    const existing = existingCreatorForCandidate(simulatedCreators, candidate, candidateContacts)
    if (existing) {
      updated++
      continue
    }
    simulatedCreators.push({
      id: `preview:${candidate.id}`,
      name: candidate.name,
      entityType: 'person',
      handle: candidate.channelUrl,
      kind: 'other',
      primaryPlatform: candidate.platform,
      youtubeChannelId: candidate.platform === 'youtube' ? candidate.externalId : null,
      channelKey: discoveryChannelKey(candidate.channelUrl),
      thumbnailUrl: candidate.thumbnailUrl,
      channelsJson: JSON.stringify([
        { platform: candidate.platform, url: candidate.channelUrl, handle: candidate.handle },
      ]),
      audience: candidate.subscriberCount,
      avgViews: candidate.avgViews,
      engagementRate: null,
      lastActiveAt: candidate.latestVideoAt,
      cadencePerMonth: candidate.cadencePerMonth,
      topicsJson: null,
      playedGamesJson: null,
      language: candidate.defaultLanguage,
      region: candidate.country,
      contactsJson: JSON.stringify(candidateContacts),
      costUsd: null,
      acceptsKeysOnly: null,
      currency: null,
      rateNote: null,
      doNotContact: false,
      notes: null,
      description: candidate.description,
      dataRefreshedAt: candidate.fetchedAt,
      dataExpiresAt: candidate.expiresAt,
      source: 'scrape',
      createdAt: now(),
      updatedAt: now(),
    })
  }
  return { created: candidateRows.length - updated, updated }
}

export async function promoteDiscoveryCandidate(db: DB, runId: string, candidateId: string) {
  return withSqliteBusyRetry(() =>
    db.transaction(async (tx) => {
      const row = (
        await tx
          .select({
            candidate: creatorDiscoveryCandidates,
            runCandidate: creatorDiscoveryRunCandidates,
            run: creatorDiscoveryRuns,
          })
          .from(creatorDiscoveryRunCandidates)
          .innerJoin(
            creatorDiscoveryCandidates,
            eq(creatorDiscoveryCandidates.id, creatorDiscoveryRunCandidates.candidateId),
          )
          .innerJoin(creatorDiscoveryRuns, eq(creatorDiscoveryRuns.id, creatorDiscoveryRunCandidates.runId))
          .where(
            and(
              eq(creatorDiscoveryRunCandidates.runId, runId),
              eq(creatorDiscoveryRunCandidates.candidateId, candidateId),
            ),
          )
          .limit(1)
      )[0]
      if (!row) throw new Error('Discovery candidate not found')
      const contacts = await tx
        .select()
        .from(creatorDiscoveryContacts)
        .where(and(eq(creatorDiscoveryContacts.runId, runId), eq(creatorDiscoveryContacts.candidateId, candidateId)))
      const canonicalChannelKey =
        discoveryChannelKey(row.candidate.channelUrl) ??
        `${row.candidate.platform}:${row.candidate.externalId.toLocaleLowerCase()}`
      const candidateKeys = [...candidateIdentityKeys(row.candidate)]
      let existing: CreatorRow | undefined =
        row.candidate.platform === 'youtube'
          ? (
              await tx.select().from(creators).where(eq(creators.youtubeChannelId, row.candidate.externalId)).limit(1)
            )[0]
          : undefined
      if (!existing && candidateKeys.length) {
        existing = (await tx.select().from(creators).where(inArray(creators.channelKey, candidateKeys)).limit(1))[0]
      }
      if (!existing) {
        const identityCandidates = await tx.select().from(creators)
        existing = existingCreatorForCandidate(identityCandidates, row.candidate, contacts)
      }
      const discoveredContacts = contacts.map((contact) => ({
        type: contact.type,
        value: contact.value,
        source: 'scrape',
        sourceUrl: contact.sourceUrl,
        confidence: contact.confidence,
        verified: false,
        gated: contact.gated,
      }))
      const channelsJson = mergeDiscoveryChannels(existing?.channelsJson, row.candidate)
      const contactsJson = mergeContacts(existing?.contactsJson, discoveredContacts)
      const playedGamesJson = mergeStringLists(existing?.playedGamesJson, row.runCandidate.matchedReferencesJson)
      const creatorValues = {
        name: row.candidate.name,
        handle: row.candidate.channelUrl,
        kind:
          row.candidate.platform === 'youtube'
            ? 'youtuber'
            : row.candidate.platform === 'tiktok'
              ? 'tiktoker'
              : 'other',
        primaryPlatform: row.candidate.platform,
        youtubeChannelId: row.candidate.platform === 'youtube' ? row.candidate.externalId : null,
        channelKey: canonicalChannelKey,
        thumbnailUrl: row.candidate.thumbnailUrl,
        channelsJson,
        audience: row.candidate.subscriberCount,
        avgViews: row.candidate.avgViews,
        cadencePerMonth: row.candidate.cadencePerMonth,
        lastActiveAt: row.candidate.latestVideoAt,
        language: row.candidate.defaultLanguage,
        region: row.candidate.country,
        contactsJson,
        playedGamesJson,
        description: row.candidate.description,
        source: 'scrape' as const,
        dataRefreshedAt: row.candidate.fetchedAt,
        dataExpiresAt: row.candidate.expiresAt,
        updatedAt: now(),
      }
      let creatorId: string
      if (existing) {
        creatorId = existing.id
        const refreshPrimaryMetrics =
          existing.source === 'scrape' && existing.primaryPlatform === row.candidate.platform
        await tx
          .update(creators)
          .set({
            // Existing cards are user-owned. Discovery only fills missing identity fields,
            // merges evidence/contacts, and refreshes measurements owned by discovery.
            primaryPlatform: existing.primaryPlatform ?? row.candidate.platform,
            youtubeChannelId:
              existing.youtubeChannelId ?? (row.candidate.platform === 'youtube' ? row.candidate.externalId : null),
            channelKey: existing.channelKey ?? canonicalChannelKey,
            thumbnailUrl: refreshPrimaryMetrics ? row.candidate.thumbnailUrl : existing.thumbnailUrl,
            channelsJson,
            audience: refreshPrimaryMetrics ? row.candidate.subscriberCount : existing.audience,
            avgViews: refreshPrimaryMetrics ? row.candidate.avgViews : existing.avgViews,
            cadencePerMonth: refreshPrimaryMetrics ? row.candidate.cadencePerMonth : existing.cadencePerMonth,
            lastActiveAt: refreshPrimaryMetrics ? row.candidate.latestVideoAt : existing.lastActiveAt,
            language: existing.language ?? row.candidate.defaultLanguage,
            region: existing.region ?? row.candidate.country,
            contactsJson,
            playedGamesJson,
            dataRefreshedAt: row.candidate.fetchedAt,
            dataExpiresAt: row.candidate.expiresAt,
            updatedAt: now(),
          })
          .where(eq(creators.id, creatorId))
      } else {
        // Supplying the id avoids keeping an INSERT ... RETURNING statement alive
        // when SQLite reaches COMMIT on older local libSQL bindings.
        creatorId = crypto.randomUUID()
        await tx.insert(creators).values({ ...creatorValues, id: creatorId })
      }
      await tx
        .insert(creatorPicks)
        .values({ gameId: row.run.gameId, creatorId, addedBy: 'scrape' })
        .onConflictDoNothing()
      await tx
        .update(creatorDiscoveryRunCandidates)
        .set({ status: 'promoted', creatorId, updatedAt: now() })
        .where(
          and(
            eq(creatorDiscoveryRunCandidates.runId, runId),
            eq(creatorDiscoveryRunCandidates.candidateId, candidateId),
          ),
        )
      return { creatorId, created: !existing }
    }),
  )
}

export async function expireYoutubeDiscoveryCache(db: DB): Promise<void> {
  const cutoff = now()
  const expiredCreators = await db.select().from(creators).where(lt(creators.dataExpiresAt, cutoff))
  for (const creator of expiredCreators) {
    let contacts: Record<string, unknown>[] = []
    let channels: Record<string, unknown>[] = []
    try {
      const parsed = creator.contactsJson ? JSON.parse(creator.contactsJson) : []
      contacts = Array.isArray(parsed) ? parsed.filter((item) => item?.source !== 'scrape') : []
    } catch {
      contacts = []
    }
    try {
      const parsed = creator.channelsJson ? JSON.parse(creator.channelsJson) : []
      channels = Array.isArray(parsed)
        ? parsed.flatMap((item) => {
            if (creator.source === 'scrape' || item?.source === 'scrape') return []
            if (!['youtube_api', 'scrapecreators'].includes(item?.metricsSource)) return [item]
            const {
              subscribers: _subscribers,
              avgViews: _avgViews,
              lastPostAt: _lastPostAt,
              postsPerMonth: _postsPerMonth,
              metricsSource: _metricsSource,
              ...manualChannel
            } = item
            return [manualChannel]
          })
        : []
    } catch {
      channels = []
    }
    const discoveryOwned = creator.source === 'scrape'
    await db
      .update(creators)
      .set({
        thumbnailUrl: discoveryOwned ? null : creator.thumbnailUrl,
        channelsJson: channels.length ? JSON.stringify(channels) : null,
        audience: discoveryOwned ? null : creator.audience,
        avgViews: discoveryOwned ? null : creator.avgViews,
        cadencePerMonth: discoveryOwned ? null : creator.cadencePerMonth,
        lastActiveAt: discoveryOwned ? null : creator.lastActiveAt,
        playedGamesJson: discoveryOwned ? null : creator.playedGamesJson,
        contactsJson: contacts.length ? JSON.stringify(contacts) : null,
        description: discoveryOwned ? null : creator.description,
        dataRefreshedAt: null,
        dataExpiresAt: null,
        updatedAt: now(),
      })
      .where(eq(creators.id, creator.id))
  }
}

function parseArchiveJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Build a deterministic, secret-free project artifact for one discovery run. */
export async function youtubeDiscoveryArchiveContent(
  db: DB,
  runId: string,
): Promise<{
  gameId: string
  content: string
} | null> {
  const run = (await db.select().from(creatorDiscoveryRuns).where(eq(creatorDiscoveryRuns.id, runId)).limit(1))[0]
  if (!run) return null

  const rows = await db
    .select({ result: creatorDiscoveryRunCandidates, candidate: creatorDiscoveryCandidates })
    .from(creatorDiscoveryRunCandidates)
    .innerJoin(creatorDiscoveryCandidates, eq(creatorDiscoveryCandidates.id, creatorDiscoveryRunCandidates.candidateId))
    .where(eq(creatorDiscoveryRunCandidates.runId, runId))
  rows.sort(
    (left, right) =>
      right.result.fitScore - left.result.fitScore ||
      right.result.matchedReferenceCount - left.result.matchedReferenceCount ||
      left.candidate.externalId.localeCompare(right.candidate.externalId),
  )

  const candidateIds = rows.map(({ candidate }) => candidate.id)
  const [contacts, evidence] = candidateIds.length
    ? await Promise.all([
        db
          .select()
          .from(creatorDiscoveryContacts)
          .where(
            and(eq(creatorDiscoveryContacts.runId, runId), inArray(creatorDiscoveryContacts.candidateId, candidateIds)),
          ),
        db
          .select()
          .from(creatorDiscoveryEvidence)
          .where(
            and(eq(creatorDiscoveryEvidence.runId, runId), inArray(creatorDiscoveryEvidence.candidateId, candidateIds)),
          ),
      ])
    : [[], []]

  const { profileSnapshotJson, ...runRecord } = run
  const artifact = {
    schemaVersion: 1,
    kind: 'creator-discovery-run',
    run: runRecord,
    profileSnapshot: parseArchiveJson(profileSnapshotJson),
    results: rows.map(({ candidate, result }) => {
      const { matchedReferencesJson, fitReasonsJson, ...resultRecord } = result
      return {
        candidate,
        result: {
          ...resultRecord,
          matchedReferences: parseArchiveJson(matchedReferencesJson),
          fitReasons: parseArchiveJson(fitReasonsJson),
        },
        contacts: contacts
          .filter((contact) => contact.candidateId === candidate.id)
          .sort(
            (left, right) =>
              left.type.localeCompare(right.type) || left.normalizedValue.localeCompare(right.normalizedValue),
          ),
        evidence: evidence
          .filter((item) => item.candidateId === candidate.id)
          .sort(
            (left, right) =>
              (right.publishedAt ?? '').localeCompare(left.publishedAt ?? '') ||
              left.videoId.localeCompare(right.videoId),
          )
          .map(({ matchedTermsJson, ...item }) => ({
            ...item,
            matchedTerms: parseArchiveJson(matchedTermsJson),
          })),
      }
    }),
  }
  return { gameId: run.gameId, content: `${JSON.stringify(artifact, null, 2)}\n` }
}

/** Mirror durable DB results into the configured project workspace. */
export async function syncYouTubeDiscoveryRunArchive(
  db: DB,
  workspace: MarkdownWorkspaceCoordinator,
  runId: string,
): Promise<{ path: string; changed: boolean } | null> {
  const artifact = await youtubeDiscoveryArchiveContent(db, runId)
  if (!artifact) return null
  return workspace.writeDiscoveryArchive(artifact.gameId, runId, artifact.content)
}

/** Reconcile all discovery artifacts after startup or mutations performed over MCP. */
export async function syncYouTubeDiscoveryArchives(
  db: DB,
  workspace: MarkdownWorkspaceCoordinator,
  gameId?: string,
): Promise<YouTubeDiscoveryArchiveSyncResult> {
  const configs = (await workspace.listConfigs()).filter(
    (config) => config.enabled && (!gameId || config.gameId === gameId),
  )
  let runs = 0
  let written = 0
  for (const config of configs) {
    const rows = await db
      .select({ id: creatorDiscoveryRuns.id })
      .from(creatorDiscoveryRuns)
      .where(eq(creatorDiscoveryRuns.gameId, config.gameId))
      .orderBy(asc(creatorDiscoveryRuns.createdAt))
    for (const row of rows) {
      const result = await syncYouTubeDiscoveryRunArchive(db, workspace, row.id)
      if (!result) continue
      runs += 1
      if (result.changed) written += 1
    }
  }
  return { runs, written }
}
