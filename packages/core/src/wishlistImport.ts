import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { wishlistImports, wishlistPoints, type DB } from '@marcat/db'
import {
  detectWishlistCsvMapping,
  detectWishlistCsvReportKind,
  parseCsv,
  parseIntLoose,
  type WishlistCsvMapping,
} from './util/csv'

export const WISHLIST_COHORT_ERROR = 'WISHLIST_COHORT_REPORT'
const CHECKSUM_VERSION = 'wishlist-v2'

export interface WishlistImportInput {
  gameId: string
  csv: string
  filename?: string
  /** Original file timestamp; Steam's DateLocal row from that same day is still provisional. */
  fileModifiedAt?: string
  mapping?: WishlistCsvMapping
}

function localIsoDate(value: string | undefined): string {
  const date = value ? new Date(value) : new Date()
  const valid = Number.isFinite(date.getTime()) ? date : new Date()
  const year = valid.getFullYear()
  const month = String(valid.getMonth() + 1).padStart(2, '0')
  const day = String(valid.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Import wishlist history by game + date. Only columns that actually exist in
 * the incoming CSV participate in conflict updates, so a Steam export without
 * Balance cannot erase a manually entered running balance.
 */
export async function importWishlistCsv(db: DB, input: WishlistImportInput) {
  const { headers, rows } = parseCsv(input.csv)
  const reportKind = detectWishlistCsvReportKind(input.csv, headers, input.filename)
  if (reportKind === 'steam_cohort') {
    throw new Error(
      `${WISHLIST_COHORT_ERROR}: Steam Wishlist Cohorts does not contain daily wishlist additions. Export Daily Wishlist Actions instead.`,
    )
  }
  if (!rows.length) throw new Error('The wishlist CSV contains no data rows.')
  const mapping = input.mapping ?? detectWishlistCsvMapping(headers)
  if (!mapping.date) throw new Error('Could not find a date column in the CSV.')
  if (
    ![mapping.adds, mapping.deletes, mapping.purchasesAndActivations, mapping.gifts, mapping.balance, mapping.net].some(
      Boolean,
    )
  ) {
    throw new Error('Could not find wishlist data columns in the CSV.')
  }

  // Parser semantics are part of the identity: v2 intentionally reprocesses
  // files imported by older builds that treated Steam's live final row as complete.
  const checksum = `${CHECKSUM_VERSION}:${createHash('sha256').update(input.csv).digest('hex')}`
  const existing = await db
    .select({ rows: wishlistImports.rows })
    .from(wishlistImports)
    .where(and(eq(wishlistImports.gameId, input.gameId), eq(wishlistImports.checksum, checksum)))
    .limit(1)
  if (existing[0]) {
    return { imported: 0, mapping, warnings: [] as string[], provisionalRows: 0, duplicate: true }
  }

  const batch = crypto.randomUUID()
  let imported = 0
  let provisionalRows = 0
  const warnings: string[] = []
  const warn = (message: string) => {
    if (warnings.length < 20) warnings.push(message)
  }
  const metric = (row: Record<string, string>, key: string | undefined, rowNumber: number) => {
    if (!key) return undefined
    const raw = row[key]
    const value = parseIntLoose(raw)
    if (raw?.trim() && value == null) warn(`Row ${rowNumber}: ${key} is not a valid integer.`)
    return value
  }
  const provisionalDate = reportKind === 'steam_daily' ? localIsoDate(input.fileModifiedAt) : null
  await db.transaction(async (tx) => {
    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2
      const date = (row[mapping.date] ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        warn(`Row ${rowNumber}: ${mapping.date} is not an ISO date.`)
        continue
      }

      // Steam includes a live, incomplete DateLocal row for the day on which
      // the file was downloaded. Do not let that snapshot drive balances,
      // velocity or event-impact analytics; the next export will upsert it.
      if (date === provisionalDate) {
        await tx
          .delete(wishlistPoints)
          .where(
            and(
              eq(wishlistPoints.gameId, input.gameId),
              eq(wishlistPoints.date, date),
              eq(wishlistPoints.source, 'csv'),
            ),
          )
        provisionalRows++
        continue
      }

      const metrics = {
        ...(mapping.adds ? { adds: metric(row, mapping.adds, rowNumber) } : {}),
        ...(mapping.deletes ? { deletes: metric(row, mapping.deletes, rowNumber) } : {}),
        ...(mapping.purchasesAndActivations
          ? { purchasesAndActivations: metric(row, mapping.purchasesAndActivations, rowNumber) }
          : {}),
        ...(mapping.gifts ? { gifts: metric(row, mapping.gifts, rowNumber) } : {}),
        ...(mapping.balance ? { balance: metric(row, mapping.balance, rowNumber) } : {}),
        ...(mapping.net ? { net: metric(row, mapping.net, rowNumber) } : {}),
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
      checksum,
      rows: imported,
      columnMapping: JSON.stringify(mapping),
      warningsJson: JSON.stringify(warnings),
    })
  })

  return { imported, mapping, warnings, provisionalRows, duplicate: false }
}
