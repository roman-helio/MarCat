const normalize = (value: string) => value.trim().toLocaleLowerCase()

function fieldRank(value: string, needle: string): number {
  const normalized = normalize(value)
  if (!needle) return 0
  if (normalized === needle) return 0
  if (normalized.startsWith(needle)) return 1
  if (normalized.split(/\s+/).some((word) => word.startsWith(needle))) return 2
  if (normalized.includes(needle)) return 3
  return Number.POSITIVE_INFINITY
}

/** Exact and prefix matches come first, then word-prefix and substring matches. */
export function smartMatches<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  const needle = normalize(query)
  return items
    .map((item, index) => ({
      item,
      index,
      rank: Math.min(...fields(item).map((field) => fieldRank(field, needle))),
      label: normalize(fields(item)[0] ?? ''),
    }))
    .filter((entry) => Number.isFinite(entry.rank))
    .sort(
      (a, b) => a.rank - b.rank || a.label.localeCompare(b.label, undefined, { numeric: true }) || a.index - b.index,
    )
    .map((entry) => entry.item)
}
