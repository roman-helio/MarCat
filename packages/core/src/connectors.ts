/**
 * Content connectors. Network/file side-effects live here (desktop runs core in
 * the Electron main process; a future web build would swap this layer).
 *
 * Free: steam (CSV folder — handled in the sources router, not here).
 * Paid: twitter/X (twitterapi.io), instagram + tiktok (ScrapeCreators).
 *
 * Third-party response shapes vary; `normalize()` scans the common field names,
 * so a connector survives minor API differences. Endpoints are documented inline
 * and isolated so they're a one-line fix if a provider changes paths.
 */

export interface RawPost {
  externalId: string
  occurredAt: string // YYYY-MM-DD
  title: string
  url: string | null
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
}

export type Platform =
  | 'steam'
  | 'twitter'
  | 'instagram'
  | 'tiktok'
  | 'youtube'
  | 'reddit'
  | 'telegram'
  | 'steam_reviews'
  | 'google_play_reviews'
  | 'itch_comments'
  | 'gamejolt_comments'
  | 'poki_comments'
  | 'crazygames_comments'
  | 'incrementaldb_comments'

export interface PlatformInfo {
  kind: 'content' | 'feedback'
  paid: boolean // costs money per request (dry-run + budget gate)
  needsKey: boolean // requires an API key (paid OR free-with-key like YouTube)
  provider: string | null // API-key provider name (safeStorage key)
  costPerRequest: number // rough USD estimate per sync request
  label: string
}

export const PLATFORMS: Record<Platform, PlatformInfo> = {
  steam: {
    kind: 'content',
    paid: false,
    needsKey: false,
    provider: null,
    costPerRequest: 0,
    label: 'Steam (CSV folder)',
  },
  youtube: { kind: 'content', paid: false, needsKey: true, provider: 'youtube', costPerRequest: 0, label: 'YouTube' },
  reddit: { kind: 'content', paid: false, needsKey: false, provider: null, costPerRequest: 0, label: 'Reddit' },
  telegram: { kind: 'content', paid: false, needsKey: false, provider: null, costPerRequest: 0, label: 'Telegram' },
  twitter: {
    kind: 'content',
    paid: true,
    needsKey: true,
    provider: 'twitterapi',
    costPerRequest: 0.003,
    label: 'X / Twitter',
  },
  instagram: {
    kind: 'content',
    paid: true,
    needsKey: true,
    provider: 'scrapecreators',
    costPerRequest: 47 / 25_000,
    label: 'Instagram',
  },
  tiktok: {
    kind: 'content',
    paid: true,
    needsKey: true,
    provider: 'scrapecreators',
    costPerRequest: 47 / 25_000,
    label: 'TikTok',
  },
  steam_reviews: {
    kind: 'feedback',
    paid: false,
    needsKey: false,
    provider: null,
    costPerRequest: 0,
    label: 'Steam · отзывы',
  },
  google_play_reviews: {
    kind: 'feedback',
    paid: false,
    needsKey: false,
    provider: null,
    costPerRequest: 0,
    label: 'Google Play · отзывы',
  },
  itch_comments: {
    kind: 'feedback',
    paid: false,
    needsKey: false,
    provider: null,
    costPerRequest: 0,
    label: 'itch.io · комментарии',
  },
  gamejolt_comments: {
    kind: 'feedback',
    paid: false,
    needsKey: false,
    provider: null,
    costPerRequest: 0,
    label: 'Game Jolt · комментарии',
  },
  poki_comments: {
    kind: 'feedback',
    paid: false,
    needsKey: false,
    provider: null,
    costPerRequest: 0,
    label: 'Poki · отзывы',
  },
  crazygames_comments: {
    kind: 'feedback',
    paid: false,
    needsKey: false,
    provider: null,
    costPerRequest: 0,
    label: 'CrazyGames · отзывы',
  },
  incrementaldb_comments: {
    kind: 'feedback',
    paid: false,
    needsKey: false,
    provider: null,
    costPerRequest: 0,
    label: 'Incremental DB · комментарии',
  },
}

