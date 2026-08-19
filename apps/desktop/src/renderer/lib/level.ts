/** Cat level from wishlist balance. 0→1, 100→2, 500→3, 1000→4, 2000→5 … 100k→10. */
const THRESHOLDS = [0, 100, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000]
export const MAX_LEVEL = THRESHOLDS.length // 10

export interface CatLevel {
  level: number
  floor: number // wishlists at the start of this level
  ceil: number | null // wishlists needed for the next level (null at max)
  into: number // wishlists earned into the current level
  span: number // size of the current level band
  pct: number // progress to next level, 0..100
  max: boolean
}

export interface WishlistBalancePoint {
  adds?: number | null
  deletes?: number | null
  purchasesAndActivations?: number | null
  gifts?: number | null
  net?: number | null
  balance?: number | null
}

/** Renderer-safe twin of the core resolver (core also imports Node-only routers). */
export function resolveWishlistBalance(points: WishlistBalancePoint[]): number | null {
  let balance: number | null = null
  let sawChange = false
  for (const point of points) {
    if (point.balance != null) {
      balance = point.balance
      continue
    }
    const hasChange =
      point.net != null ||
      point.adds != null ||
      point.deletes != null ||
      point.purchasesAndActivations != null ||
      point.gifts != null
    if (!hasChange) continue
    const change =
      point.net ?? (point.adds ?? 0) - (point.deletes ?? 0) - (point.purchasesAndActivations ?? 0) - (point.gifts ?? 0)
    balance = Math.max(0, (balance ?? 0) + change)
    sawChange = true
  }
  return balance ?? (sawChange ? 0 : null)
}

export function catLevel(balance: number | null | undefined): CatLevel {
  const b = Math.max(0, balance ?? 0)
  let level = 1
  for (let i = 0; i < THRESHOLDS.length; i++) if (b >= THRESHOLDS[i]!) level = i + 1
  const floor = THRESHOLDS[level - 1]!
  const ceil = level < THRESHOLDS.length ? THRESHOLDS[level]! : null
  const span = ceil != null ? ceil - floor : 0
  const into = b - floor
  const pct = ceil != null && span > 0 ? Math.min(100, Math.round((into / span) * 100)) : 100
  return { level, floor, ceil, into, span, pct, max: ceil == null }
}
