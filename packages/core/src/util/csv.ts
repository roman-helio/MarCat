/** Minimal RFC-4180-ish CSV parser (handles quotes, escaped quotes, CRLF, BOM and Steam's preamble). */
export function parseCsv(input: string): { headers: string[]; rows: Record<string, string>[] } {
  const s = input.replace(/^\uFEFF/, '')
  const firstLine = s.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const separator = /^sep=(.)$/i.exec(firstLine)?.[1] ?? ','
  const grid: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === separator) {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      grid.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field.length || row.length) {
    row.push(field)
    grid.push(row)
  }
  // Steamworks exports start with `sep=,`, a report title and a blank line.
  // Use the first actual multi-column row as the header so callers never have
  // to strip those service lines themselves.
  const wishlistHeaderIndex = grid.findIndex((r) => {
    const cells = r.map((cell) =>
      cell
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, ''),
    )
    return (
      cells.some((cell) => /^(date|datelocal|day)$/.test(cell)) &&
      cells.some((cell) => /^(adds?|deletes?|gifts?|balance|net|netchange)$/.test(cell))
    )
  })
  const headerIndex =
    wishlistHeaderIndex >= 0 ? wishlistHeaderIndex : grid.findIndex((r) => r.filter((c) => c.trim() !== '').length > 1)
  const headers = (headerIndex >= 0 ? grid[headerIndex] : []).map((h) => h.trim())
  const rows = grid
    .slice(headerIndex + 1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const o: Record<string, string> = {}
      headers.forEach((h, idx) => (o[h] = (r[idx] ?? '').trim()))
      return o
    })
  return { headers, rows }
}

export type WishlistCsvMapping = {
  date: string
  adds?: string
  deletes?: string
  gifts?: string
  balance?: string
  net?: string
}

/** Detect both Steamworks column names and common hand-made wishlist exports. */
export function detectWishlistCsvMapping(headers: string[]): WishlistCsvMapping {
  const normalized = (header: string) => header.toLowerCase().replace(/[\s_-]+/g, '')
  const find = (patterns: RegExp[]) =>
    headers.find((header) => patterns.some((pattern) => pattern.test(normalized(header))))

  return {
    date: find([/^datelocal$/, /^date$/, /^day$/]) ?? '',
    adds: find([/^adds?$/, /^additions?$/, /^wishlistadds?$/]),
    deletes: find([/^deletes?$/, /^removals?$/, /^wishlistdeletes?$/]),
    gifts: find([/^gifts?$/]),
    balance: find([/^balance$/, /^totalwishlists?$/, /^wishlistbalance$/]),
    net: find([/^net$/, /^netchange$/]),
  }
}

/** Parse a possibly comma/space-formatted integer; returns null if empty/NaN. */
export function parseIntLoose(v: string | undefined): number | null {
  if (v == null) return null
  const cleaned = v.replace(/[,\s]/g, '').replace(/[^\d.-]/g, '')
  if (cleaned === '' || cleaned === '-') return null
  const n = Math.round(Number(cleaned))
  return Number.isFinite(n) ? n : null
}