export const isPlatform = (p: string): p is Platform => p in PLATFORMS

const numOf = (...vals: unknown[]): number | null => {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}
const strOf = (...vals: unknown[]): string => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim()
  return ''
}
const toIso = (v: unknown): string => {
  const s = typeof v === 'string' || typeof v === 'number' ? v : ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10)
}

/** Find the first array of post-like objects anywhere shallow in a response. */
function postArray(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[]
  const o = (json ?? {}) as Record<string, unknown>
  for (const key of ['tweets', 'posts', 'videos', 'items', 'data', 'results']) {
    const v = o[key]
    if (Array.isArray(v)) return v as Record<string, unknown>[]
    if (v && typeof v === 'object') {
      const nested = postArray(v)
      if (nested.length) return nested
    }
  }
  return []
}

function normalize(raw: Record<string, unknown>): RawPost {
  return {
    externalId: strOf(raw.id, raw.id_str, raw.pk, raw.shortcode, raw.aweme_id, raw.video_id) || strOf(raw.url),
    occurredAt: toIso(raw.createdAt ?? raw.created_at ?? raw.taken_at ?? raw.create_time ?? raw.timestamp),
    title: strOf(raw.text, raw.full_text, raw.caption, raw.title, raw.description, raw.desc).slice(0, 200),
    url: strOf(raw.url, raw.permalink, raw.link, raw.share_url) || null,
    views: numOf(raw.viewCount, raw.views, raw.view_count, raw.play_count, raw.video_view_count),
    likes: numOf(raw.likeCount, raw.likes, raw.favorite_count, raw.like_count, raw.digg_count),
    comments: numOf(raw.replyCount, raw.comments, raw.comment_count, raw.reply_count),
    shares: numOf(raw.retweetCount, raw.shares, raw.share_count, raw.retweet_count),
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers })
  const body = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`Non-JSON response: ${body.slice(0, 200)}`)
  }
}

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers })
  const body = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
  return body
}

/** Parse a compact count like "1.2K" / "3M" into a number. */
const parseCompact = (s: string): number | null => {
  const m = s.replace(/\s/g, '').match(/^([\d.,]+)\s*([KkMmBb])?/)
  if (!m) return null
  const n = Number(m[1]!.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const suf = (m[2] ?? '').toLowerCase()
  return Math.round(n * (suf === 'k' ? 1e3 : suf === 'm' ? 1e6 : suf === 'b' ? 1e9 : 1))
}
const stripTags = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

/** Reddit — public JSON, no key. Tracks a user's submitted posts. */
async function fetchReddit(handle: string): Promise<RawPost[]> {
  const user = handle.replace(/^@/, '').replace(/^\/?u\//i, '')
  const json = (await getJson(`https://www.reddit.com/user/${encodeURIComponent(user)}/submitted.json?limit=25`, {
    'User-Agent': 'MarCat/1.0 (marketing tracker)',
  })) as Record<string, unknown>
  const data = (json.data ?? {}) as Record<string, unknown>
  const children = Array.isArray(data.children) ? data.children : []
  return children
    .map((c) => {
      const d = ((c as Record<string, unknown>).data ?? {}) as Record<string, unknown>
      const created = typeof d.created_utc === 'number' ? d.created_utc * 1000 : Date.now()
      return {
        externalId: strOf(d.id, d.name),
        occurredAt: new Date(created).toISOString().slice(0, 10),
        title: strOf(d.title).slice(0, 200),
        url: d.permalink ? `https://www.reddit.com${strOf(d.permalink)}` : strOf(d.url) || null,
        views: null,
        likes: numOf(d.ups, d.score),
        comments: numOf(d.num_comments),
        shares: null,
      } as RawPost
    })
    .filter((p) => p.externalId)
}

/** Telegram — scrape the public t.me/s/<channel> web preview, no key. */
async function fetchTelegram(handle: string): Promise<RawPost[]> {
  const channel = handle
    .replace(/^@/, '')
    .replace(/^https?:\/\/t\.me\/(s\/)?/i, '')
    .replace(/\/$/, '')
  const html = await getText(`https://t.me/s/${encodeURIComponent(channel)}`)
  const posts: RawPost[] = []
  for (const b of html.split('tgme_widget_message_wrap').slice(1)) {
    const post = b.match(/data-post="([^"]+)"/)?.[1]
    if (!post) continue
    const textHtml = b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ''
    const views = b.match(/tgme_widget_message_views[^>]*>([^<]+)</)?.[1] ?? ''
    const date = b.match(/datetime="([^"]+)"/)?.[1] ?? ''
    posts.push({
      externalId: post,
      occurredAt: toIso(date),
      title: stripTags(textHtml).slice(0, 200) || '(media)',
      url: `https://t.me/${post}`,
      views: parseCompact(views),
      likes: null,
      comments: null,
      shares: null,
    })
  }
  return posts
}

