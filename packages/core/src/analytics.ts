import type { EventRow, WishlistPoint } from '@marcat/db'

export type Classification = 'hit' | 'fail' | 'neutral' | 'ambiguous' | 'unknown'

export interface EventImpact {
  eventId: string
  occurredAt: string
  title: string
  platform: string | null
  type: string
  addsAfter: number | null
  baseline: number | null
  lift: number | null
  signalThreshold: number | null
  observedDays: number
  baselineDays: number
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  confounders: number
  classification: Classification
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Detect project-relative wishlist reactions after each activity. The usual
 * pace is the median of the project's own recent daily additions. A reaction
 * is only labelled a hit/anti-hit when it exceeds the project's normal robust
 * variation (MAD), with a count-noise floor. Overlapping activity windows are
 * kept explicitly ambiguous instead of assigning the same reaction to every
 * post. This is anomaly detection, not performance against a planned target.
 */
export function computeImpact(events: EventRow[], points: WishlistPoint[], windowDays = 3, baselineWindowDays = 14) {
  const minBaselineDays = 5
  const signalSigma = 1.5
  const addsByDate = new Map<string, number>()
  for (const p of points) if (p.adds != null) addsByDate.set(p.date, p.adds)

  const sumAfter = (startIso: string) => {
    let sum = 0
    let count = 0
    for (let i = 0; i < windowDays; i++) {
      const key = addDays(startIso, i)
      if (addsByDate.has(key)) {
        sum += addsByDate.get(key)!
        count++
      }
    }
    return { sum, count }
  }
  const baselineStats = (startIso: string) => {
    const values: number[] = []
    for (let i = 1; i <= baselineWindowDays; i++) {
      const key = addDays(startIso, -i)
      const value = addsByDate.get(key)
      if (value != null) values.push(value)
    }
    if (!values.length) return null
    const daily = median(values)
    const mad = median(values.map((value) => Math.abs(value - daily)))
    // MAD estimates this project's normal volatility; the square-root floor
    // avoids declaring tiny count fluctuations significant when MAD is zero.
    const dailyNoise = Math.max(mad * 1.4826, Math.sqrt(Math.max(daily, 1)))
    return { daily, dailyNoise, count: values.length }
  }

  const impacts: EventImpact[] = events.map((e) => {
    const after = sumAfter(e.occurredAt)
    const base = baselineStats(e.occurredAt)
    const baselineDays = base?.count ?? 0
    const reactionEnd = addDays(e.occurredAt, windowDays - 1)
    const confounders = events.filter(
      (other) =>
        other.id !== e.id &&
        other.occurredAt <= reactionEnd &&
        addDays(other.occurredAt, windowDays - 1) >= e.occurredAt,
    ).length
    if (after.count === 0 || base == null || baselineDays < minBaselineDays) {
      return {
        eventId: e.id,
        occurredAt: e.occurredAt,
        title: e.title,
        platform: e.platform,
        type: e.type,
        addsAfter: after.count ? after.sum : null,
        baseline: null,
        lift: null,
        signalThreshold: null,
        observedDays: after.count,
        baselineDays,
        confidence: 'unknown' as const,
        confounders,
        classification: 'unknown',
      }
    }
    const baseline = base.daily * after.count
    const lift = Math.round(after.sum - baseline)
    const signalThreshold = Math.max(2, Math.ceil(base.dailyNoise * Math.sqrt(after.count) * signalSigma))
    const confidence =
      after.count === windowDays && baselineDays >= 10 && confounders === 0
        ? ('high' as const)
        : after.count >= 2 && baselineDays >= 7 && confounders === 0
          ? ('medium' as const)
          : ('low' as const)
    const signal = lift > signalThreshold ? 'hit' : lift < -signalThreshold ? 'fail' : 'neutral'
    return {
      eventId: e.id,
      occurredAt: e.occurredAt,
      title: e.title,
      platform: e.platform,
      type: e.type,
      addsAfter: after.sum,
      baseline: Math.round(baseline),
      lift,
      signalThreshold,
      observedDays: after.count,
      baselineDays,
      confidence,
      confounders,
      classification: confounders > 0 ? 'ambiguous' : signal,
    }
  })
  return { impacts, windowDays, baselineWindowDays, minBaselineDays }
}
