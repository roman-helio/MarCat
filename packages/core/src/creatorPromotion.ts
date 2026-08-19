import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import {
  backgroundOperationItems,
  backgroundOperations,
  creatorDiscoveryRuns,
  type BackgroundOperation,
  type DB,
} from '@marcat/db'
import { promoteDiscoveryCandidate } from './youtubeDiscovery'

const STALE_OPERATION_MS = 5 * 60_000
let workerRunning = false

function now(): string {
  return new Date().toISOString()
}

function operationDedupeKey(runId: string, candidateIds: string[]): string {
  const selectionHash = createHash('sha256')
    .update([...candidateIds].sort().join('\n'))
    .digest('hex')
  return `creator-promotion:${runId}:${selectionHash}`
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}

export async function queueCreatorPromotion(
  db: DB,
  runId: string,
  candidateIds: string[],
): Promise<{ operation: BackgroundOperation; duplicate: boolean }> {
  const run = (
    await db
      .select({ gameId: creatorDiscoveryRuns.gameId })
      .from(creatorDiscoveryRuns)
      .where(eq(creatorDiscoveryRuns.id, runId))
      .limit(1)
  )[0]
  if (!run) throw new Error('Creator discovery run not found')
  const uniqueCandidateIds = [...new Set(candidateIds)]
  const dedupeKey = operationDedupeKey(runId, uniqueCandidateIds)

  return db.transaction(async (tx) => {
    const active = (
      await tx
        .select()
        .from(backgroundOperations)
        .where(
          and(
            eq(backgroundOperations.dedupeKey, dedupeKey),
            inArray(backgroundOperations.status, ['queued', 'running']),
          ),
        )
        .orderBy(asc(backgroundOperations.createdAt))
        .limit(1)
    )[0]
    if (active) return { operation: active, duplicate: true }

    const operationId = crypto.randomUUID()
    const timestamp = now()
    await tx.insert(backgroundOperations).values({
      id: operationId,
      gameId: run.gameId,
      kind: 'creator_promotion',
      scopeId: runId,
      dedupeKey,
      status: 'queued',
      selected: uniqueCandidateIds.length,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    await tx.insert(backgroundOperationItems).values(
      uniqueCandidateIds.map((candidateId) => ({
        operationId,
        entityId: candidateId,
        status: 'queued' as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    )
    const operation = (
      await tx.select().from(backgroundOperations).where(eq(backgroundOperations.id, operationId)).limit(1)
    )[0]!
    return { operation, duplicate: false }
  })
}

async function recoverStaleOperations(db: DB): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_OPERATION_MS).toISOString()
  const stale = await db
    .select({ id: backgroundOperations.id })
    .from(backgroundOperations)
    .where(
      and(
        eq(backgroundOperations.kind, 'creator_promotion'),
        eq(backgroundOperations.status, 'running'),
        lt(backgroundOperations.heartbeatAt, staleBefore),
      ),
    )
  if (!stale.length) return
  const ids = stale.map((operation) => operation.id)
  const timestamp = now()
  await db.transaction(async (tx) => {
    await tx
      .update(backgroundOperationItems)
      .set({ status: 'queued', updatedAt: timestamp })
      .where(and(inArray(backgroundOperationItems.operationId, ids), eq(backgroundOperationItems.status, 'running')))
    await tx
      .update(backgroundOperations)
      .set({ status: 'queued', error: 'Recovered after worker restart', heartbeatAt: timestamp, updatedAt: timestamp })
      .where(inArray(backgroundOperations.id, ids))
  })
}

async function claimNextOperation(db: DB): Promise<BackgroundOperation | null> {
  return db.transaction(async (tx) => {
    const operation = (
      await tx
        .select()
        .from(backgroundOperations)
        .where(and(eq(backgroundOperations.kind, 'creator_promotion'), eq(backgroundOperations.status, 'queued')))
        .orderBy(asc(backgroundOperations.createdAt))
        .limit(1)
    )[0]
    if (!operation) return null
    const timestamp = now()
    await tx
      .update(backgroundOperations)
      .set({
        status: 'running',
        startedAt: operation.startedAt ?? timestamp,
        heartbeatAt: timestamp,
        updatedAt: timestamp,
      })
      .where(and(eq(backgroundOperations.id, operation.id), eq(backgroundOperations.status, 'queued')))
    return { ...operation, status: 'running', startedAt: operation.startedAt ?? timestamp, heartbeatAt: timestamp }
  })
}

async function finishOperation(db: DB, operationId: string): Promise<BackgroundOperation> {
  const items = await db
    .select({ status: backgroundOperationItems.status, outcome: backgroundOperationItems.outcome })
    .from(backgroundOperationItems)
    .where(eq(backgroundOperationItems.operationId, operationId))
  const succeeded = items.filter((item) => item.status === 'completed').length
  const failed = items.filter((item) => item.status === 'failed').length
  const cancelled = items.filter((item) => item.status === 'cancelled').length
  const createdCount = items.filter((item) => item.outcome === 'created').length
  const updatedCount = items.filter((item) => item.outcome === 'updated').length
  const current = (
    await db.select().from(backgroundOperations).where(eq(backgroundOperations.id, operationId)).limit(1)
  )[0]!
  const status =
    current.status === 'cancelled'
      ? 'cancelled'
      : failed > 0 && succeeded > 0
        ? 'partial'
        : failed > 0
          ? 'failed'
          : 'completed'
  const timestamp = now()
  await db
    .update(backgroundOperations)
    .set({
      status,
      processed: succeeded + failed + cancelled,
      succeeded,
      failed,
      createdCount,
      updatedCount,
      error: failed ? `${failed} contact${failed === 1 ? '' : 's'} could not be added` : null,
      finishedAt: timestamp,
      heartbeatAt: timestamp,
      updatedAt: timestamp,
    })
    .where(eq(backgroundOperations.id, operationId))
  return (await db.select().from(backgroundOperations).where(eq(backgroundOperations.id, operationId)).limit(1))[0]!
}

/** Process one durable promotion operation. Each candidate is its own short, idempotent write slice. */
export async function processCreatorPromotionQueue(
  db: DB,
): Promise<{ operation: BackgroundOperation; runId: string } | null> {
  if (workerRunning) return null
  workerRunning = true
  try {
    await recoverStaleOperations(db)
    const operation = await claimNextOperation(db)
    if (!operation) return null

    const items = await db
      .select()
      .from(backgroundOperationItems)
      .where(and(eq(backgroundOperationItems.operationId, operation.id), eq(backgroundOperationItems.status, 'queued')))
      .orderBy(asc(backgroundOperationItems.createdAt))

    for (const item of items) {
      const current = (
        await db
          .select({ status: backgroundOperations.status })
          .from(backgroundOperations)
          .where(eq(backgroundOperations.id, operation.id))
          .limit(1)
      )[0]
      if (!current || current.status === 'cancelled') break
      const timestamp = now()
      await db
        .update(backgroundOperationItems)
        .set({ status: 'running', error: null, updatedAt: timestamp })
        .where(and(eq(backgroundOperationItems.id, item.id), eq(backgroundOperationItems.status, 'queued')))
      try {
        const result = await promoteDiscoveryCandidate(db, operation.scopeId, item.entityId)
        await db.transaction(async (tx) => {
          await tx
            .update(backgroundOperationItems)
            .set({
              status: 'completed',
              outcome: result.created ? 'created' : 'updated',
              resultEntityId: result.creatorId,
              updatedAt: now(),
            })
            .where(eq(backgroundOperationItems.id, item.id))
          await tx
            .update(backgroundOperations)
            .set({
              processed: sql`${backgroundOperations.processed} + 1`,
              succeeded: sql`${backgroundOperations.succeeded} + 1`,
              createdCount: sql`${backgroundOperations.createdCount} + ${result.created ? 1 : 0}`,
              updatedCount: sql`${backgroundOperations.updatedCount} + ${result.created ? 0 : 1}`,
              heartbeatAt: now(),
              updatedAt: now(),
            })
            .where(eq(backgroundOperations.id, operation.id))
        })
      } catch (error) {
        await db.transaction(async (tx) => {
          await tx
            .update(backgroundOperationItems)
            .set({ status: 'failed', error: errorMessage(error), updatedAt: now() })
            .where(eq(backgroundOperationItems.id, item.id))
          await tx
            .update(backgroundOperations)
            .set({
              processed: sql`${backgroundOperations.processed} + 1`,
              failed: sql`${backgroundOperations.failed} + 1`,
              error: errorMessage(error),
              heartbeatAt: now(),
              updatedAt: now(),
            })
            .where(eq(backgroundOperations.id, operation.id))
        })
      }
    }

    const finished = await finishOperation(db, operation.id)
    return { operation: finished, runId: operation.scopeId }
  } finally {
    workerRunning = false
  }
}

export async function cancelCreatorPromotion(db: DB, operationId: string): Promise<BackgroundOperation | null> {
  const timestamp = now()
  return db.transaction(async (tx) => {
    const operation = (
      await tx
        .select()
        .from(backgroundOperations)
        .where(
          and(
            eq(backgroundOperations.id, operationId),
            eq(backgroundOperations.kind, 'creator_promotion'),
            inArray(backgroundOperations.status, ['queued', 'running']),
          ),
        )
        .limit(1)
    )[0]
    if (!operation) return null
    await tx
      .update(backgroundOperationItems)
      .set({ status: 'cancelled', updatedAt: timestamp })
      .where(
        and(
          eq(backgroundOperationItems.operationId, operationId),
          inArray(backgroundOperationItems.status, ['queued', 'running']),
        ),
      )
    await tx
      .update(backgroundOperations)
      .set({ status: 'cancelled', finishedAt: timestamp, heartbeatAt: timestamp, updatedAt: timestamp })
      .where(and(eq(backgroundOperations.id, operationId), inArray(backgroundOperations.status, ['queued', 'running'])))
    return (
      (await tx.select().from(backgroundOperations).where(eq(backgroundOperations.id, operationId)).limit(1))[0] ?? null
    )
  })
}

export async function retryCreatorPromotion(db: DB, operationId: string): Promise<BackgroundOperation | null> {
  const timestamp = now()
  return db.transaction(async (tx) => {
    const operation = (
      await tx
        .select()
        .from(backgroundOperations)
        .where(
          and(
            eq(backgroundOperations.id, operationId),
            eq(backgroundOperations.kind, 'creator_promotion'),
            inArray(backgroundOperations.status, ['partial', 'failed']),
          ),
        )
        .limit(1)
    )[0]
    if (!operation) return null
    await tx
      .update(backgroundOperationItems)
      .set({ status: 'queued', error: null, updatedAt: timestamp })
      .where(and(eq(backgroundOperationItems.operationId, operationId), eq(backgroundOperationItems.status, 'failed')))
    await tx
      .update(backgroundOperations)
      .set({
        status: 'queued',
        processed: operation.succeeded,
        failed: 0,
        error: null,
        finishedAt: null,
        heartbeatAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(backgroundOperations.id, operationId))
    return (await tx.select().from(backgroundOperations).where(eq(backgroundOperations.id, operationId)).limit(1))[0]!
  })
}