/** YouTube — Data API v3 (free, needs an API key). Channel uploads → video stats. */
async function fetchYouTube(handle: string, apiKey: string): Promise<RawPost[]> {
  const h = handle.replace(/^@/, '')
  const ch = (await getJson(
    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(h)}&key=${apiKey}`,
  )) as Record<string, unknown>
  const items = Array.isArray(ch.items) ? ch.items : []
  const cd = ((items[0] as Record<string, unknown>)?.contentDetails ?? {}) as Record<string, unknown>
  const uploads = strOf((cd.relatedPlaylists as Record<string, unknown>)?.uploads)
  if (!uploads) throw new Error('YouTube channel not found for that handle')
  const pl = (await getJson(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=20&playlistId=${uploads}&key=${apiKey}`,
  )) as Record<string, unknown>
  const ids = (Array.isArray(pl.items) ? pl.items : [])
    .map((i) => strOf(((i as Record<string, unknown>).contentDetails as Record<string, unknown>)?.videoId))
    .filter(Boolean)
  if (!ids.length) return []
  const vids = (await getJson(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids.join(',')}&key=${apiKey}`,
  )) as Record<string, unknown>
  return (Array.isArray(vids.items) ? vids.items : [])
    .map((v) => {
      const o = v as Record<string, unknown>
      const sn = (o.snippet ?? {}) as Record<string, unknown>
      const st = (o.statistics ?? {}) as Record<string, unknown>
      return {
        externalId: strOf(o.id),
        occurredAt: toIso(sn.publishedAt),
        title: strOf(sn.title).slice(0, 200),
        url: `https://youtu.be/${strOf(o.id)}`,
        views: numOf(st.viewCount),
        likes: numOf(st.likeCount),
        comments: numOf(st.commentCount),
        shares: null,
      } as RawPost
    })
    .filter((p) => p.externalId)
}

/**
 * Fetch the latest posts for one social account. Free: reddit, telegram (no key),
 * youtube (key, no cost). Paid: twitter/X (twitterapi.io), instagram + tiktok
 * (ScrapeCreators). Provider endpoints are isolated so they're a one-line fix.
 */
export async function fetchPosts(platform: Platform, handle: string, apiKey: string): Promise<RawPost[]> {
  if (platform === 'reddit') return fetchReddit(handle)
  if (platform === 'telegram') return fetchTelegram(handle)
  if (platform === 'youtube') return fetchYouTube(handle, apiKey)
  const h = handle.replace(/^@/, '').trim()
  let json: unknown
  if (platform === 'twitter') {
    json = await getJson(`https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(h)}`, {
      'X-API-Key': apiKey,
    })
  } else if (platform === 'instagram') {
    json = await getJson(`https://api.scrapecreators.com/v1/instagram/user/posts?handle=${encodeURIComponent(h)}`, {
      'x-api-key': apiKey,
    })
  } else if (platform === 'tiktok') {
    json = await getJson(`https://api.scrapecreators.com/v1/tiktok/profile/videos?handle=${encodeURIComponent(h)}`, {
      'x-api-key': apiKey,
    })
  } else {
    throw new Error(`No connector for ${platform}`)
  }
  return postArray(json)
    .map(normalize)
    .filter((p) => p.externalId)
}
