import { asc, eq, isNull, or, sql } from 'drizzle-orm'
import { games, tasks } from './schema'
import type { DB } from './client'

/**
 * Derive a short uppercase project key from a game name (Jira-style).
 * Multi-word → initials ("Salt and Soil" → "SAS"); single word → first 4 chars.
 * Latin/digits only; non-Latin names fall back to "GAME". `taken` ensures uniqueness.
 */
export function makeGameKey(name: string, taken: Set<string> = new Set()): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  let base =
    words.length >= 2
      ? words
          .map((w) => w[0])
          .join('')
          .slice(0, 5)
      : (words[0] ?? '').slice(0, 4)
  if (base.length < 2) base = 'GAME'
  let key = base
  let n = 2
  while (taken.has(key)) key = `${base}${n++}`
  return key
}

/**
 * Atomically allocate the next per-game task sequence number.
 *
 * The UPSERT serialises concurrent desktop/MCP/AI writers on one game counter.
 * `excluded.last_seq` also heals a stale counter after imports or legacy data.
 */
export async function nextTaskSeq(db: DB, gameId: string): Promise<number> {
  const row = await db.get<{ seq: number }>(sql`
    INSERT INTO task_counters (game_id, last_seq)
    VALUES (${gameId}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks WHERE game_id = ${gameId}))
    ON CONFLICT(game_id) DO UPDATE SET
      last_seq = MAX(task_counters.last_seq + 1, excluded.last_seq)
    RETURNING last_seq AS seq
  `)
  if (!row?.seq) throw new Error('Failed to allocate task sequence')
  return Number(row.seq)
}

/**
 * Idempotent backfill: give every game a unique key and every task a per-game
 * seq. Safe to run on each startup — only fills in NULLs. Runs after migrations.
 */
export async function backfillTaskKeys(db: DB): Promise<void> {
  const gs = await db.select().from(games)
  const taken = new Set<string>()
  for (const g of gs) if (g.key) taken.add(g.key)

  for (const g of gs) {
    if (!g.key) {
      const key = makeGameKey(g.name, taken)
      taken.add(key)
      await db.update(games).set({ key }).where(eq(games.id, g.id))
    }
  }

  // Tasks missing a seq: assign sequentially per game, continuing past any existing max.
  const needSeq = await db
    .select({ id: tasks.id, gameId: tasks.gameId })
    .from(tasks)
    .where(or(isNull(tasks.seq), eq(tasks.seq, 0)))
    .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt))
  if (!needSeq.length) return
  const counters = new Map<string, number>()
  for (const t of needSeq) {
    let n = counters.get(t.gameId)
    if (n === undefined) n = await nextTaskSeq(db, t.gameId)
    await db.update(tasks).set({ seq: n }).where(eq(tasks.id, t.id))
    counters.set(t.gameId, n + 1)
  }
}
