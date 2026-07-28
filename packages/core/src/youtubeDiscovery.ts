import { createHash } from 'node:crypto'
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import {
  creatorDiscoveryCandidates,
  creatorDiscoveryContacts,
  creatorDiscoveryEvidence,
  creatorDiscoveryRunCandidates,
  creatorDiscoveryRuns,
  creators,
  creatorPicks,
  youtubeApiRequests,
  youtubeQuotaUsage,
  type DB,
} from '@marcat/db'
import type { SecretsStore } from './context'

export const YOUTUBE_SEARCH_DAILY_LIMIT = 100
export const YOUTUBE_DATA_DAILY_LIMIT = 10_000
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3'
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const STALE_REQUEST_MS = 2 * 60 * 1_000
const STALE_RUN_MS = 5 * 60 * 1_000

export type DiscoveryMode = 'games' | 'topic'
export type DiscoveryRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_for_quota'
  | 'partial'
  | 'completed'
  | 'failed'
  | 'cancelled'

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
          responseJson: null,
          cacheExpiresAt: null,
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
      .select()
      .from(youtubeApiRequests)
      .where(and(eq(youtubeApiRequests.keyFingerprint, fingerprint), eq(youtubeApiRequests.requestHash, hash)))
      .limit(1)
  )[0]
  if (existing?.status === 'succeeded' && existing.responseJson && existing.cacheExpiresAt! > now()) {
    return JSON.parse(existing.responseJson) as T
  }
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
      throw new Error(`YouTube API ${response.status}: ${body.slice(0, 300) || response.statusText}`)
    }
    const parsed = JSON.parse(body) as T
    await db
      .update(youtubeApiRequests)
      .set({
        status: 'succeeded',
        responseJson: body,
        cacheExpiresAt: expiresAt(),
        error: null,
        completedAt: now(),
        updatedAt: now(),
      })
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
  for (const reference of profile.references) {
    const terms = uniqueStrings([reference.label, ...reference.aliases])
    const matches = videos.flatMap((video) => {
      const text = normalizeText(`${video.snippet?.title ?? ''} ${video.snippet?.description ?? ''}`)
      const matched = terms.filter((term) => containsPhrase(text, term))
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

async function runDiscovery(db: DB, apiKey: string, run: typeof creatorDiscoveryRuns.$inferSelect): Promise<void> {
  const profile = JSON.parse(run.profileSnapshotJson) as DiscoveryProfileSnapshot
  if (!profile.references.length) throw new Error('Discovery profile has no references')
  const channelIds = new Set(profile.seedChannels.map(channelIdFromSeed).filter((value): value is string => !!value))
  const searchQueue: { reference: DiscoveryReferenceSnapshot; query: string; pageToken?: string; priority: number }[] =
    []
  for (const reference of profile.references) {
    const queries = uniqueStrings([reference.queryTerms[0] ?? '', reference.label, ...reference.queryTerms.slice(1)])
    queries.forEach((query, index) => searchQueue.push({ reference, query, priority: index === 0 ? 100 : 10 - index }))
  }
  let searches = 0
  await setRunProgress(db, run.id, { phase: 'searching', status: 'running', channelsFound: channelIds.size })
  while (searchQueue.length && searches < profile.maxSearchRequests && channelIds.size < profile.maxChannels) {
    searchQueue.sort((a, b) => b.priority - a.priority)
    const task = searchQueue.shift()!
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
        ...(profile.languages[0] ? { relevanceLanguage: profile.languages[0] } : {}),
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
    if (result.nextPageToken && yieldCount > 0) {
      searchQueue.push({ ...task, pageToken: result.nextPageToken, priority: Math.min(80, yieldCount) })
    }
    await setRunProgress(db, run.id, { channelsFound: channelIds.size })
  }

  await assertRunActive(db, run.id)
  await setRunProgress(db, run.id, { phase: 'scanning_channels', channelsFound: channelIds.size })
  const ids = [...channelIds].slice(0, profile.maxChannels)
  const channelItems: ChannelItem[] = []
  for (let offset = 0; offset < ids.length; offset += 50) {
    const result = await youtubeRequest<YoutubeList<ChannelItem>>(
      db,
      apiKey,
      run.id,
      'channels',
      { part: 'snippet,statistics,contentDetails', id: ids.slice(offset, offset + 50).join(','), maxResults: '50' },
      'data',
    )
    channelItems.push(...(result.items ?? []).filter((item) => item.id))
  }

  let staged = 0
  let contactCount = 0
  let videosScanned = 0
  for (let channelIndex = 0; channelIndex < channelItems.length; channelIndex++) {
    await assertRunActive(db, run.id)
    const channel = channelItems[channelIndex]!
    const playlistId = channel.contentDetails?.relatedPlaylists?.uploads
    if (!playlistId || !channel.id) continue
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
    videosScanned += videos.length
    const foundEmails = await stageChannel(db, run.id, profile, channel, videos)
    if (foundEmails != null) {
      staged++
      contactCount += foundEmails
    }
    if (channelIndex % 5 === 0 || channelIndex === channelItems.length - 1) {
      await setRunProgress(db, run.id, {
        channelsScanned: channelIndex + 1,
        videosScanned,
        candidatesStaged: staged,
        contactsFound: contactCount,
      })
    }
  }

  await setRunProgress(db, run.id, { phase: 'matching_references' })
  await setRunProgress(db, run.id, { phase: 'staging', candidatesStaged: staged, contactsFound: contactCount })
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

/** Process one durable YouTube discovery run while the desktop application is open. */
export async function processYouTubeDiscoveryQueue(db: DB, secrets?: SecretsStore): Promise<void> {
  if (workerRunning) return
  const apiKey = secrets?.getApiKey('youtube')
  if (!apiKey) return
  workerRunning = true
  try {
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
    const run = (
      await db
        .select()
        .from(creatorDiscoveryRuns)
        .where(eq(creatorDiscoveryRuns.status, 'queued'))
        .orderBy(asc(creatorDiscoveryRuns.createdAt))
        .limit(1)
    )[0]
    if (!run) return
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
      await runDiscovery(db, apiKey, run)
      await db
        .update(creatorDiscoveryRuns)
        .set({ status: 'completed', phase: 'completed', finishedAt: now(), heartbeatAt: now() })
        .where(eq(creatorDiscoveryRuns.id, run.id))
    } catch (error) {
      if (error instanceof RunInterruptedError) {
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

export async function promoteDiscoveryCandidate(db: DB, runId: string, candidateId: string) {
  return db.transaction(async (tx) => {
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
    const existing = (
      await tx
        .select()
        .from(creators)
        .where(
          or(
            eq(creators.youtubeChannelId, row.candidate.externalId),
            eq(creators.channelKey, `youtube.com/channel/${row.candidate.externalId.toLocaleLowerCase()}`),
          ),
        )
        .limit(1)
    )[0]
    const channelsJson = JSON.stringify([
      {
        platform: 'youtube',
        url: row.candidate.channelUrl,
        handle: row.candidate.handle,
        subscribers: row.candidate.subscriberCount,
        avgViews: row.candidate.avgViews,
        lastPostAt: row.candidate.latestVideoAt,
        postsPerMonth: row.candidate.cadencePerMonth,
      },
    ])
    const contactsJson = JSON.stringify(
      contacts.map((contact) => ({
        type: contact.type,
        value: contact.value,
        source: 'scrape',
        sourceUrl: contact.sourceUrl,
        confidence: contact.confidence,
        verified: false,
        gated: contact.gated,
      })),
    )
    const creatorValues = {
      name: row.candidate.name,
      handle: row.candidate.channelUrl,
      kind: 'youtuber',
      primaryPlatform: 'youtube',
      youtubeChannelId: row.candidate.externalId,
      channelKey: `youtube.com/channel/${row.candidate.externalId.toLocaleLowerCase()}`,
      thumbnailUrl: row.candidate.thumbnailUrl,
      channelsJson,
      audience: row.candidate.subscriberCount,
      avgViews: row.candidate.avgViews,
      cadencePerMonth: row.candidate.cadencePerMonth,
      lastActiveAt: row.candidate.latestVideoAt,
      language: row.candidate.defaultLanguage,
      region: row.candidate.country,
      contactsJson,
      playedGamesJson: row.runCandidate.matchedReferencesJson,
      description: row.candidate.description,
      source: 'scrape' as const,
      dataRefreshedAt: row.candidate.fetchedAt,
      dataExpiresAt: row.candidate.expiresAt,
      updatedAt: now(),
    }
    let creatorId: string
    if (existing) {
      creatorId = existing.id
      await tx.update(creators).set(creatorValues).where(eq(creators.id, creatorId))
    } else {
      const inserted = await tx.insert(creators).values(creatorValues).returning({ id: creators.id })
      creatorId = inserted[0]!.id
    }
    await tx.insert(creatorPicks).values({ gameId: row.run.gameId, creatorId, addedBy: 'scrape' }).onConflictDoNothing()
    await tx
      .update(creatorDiscoveryRunCandidates)
      .set({ status: 'promoted', creatorId, updatedAt: now() })
      .where(
        and(eq(creatorDiscoveryRunCandidates.runId, runId), eq(creatorDiscoveryRunCandidates.candidateId, candidateId)),
      )
    return { creatorId, created: !existing }
  })
}

export async function expireYoutubeDiscoveryCache(db: DB): Promise<void> {
  const cutoff = now()
  await db
    .update(youtubeApiRequests)
    .set({ responseJson: null, updatedAt: now() })
    .where(and(eq(youtubeApiRequests.status, 'succeeded'), lt(youtubeApiRequests.cacheExpiresAt, cutoff)))
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
      channels = Array.isArray(parsed) ? parsed.filter((item) => item?.platform !== 'youtube') : []
    } catch {
      channels = []
    }
    await db
      .update(creators)
      .set({
        thumbnailUrl: null,
        channelsJson: channels.length ? JSON.stringify(channels) : null,
        audience: null,
        avgViews: null,
        cadencePerMonth: null,
        lastActiveAt: null,
        playedGamesJson: null,
        contactsJson: contacts.length ? JSON.stringify(contacts) : null,
        description: null,
        dataRefreshedAt: null,
        dataExpiresAt: null,
        updatedAt: now(),
      })
      .where(eq(creators.id, creator.id))
  }
  await db.delete(creatorDiscoveryCandidates).where(lt(creatorDiscoveryCandidates.expiresAt, cutoff))
}
