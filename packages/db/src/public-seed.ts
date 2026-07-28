import { createHash } from 'node:crypto'
import type { Client, InStatement } from '@libsql/client'

export interface PublicFestivalSeedEntry {
  name: string
  type: 'festival' | 'sale'
  startDate: string
  endDate: string | null
  applyDeadline: string | null
}

const allowedKeys = ['applyDeadline', 'endDate', 'name', 'startDate', 'type']
const isoDay = /^\d{4}-\d{2}-\d{2}$/

function parseEntry(value: unknown, index: number): PublicFestivalSeedEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid public festival entry at index ${index}`)
  }
  const entry = value as Record<string, unknown>
  const keys = Object.keys(entry).sort()
  if (keys.join('|') !== allowedKeys.join('|')) {
    throw new Error(`Public festival entry ${index} contains unsupported fields`)
  }
  if (typeof entry.name !== 'string' || !entry.name.trim())
    throw new Error(`Public festival entry ${index} has no name`)
  if (entry.type !== 'festival' && entry.type !== 'sale')
    throw new Error(`Public festival entry ${index} has invalid type`)
  for (const field of ['startDate', 'endDate', 'applyDeadline'] as const) {
    const date = entry[field]
    if (date !== null && (typeof date !== 'string' || !isoDay.test(date))) {
      throw new Error(`Public festival entry ${index} has invalid ${field}`)
    }
  }
  if (entry.startDate === null) throw new Error(`Public festival entry ${index} has no startDate`)
  return {
    name: entry.name.trim(),
    type: entry.type,
    startDate: entry.startDate as string,
    endDate: entry.endDate as string | null,
    applyDeadline: entry.applyDeadline as string | null,
  }
}

/**
 * Populate only a brand-new global catalogue. Existing catalogues are never
 * overwritten or merged, so upgrades preserve the user's own research.
 */
export async function seedPublicFestivalCatalogue(client: Client, input: unknown): Promise<number> {
  if (!Array.isArray(input) || input.length === 0) throw new Error('Public festival catalogue is empty')
  const existing = await client.execute('SELECT count(*) AS count FROM industry_events')
  if (Number(existing.rows[0]?.count ?? 0) > 0) return 0

  const entries = input.map(parseEntry)
  const seen = new Set<string>()
  const createdAt = new Date().toISOString()
  const statements: InStatement[] = entries.map((entry) => {
    const identity = `${entry.name.toLocaleLowerCase('en-US')}\0${entry.startDate}`
    if (seen.has(identity)) throw new Error(`Duplicate public festival: ${entry.name} (${entry.startDate})`)
    seen.add(identity)
    const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32)
    return {
      sql: `INSERT INTO industry_events
        (id, name, type, start_date, end_date, apply_deadline, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'import', ?)`,
      args: [
        `public-festival-${digest}`,
        entry.name,
        entry.type,
        entry.startDate,
        entry.endDate,
        entry.applyDeadline,
        createdAt,
      ],
    }
  })
  await client.batch(statements, 'write')
  return entries.length
}
