import { and, asc, eq, inArray } from 'drizzle-orm'
import { tags, taskDependencies, taskTagLinks, tasks } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { stripUndefined } from '../util/slug'

const tagType = z.enum(['release', 'festival', 'sale', 'update', 'track', 'other'])

const dayMs = 86_400_000
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs)
const shiftIso = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const tagsRouter = router({
  list: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    return ctx.db.select().from(tags).where(eq(tags.gameId, input.gameId)).orderBy(asc(tags.name))
  }),

  /** Tags with linked-task progress — drives dated-tag countdowns + at-risk alarms. */
  withStatus: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    const tg = await ctx.db.select().from(tags).where(eq(tags.gameId, input.gameId)).orderBy(asc(tags.targetDate))
    const links = await ctx.db
      .select({ tagId: taskTagLinks.tagId, status: tasks.status, dueDate: tasks.dueDate })
      .from(taskTagLinks)
      .innerJoin(tasks, eq(taskTagLinks.taskId, tasks.id))
      .where(eq(tasks.gameId, input.gameId))
    const today = new Date().toISOString().slice(0, 10)
    const byTag = new Map<string, { status: string; dueDate: string | null }[]>()
    for (const l of links) byTag.set(l.tagId, [...(byTag.get(l.tagId) ?? []), l])
    return tg.map((t) => {
      const linked = byTag.get(t.id) ?? []
      const open = linked.filter((x) => x.status !== 'done' && x.status !== 'cancelled')
      return {
        ...t,
        linkedTotal: linked.length,
        linkedDone: linked.filter((x) => x.status === 'done').length,
        linkedClosed: linked.filter((x) => x.status === 'done' || x.status === 'cancelled').length,
        openCount: open.length,
        overdueCount: open.filter((x) => x.dueDate && x.dueDate < today).length,
      }
    })
  }),

  create: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        name: z.string().min(1).max(60),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        colorEnabled: z.boolean().optional(),
        targetDate: z.string().nullish(),
        type: tagType.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db
        .insert(tags)
        .values({
          gameId: input.gameId,
          name: input.name,
          ...(input.color ? { color: input.color } : {}),
          colorEnabled: input.colorEnabled ?? false,
          targetDate: input.targetDate ?? null,
          type: input.type ?? 'track',
        })
        .returning()
      return rows[0]!
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        patch: z.object({
          name: z.string().min(1).max(60).optional(),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .optional(),
          colorEnabled: z.boolean().optional(),
          targetDate: z.string().nullable().optional(),
          type: tagType.optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const beforeRows = await tx.select().from(tags).where(eq(tags.id, input.id)).limit(1)
        const before = beforeRows[0]
        const rows = await tx
          .update(tags)
          .set(stripUndefined({ ...input.patch }))
          .where(eq(tags.id, input.id))
          .returning()
        const updated = rows[0] ?? null

        // Smart reschedule: moving a dated tag shifts every tagged task — and the chain
        // of tasks blocking them — by the same delta, preserving lead times.
        let shiftedTasks = 0
        if (updated && before?.targetDate && input.patch.targetDate && input.patch.targetDate !== before.targetDate) {
          const delta = daysBetween(before.targetDate, input.patch.targetDate)
          if (delta !== 0) {
            const tagged = await tx
              .select({ taskId: taskTagLinks.taskId })
              .from(taskTagLinks)
              .where(eq(taskTagLinks.tagId, updated.id))
            const gameTasks = await tx.select().from(tasks).where(eq(tasks.gameId, updated.gameId))
            const ids = new Set(gameTasks.map((t) => t.id))
            const taskIds = [...ids]
            const deps = taskIds.length
              ? await tx
                  .select()
                  .from(taskDependencies)
                  .where(
                    and(
                      inArray(taskDependencies.blockerTaskId, taskIds),
                      inArray(taskDependencies.blockedTaskId, taskIds),
                    ),
                  )
              : []
            const blockersOf = new Map<string, string[]>()
            for (const d of deps) {
              if (ids.has(d.blockedTaskId) && ids.has(d.blockerTaskId)) {
                blockersOf.set(d.blockedTaskId, [...(blockersOf.get(d.blockedTaskId) ?? []), d.blockerTaskId])
              }
            }
            const affected = new Set<string>()
            const stack = tagged.map((x) => x.taskId).filter((id) => ids.has(id))
            while (stack.length) {
              const id = stack.pop()!
              if (affected.has(id)) continue
              affected.add(id)
              for (const b of blockersOf.get(id) ?? []) stack.push(b)
            }
            const now = new Date().toISOString()
            for (const t of gameTasks) {
              if (!affected.has(t.id)) continue
              const p: Record<string, unknown> = { updatedAt: now }
              if (t.startDate) p.startDate = shiftIso(t.startDate, delta)
              if (t.dueDate) p.dueDate = shiftIso(t.dueDate, delta)
              if (p.startDate || p.dueDate) {
                await tx.update(tasks).set(p).where(eq(tasks.id, t.id))
                shiftedTasks++
              }
            }
          }
        }
        return updated ? { ...updated, shiftedTasks } : null
      }),
    ),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) =>
    ctx.db.transaction(async (tx) => {
      await tx.delete(taskTagLinks).where(eq(taskTagLinks.tagId, input.id))
      await tx.delete(tags).where(eq(tags.id, input.id))
      return { id: input.id }
    }),
  ),
})
