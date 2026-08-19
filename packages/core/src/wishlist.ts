export interface WishlistBalancePoint {
  adds?: number | null
  deletes?: number | null
  purchasesAndActivations?: number | null
  gifts?: number | null
  net?: number | null
  balance?: number | null
}

/**
 * Resolve the current wishlist balance from mixed Steam exports. Some reports
 * contain an explicit running Balance; others only expose daily Adds/Deletes/Net.
 * An explicit balance resets the anchor, while later daily changes continue it.
 */
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
