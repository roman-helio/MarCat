import { wishlistImports, wishlistPoints, type DB } from '@marcat/db'
import { detectWishlistCsvMapping, parseCsv, parseIntLoose, type WishlistCsvMapping } from './util/csv'

export interface WishlistImportInput {
  gameId: string
  csv: string
  filename?: string
  mapping?: WishlistCsvMapping
}

/**
 * Import wishlist history by game + date. Only columns that actually exist in
 * the incoming CSV participate in conflict updates, so a Steam export without
 * Balance cannot erase a manually entered running balance.
 */
export async function importWishlistCsv(db: DB, input: WishlistImportInput) {
  const { headers, rows } = parseCsv(input.csv)
  const mapping = input.mapping ?? detectWishlistCsvMapping(headers)
  if (!mapping.date) throw new Error('Could not find a date column in the CSV.')
  if (![mapping.adds, mapping.deletes, mapping.gifts, mapping.balance, mapping.net].some(Boolean)) {
    throw new Error('Could not find wishlist data columns in the CSV.')
  }

  const batch = crypto.randomUUID()
  let imported = 0
  await db.transaction(async (tx) => {
    for (const row of rows) {
      const date = (row[mapping.date] ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue

      const metrics = {
        ...(mapping.adds ? { adds: parseIntLoose(row[mapping.adds]) } : {}),
        ...(mapping.deletes ? { deletes: parseIntLoose(row[mapping.deletes]) } : {}),
        ...(mapping.gifts ? { gifts: parseIntLoose(row[mapping.gifts]) } : {}),
        ...(mapping.balance ? { balance: parseIntLoose(row[mapping.balance]) } : {}),
        ...(mapping.net ? { net: parseIntLoose(row[mapping.net]) } : {}),
      }
      const provenance = { source: 'csv' as const, importBatchId: batch }
      await tx
        .insert(wishlistPoints)
        .values({ gameId: input.gameId, date, ...metrics, ...provenance })
        .onConflictDoUpdate({
          target: [wishlistPoints.gameId, wishlistPoints.date],
          set: { ...metrics, ...provenance },
        })
      imported++
    }

    await tx.insert(wishlistImports).values({
      gameId: input.gameId,
      filename: input.filename ?? null,
      rows: imported,
      columnMapping: JSON.stringify(mapping),
    })
  })

  return { imported, mapping }
}
