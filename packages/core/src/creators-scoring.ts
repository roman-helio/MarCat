import type { Creator } from '@marcat/db'

/**
 * Deterministic creator↔game fit score (0–100), computed ON THE FLY (never stored,
 * like the lift/hits-fails analytics). The cat may explain/propose, but the number
 * is math, not LLM. Correlation-flavoured heuristic, not a guarantee.
 */

export interface FitContext {
  /** Current project title; an exact played-game match is strong evidence. */
  gameName?: string
  /** Topics/genres/tags describing the game (lowercased match target). */
  gameTopics: string[]
  /** Target market languages (e.g. ['en','ru']); empty = don't score language. */
  targetLanguages?: string[]
  /** Target regions; empty = don't score region. */
  targetRegions?: string[]
  /** Marketing budget in USD, if the user set one. Undefined = cost degrades to a keys-only bonus. */
  budgetUsd?: number
  /** Realized lift from this creator's PAST beats for this game, and how many beats. */
  pastLift?: { total: number; count: number }
}

export interface FitComponent {
  key: string
  /** Normalized 0..1 contribution before weighting. */
  value: number
  weight: number
  reason: string
}

export interface FitResult {
  score: number // 0..100
  components: FitComponent[]
  reasons: string[]
}

const WEIGHTS = {
  topic: 0.22,
  playedGames: 0.08,
  audience: 0.2,
  activity: 0.15,
  engagement: 0.1,
  locale: 0.1,
  cost: 0.1,
  past: 0.05,
} as const

function parseTopics(creator: Creator): string[] {
  if (!creator.topicsJson) return []
  try {
    const arr = JSON.parse(creator.topicsJson)
    return Array.isArray(arr) ? arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : []
  } catch {
    return []
  }
}

function parsePlayedGames(creator: Creator): string[] {
  if (!creator.playedGamesJson) return []
  try {
    const arr = JSON.parse(creator.playedGamesJson)
    return Array.isArray(arr) ? arr.map((title) => String(title).trim().toLowerCase()).filter(Boolean) : []
  } catch {
    return []
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/** Jaccard overlap of two string sets (0..1). */
function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const A = new Set(a)
  const B = new Set(b)
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = A.size + B.size - inter
  return union ? inter / union : 0
}

/** Log-scaled 0..1 where `ref` maps to ~1.0. */
function logScale(x: number | null | undefined, ref: number): number {
  if (!x || x <= 0) return 0
  return Math.min(1, Math.log10(1 + x) / Math.log10(1 + ref))
}

/** Days since an ISO date; null-safe (returns Infinity if missing). */
function daysSince(iso: string | null | undefined, nowIso: string): number {
  if (!iso) return Infinity
  const then = new Date(iso).getTime()
  const now = new Date(nowIso).getTime()
  if (Number.isNaN(then) || Number.isNaN(now)) return Infinity
  return (now - then) / 86_400_000
}

export function computeFit(creator: Creator, ctx: FitContext, nowIso = new Date().toISOString()): FitResult {
  const components: FitComponent[] = []

  // Topic match.
  const topics = parseTopics(creator)
  const gameTopics = ctx.gameTopics.map(norm).filter(Boolean)
  const topicVal = jaccard(topics, gameTopics)
  components.push({
    key: 'topic',
    value: topicVal,
    weight: WEIGHTS.topic,
    reason:
      topicVal > 0
        ? `тема совпадает (${Math.round(topicVal * 100)}%)`
        : topics.length
          ? 'темы не пересекаются с игрой'
          : 'темы креэйтора не заданы',
  })

  // Played games — exact title overlap with the current game or game-title tags/comparables.
  const playedGames = parsePlayedGames(creator)
  const gameTargets = [ctx.gameName, ...ctx.gameTopics].filter((value): value is string => !!value).map(norm)
  const matchingGames = playedGames.filter((title) => gameTargets.includes(title))
  const playedGamesVal = matchingGames.length ? 1 : 0
  components.push({
    key: 'playedGames',
    value: playedGamesVal,
    weight: WEIGHTS.playedGames,
    reason: matchingGames.length
      ? `играл в ${matchingGames.slice(0, 2).join(', ')}`
      : playedGames.length
        ? 'совпадений по играм нет'
        : 'сыгранные игры не заданы',
  })

  // Audience — log-scaled, 250k subs ≈ 1.0.
  const audienceVal = logScale(creator.audience, 250_000)
  components.push({
    key: 'audience',
    value: audienceVal,
    weight: WEIGHTS.audience,
    reason: creator.audience ? `аудитория ~${creator.audience.toLocaleString('ru-RU')}` : 'аудитория неизвестна',
  })

  // Activity — freshness of last post + cadence. Dead channels penalized.
  const dsince = daysSince(creator.lastActiveAt, nowIso)
  const freshness = dsince === Infinity ? 0 : Math.max(0, 1 - dsince / 90) // 0 days=1, 90+ days=0
  const cadence = Math.min(1, (creator.cadencePerMonth ?? 0) / 8) // 8+ posts/mo ≈ 1
  const activityVal = creator.lastActiveAt || creator.cadencePerMonth ? 0.6 * freshness + 0.4 * cadence : 0
  components.push({
    key: 'activity',
    value: activityVal,
    weight: WEIGHTS.activity,
    reason:
      dsince === Infinity
        ? 'активность неизвестна'
        : dsince > 90
          ? `неактивен ${Math.round(dsince)} дн. — риск`
          : `активен (${Math.round(dsince)} дн. назад)`,
  })

  // Engagement rate (already a ratio; 10% ≈ excellent).
  const engVal = Math.min(1, (creator.engagementRate ?? 0) / 0.1)
  components.push({
    key: 'engagement',
    value: engVal,
    weight: WEIGHTS.engagement,
    reason: creator.engagementRate
      ? `вовлечённость ${(creator.engagementRate * 100).toFixed(1)}%`
      : 'вовлечённость неизвестна',
  })

  // Language / region match (skipped if targets not given → neutral 0.5).
  let localeVal = 0.5
  let localeReason = 'язык/регион не заданы'
  if (ctx.targetLanguages?.length && creator.language) {
    const hit = ctx.targetLanguages.map(norm).includes(norm(creator.language))
    localeVal = hit ? 1 : 0.15
    localeReason = hit ? `язык ${creator.language} ✓` : `язык ${creator.language} вне таргета`
  } else if (ctx.targetRegions?.length && creator.region) {
    const hit = ctx.targetRegions.map(norm).includes(norm(creator.region))
    localeVal = hit ? 1 : 0.15
    localeReason = hit ? `регион ${creator.region} ✓` : `регион ${creator.region} вне таргета`
  }
  components.push({ key: 'locale', value: localeVal, weight: WEIGHTS.locale, reason: localeReason })

  // Cost. If a budget is set, affordability; otherwise a keys-only bonus.
  let costVal: number
  let costReason: string
  if (ctx.budgetUsd && ctx.budgetUsd > 0) {
    if (creator.acceptsKeysOnly) {
      costVal = 1
      costReason = 'берёт ключами (бесплатно)'
    } else if (creator.costUsd == null) {
      costVal = 0.5
      costReason = 'цена неизвестна'
    } else {
      costVal = creator.costUsd <= ctx.budgetUsd ? 1 - creator.costUsd / (ctx.budgetUsd * 2) : 0.1
      costReason =
        creator.costUsd <= ctx.budgetUsd ? `$${creator.costUsd} в бюджете` : `$${creator.costUsd} выше бюджета`
    }
  } else {
    // No budget defined → the component degrades to a keys-only bonus.
    costVal = creator.acceptsKeysOnly ? 1 : 0.5
    costReason = creator.acceptsKeysOnly ? 'берёт ключами (бесплатно)' : 'бюджет не задан'
  }
  components.push({ key: 'cost', value: costVal, weight: WEIGHTS.cost, reason: costReason })

  // Past performance — NEUTRAL PRIOR at 0 beats so newcomers aren't sunk.
  const past = ctx.pastLift
  let pastVal = 0.5
  let pastReason = 'нет прошлых битов (нейтрально)'
  if (past && past.count > 0) {
    // Positive total lift → up to 1.0; non-positive → down to ~0.2.
    pastVal = past.total > 0 ? Math.min(1, 0.5 + logScale(past.total, 5000) / 2) : 0.2
    pastReason =
      past.total > 0
        ? `прошлые биты дали +${Math.round(past.total)} (n=${past.count})`
        : `прошлые биты без прироста (n=${past.count})`
  }
  components.push({ key: 'past', value: pastVal, weight: WEIGHTS.past, reason: pastReason })

  const weighted = components.reduce((acc, c) => acc + c.value * c.weight, 0)
  const score = Math.round(weighted * 100)

  // Reasons: surface the strongest positive drivers + any red flag.
  const reasons = components
    .filter((c) => c.value >= 0.5 || c.key === 'activity')
    .sort((a, b) => b.value * b.weight - a.value * a.weight)
    .map((c) => c.reason)

  return { score, components, reasons }
}
