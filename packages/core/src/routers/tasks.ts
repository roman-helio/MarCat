import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import {
  games,
  nextTaskSeq,
  tags,
  taskChecklistItems,
  taskDependencies,
  taskTagLinks,
  tasks,
  type DB,
} from '@marcat/db'

/** Jira-style display id: `${game.key}-${seq}` (e.g. SALT-12). */
const taskKeyOf = (gameKey: string | null, seq: number | null): string | null =>
  gameKey && seq != null ? `${gameKey}-${seq}` : null
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { stripUndefined } from '../util/slug'
import { taskDescriptionToMarkdown } from '../util/richText'
import { buildTaskFocusQueue, summarizeChecklist } from '../taskFocus'
import { nextRecurringSchedule, RECURRENCE_UNITS, type RecurrenceUnit } from '../taskRecurrence'

const status = z.enum(['todo', 'doing', 'blocked', 'done', 'cancelled'])
const priority = z.enum(['low', 'med', 'high', 'urgent'])
const recurrence = z.object({
  every: z.number().int().min(1).max(3650),
  unit: z.enum(RECURRENCE_UNITS),
})

const taskSearchInput = z.object({
  gameId: z.string().optional(),
  query: z.string().trim().min(1).max(200).optional(),
  statuses: z.array(status).min(1).max(5).optional(),
  priorities: z.array(priority).min(1).max(4).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  detail: z.enum(['short', 'full']).optional(),
})

const taskPatch = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  status: status.optional(),
  priority: priority.optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  reminderAt: z.string().nullable().optional(),
  recurrence: recurrence.nullable().optional(),
  sortOrder: z.number().int().optional(),
})

function recurringSchedule(
  task: {
    dueDate: string | null
    startDate: string | null
    recurrenceInterval: number | null
    recurrenceUnit: RecurrenceUnit | null
  },
  completedOn: string,
) {
  if (!task.recurrenceInterval || !task.recurrenceUnit) return null
  return nextRecurringSchedule({
    dueDate: task.dueDate,
    startDate: task.startDate,
    completedOn,
    recurrence: { every: task.recurrenceInterval, unit: task.recurrenceUnit },
  })
}

/** One-time/idempotent data backfill from the former TipTap HTML storage format. */
export async function backfillTaskDescriptionMarkdown(db: DB): Promise<number> {
  const rows = await db.select({ id: tasks.id, description: tasks.description }).from(tasks)
  let changed = 0
  for (const row of rows) {
    const markdown = taskDescriptionToMarkdown(row.description)
    if (markdown === row.description) continue
    await db.update(tasks).set({ description: markdown }).where(eq(tasks.id, row.id))
    changed++
  }
  return changed
}

/**
 * Reconcile todo↔blocked status from dependency state for one game.
 * A task with at least one open blocker becomes `blocked`; once all its blockers
 * are done/cancelled it returns to `todo`. Only tasks that actually have blocker
 * links are touched — a manually-set `blocked` with no links is left alone — and
 * `doing`/`done`/`cancelled` are never overridden.
 */
export async function syncBlockedStatus(db: DB, gameId: string): Promise<void> {
  const ts = await db.select().from(tasks).where(eq(tasks.gameId, gameId))
  const ids = new Set(ts.map((t) => t.id))
  const allDeps = ids.size
    ? await db
        .select()
        .from(taskDependencies)
        .where(
          and(inArray(taskDependencies.blockerTaskId, [...ids]), inArray(taskDependencies.blockedTaskId, [...ids])),
        )
    : []
  const statusById = new Map(ts.map((t) => [t.id, t.status]))
  const blockersOf = new Map<string, string[]>()
  for (const d of allDeps) {
    if (ids.has(d.blockedTaskId) && ids.has(d.blockerTaskId)) {
      blockersOf.set(d.blockedTaskId, [...(blockersOf.get(d.blockedTaskId) ?? []), d.blockerTaskId])
    }
  }
  const now = new Date().toISOString()
  for (const t of ts) {
    const bs = blockersOf.get(t.id) ?? []
    if (!bs.length) continue
    const openBlocker = bs.some((b) => {
      const s = statusById.get(b)
      return s && s !== 'done' && s !== 'cancelled'
    })
    if (openBlocker && t.status === 'todo') {
      await db.update(tasks).set({ status: 'blocked', updatedAt: now }).where(eq(tasks.id, t.id))
    } else if (!openBlocker && t.status === 'blocked') {
      await db.update(tasks).set({ status: 'todo', updatedAt: now }).where(eq(tasks.id, t.id))
    }
  }
}

/** Adding blocker→blocked would create a cycle iff blocked can already reach blocker. */
async function wouldCycle(db: DB, gameId: string, blockerId: string, blockedId: string): Promise<boolean> {
  if (blockerId === blockedId) return true
  const gameTasks = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.gameId, gameId))
  const ids = gameTasks.map((task) => task.id)
  const deps = ids.length
    ? await db
        .select()
        .from(taskDependencies)
        .where(and(inArray(taskDependencies.blockerTaskId, ids), inArray(taskDependencies.blockedTaskId, ids)))
    : []
  const adj = new Map<string, string[]>()
  for (const d of deps) {
    const list = adj.get(d.blockerTaskId) ?? []
    list.push(d.blockedTaskId)
    adj.set(d.blockerTaskId, list)
  }
  const stack = [blockedId]
  const seen = new Set<string>()
  while (stack.length) {
    const n = stack.pop()!
    if (n === blockerId) return true
    if (seen.has(n)) continue
    seen.add(n)
    for (const m of adj.get(n) ?? []) stack.push(m)
  }
  return false
}

function taskMatchExcerpt(description: string, query: string | undefined, maxLength = 240): string | null {
  if (!query) return null
  const text = taskDescriptionToMarkdown(description).replace(/\s+/g, ' ').trim()
  const matchAt = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (matchAt < 0) return null
  const start = Math.max(0, matchAt - 80)
  const end = Math.min(text.length, start + maxLength)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export const tasksRouter = router({
  /** Compact, paginated server-side search used by agents and large task catalogues. */
  search: publicProcedure.input(taskSearchInput).query(async ({ ctx, input }) => {
    const query = input.query?.trim()
    const queryForms = query
      ? [
          ...new Set([
            query,
            query.toLocaleLowerCase(),
            query.toLocaleUpperCase(),
            `${query.slice(0, 1).toLocaleUpperCase()}${query.slice(1).toLocaleLowerCase()}`,
          ]),
        ]
      : []
    const limit = input.limit ?? 20
    const offset = input.offset ?? 0
    const detail = input.detail ?? 'short'
    const conditions: SQL[] = []
    if (input.gameId) conditions.push(eq(tasks.gameId, input.gameId))
    if (input.statuses?.length) conditions.push(inArray(tasks.status, input.statuses))
    if (input.priorities?.length) conditions.push(inArray(tasks.priority, input.priorities))
    const titleContains = query ? or(...queryForms.map((form) => sql`instr(${tasks.title}, ${form}) > 0`)) : undefined
    const descriptionContains = query
      ? or(...queryForms.map((form) => sql`instr(coalesce(${tasks.description}, ''), ${form}) > 0`))
      : undefined
    const exactTitle = query ? or(...queryForms.map((form) => eq(tasks.title, form))) : undefined
    if (query && titleContains && descriptionContains) {
      conditions.push(
        or(titleContains, descriptionContains, sql`lower(${games.key} || '-' || ${tasks.seq}) = lower(${query})`)!,
      )
    }
    const where = conditions.length ? and(...conditions) : undefined
    const relevance = query
      ? sql<number>`CASE
          WHEN lower(${games.key} || '-' || ${tasks.seq}) = lower(${query}) THEN 0
          WHEN ${exactTitle} THEN 1
          WHEN ${titleContains} THEN 2
          ELSE 3
        END`
      : null

    let countQuery = ctx.db
      .select({ value: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(games, eq(games.id, tasks.gameId))
      .$dynamic()
    if (where) countQuery = countQuery.where(where)

    let rowsQuery = ctx.db
      .select({
        id: tasks.id,
        gameId: tasks.gameId,
        gameName: games.name,
        gameKey: games.key,
        seq: tasks.seq,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        priority: tasks.priority,
        startDate: tasks.startDate,
        dueDate: tasks.dueDate,
        reminderAt: tasks.reminderAt,
        completedAt: tasks.completedAt,
        sortOrder: tasks.sortOrder,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .innerJoin(games, eq(games.id, tasks.gameId))
      .$dynamic()
    if (where) rowsQuery = rowsQuery.where(where)
    const rows = await rowsQuery
      .orderBy(...(relevance ? [asc(relevance)] : []), asc(games.name), asc(tasks.sortOrder), desc(tasks.updatedAt))
      .limit(limit)
      .offset(offset)
    const countRows = await countQuery
    const totalCount = Number(countRows[0]?.value ?? 0)

    if (detail === 'short') {
      return {
        totalCount,
        offset,
        limit,
        items: rows.map((task) => ({
          id: task.id,
          gameId: task.gameId,
          gameName: task.gameName,
          taskKey: taskKeyOf(task.gameKey, task.seq),
          title: task.title,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate,
          updatedAt: task.updatedAt,
          matchExcerpt: taskMatchExcerpt(task.description, query),
        })),
      }
    }

    const taskIds = rows.map((task) => task.id)
    const [tagRows, checklistRows] = taskIds.length
      ? await Promise.all([
          ctx.db
            .select({
              taskId: taskTagLinks.taskId,
              id: tags.id,
              name: tags.name,
              color: tags.color,
              colorEnabled: tags.colorEnabled,
            })
            .from(taskTagLinks)
            .innerJoin(tags, eq(taskTagLinks.tagId, tags.id))
            .where(inArray(taskTagLinks.taskId, taskIds)),
          ctx.db
            .select()
            .from(taskChecklistItems)
            .where(inArray(taskChecklistItems.taskId, taskIds))
            .orderBy(asc(taskChecklistItems.sortOrder)),
        ])
      : [[], []]
    const tagsByTask = new Map<string, Omit<(typeof tagRows)[number], 'taskId'>[]>()
    for (const { taskId, ...tag } of tagRows) {
      tagsByTask.set(taskId, [...(tagsByTask.get(taskId) ?? []), tag])
    }
    const checklistByTask = new Map<string, typeof checklistRows>()
    for (const item of checklistRows) {
      checklistByTask.set(item.taskId, [...(checklistByTask.get(item.taskId) ?? []), item])
    }
    return {
      totalCount,
      offset,
      limit,
      items: rows.map((task) => ({
        ...task,
        description: taskDescriptionToMarkdown(task.description),
        taskKey: taskKeyOf(task.gameKey, task.seq),
        tags: tagsByTask.get(task.id) ?? [],
        checklist: summarizeChecklist(checklistByTask.get(task.id) ?? []),
      })),
    }
  }),

  list: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    const ts = await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.gameId, input.gameId))
      .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt))
    const links = await ctx.db
      .select({
        taskId: taskTagLinks.taskId,
        id: tags.id,
        name: tags.name,
        color: tags.color,
        colorEnabled: tags.colorEnabled,
      })
      .from(taskTagLinks)
      .innerJoin(tags, eq(taskTagLinks.tagId, tags.id))
      .where(eq(tags.gameId, input.gameId))
    const byTask = new Map<string, { id: string; name: string; color: string; colorEnabled: boolean }[]>()
    for (const l of links) {
      byTask.set(l.taskId, [
        ...(byTask.get(l.taskId) ?? []),
        { id: l.id, name: l.name, color: l.color, colorEnabled: l.colorEnabled },
      ])
    }
    const g = await ctx.db.select({ key: games.key }).from(games).where(eq(games.id, input.gameId)).limit(1)
    const gameKey = g[0]?.key ?? null
    const taskIds = ts.map((task) => task.id)
    const checklistRows = taskIds.length
      ? await ctx.db
          .select()
          .from(taskChecklistItems)
          .where(inArray(taskChecklistItems.taskId, taskIds))
          .orderBy(asc(taskChecklistItems.sortOrder))
      : []
    const checklistByTask = new Map<string, typeof checklistRows>()
    for (const item of checklistRows) {
      checklistByTask.set(item.taskId, [...(checklistByTask.get(item.taskId) ?? []), item])
    }
    return ts.map((t) => ({
      ...t,
      description: taskDescriptionToMarkdown(t.description),
      taskKey: taskKeyOf(gameKey, t.seq),
      tags: byTask.get(t.id) ?? [],
      checklist: summarizeChecklist(checklistByTask.get(t.id) ?? []),
    }))
  }),

  /** A small deterministic queue that favors important work already close to completion. */
  focus: publicProcedure
    .input(z.object({ gameId: z.string(), limit: z.number().int().min(1).max(10).optional() }))
    .query(({ ctx, input }) => buildTaskFocusQueue(ctx.db, input.gameId, input.limit ?? 5)),

  /** Every task across all games, each labelled with its game + Jira-style key. */
  all: publicProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: tasks.id,
        gameId: tasks.gameId,
        gameName: games.name,
        gameKey: games.key,
        seq: tasks.seq,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
      })
      .from(tasks)
      .innerJoin(games, eq(games.id, tasks.gameId))
      .orderBy(asc(games.name), desc(tasks.seq))
    return rows.map((r) => ({ ...r, taskKey: taskKeyOf(r.gameKey, r.seq) }))
  }),

  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.id, input.id)).limit(1)
    const task = rows[0]
    if (!task) return null
    const checklist = await ctx.db
      .select()
      .from(taskChecklistItems)
      .where(eq(taskChecklistItems.taskId, task.id))
      .orderBy(asc(taskChecklistItems.sortOrder))
    const deps = await ctx.db
      .select()
      .from(taskDependencies)
      .where(or(eq(taskDependencies.blockedTaskId, task.id), eq(taskDependencies.blockerTaskId, task.id)))
    const blockedBy = deps.filter((d) => d.blockedTaskId === task.id)
    const blocks = deps.filter((d) => d.blockerTaskId === task.id)
    const tagRows = await ctx.db
      .select({ id: tags.id, name: tags.name, color: tags.color, colorEnabled: tags.colorEnabled })
      .from(taskTagLinks)
      .innerJoin(tags, eq(taskTagLinks.tagId, tags.id))
      .where(eq(taskTagLinks.taskId, task.id))
    const g = await ctx.db.select({ key: games.key }).from(games).where(eq(games.id, task.gameId)).limit(1)
    return {
      task: {
        ...task,
        description: taskDescriptionToMarkdown(task.description),
        taskKey: taskKeyOf(g[0]?.key ?? null, task.seq),
      },
      checklist,
      blockedBy,
      blocks,
      tags: tagRows,
    }
  }),

  /** All dependency edges among a game's tasks (for the dependency graph). */
  listDependencies: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    const ts = await ctx.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.gameId, input.gameId))
    const ids = ts.map((t) => t.id)
    if (!ids.length) return []
    return ctx.db
      .select()
      .from(taskDependencies)
      .where(and(inArray(taskDependencies.blockerTaskId, ids), inArray(taskDependencies.blockedTaskId, ids)))
  }),

  create: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        title: z.string().min(1).max(200),
        description: z.string().optional(),
        status: status.optional(),
        priority: priority.optional(),
        startDate: z.string().nullish(),
        dueDate: z.string().nullish(),
        tagIds: z.array(z.string()).optional(),
        newTagNames: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
        blockerTaskIds: z.array(z.string()).optional(),
        checklist: z.array(z.string().min(1).max(500)).optional(),
        recurrence: recurrence.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const seq = await nextTaskSeq(ctx.db, input.gameId)
      const tagIds = [...new Set(input.tagIds ?? [])]
      const newTagNames = [
        ...new Map((input.newTagNames ?? []).map((name) => [name.trim().toLocaleLowerCase(), name.trim()])).values(),
      ]
      const blockerTaskIds = [...new Set(input.blockerTaskIds ?? [])]
      const checklist = (input.checklist ?? []).map((item) => item.trim()).filter(Boolean)
      const now = new Date().toISOString()
      const taskValues = {
        gameId: input.gameId,
        seq,
        title: input.title,
        description: taskDescriptionToMarkdown(input.description ?? ''),
        status: input.status ?? ('todo' as const),
        priority: input.priority ?? ('med' as const),
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        completedAt: input.status === 'done' ? now : null,
        recurrenceInterval: input.recurrence?.every ?? null,
        recurrenceUnit: input.recurrence?.unit ?? null,
      }
      const hasRelatedRecords =
        tagIds.length > 0 || newTagNames.length > 0 || blockerTaskIds.length > 0 || checklist.length > 0
      const task = !hasRelatedRecords
        ? (await ctx.db.insert(tasks).values(taskValues).returning())[0]!
        : await ctx.db.transaction(async (tx) => {
            const linkedTagIds = [...tagIds]
            if (tagIds.length) {
              const validTags = await tx
                .select({ id: tags.id })
                .from(tags)
                .where(and(eq(tags.gameId, input.gameId), inArray(tags.id, tagIds)))
              if (validTags.length !== tagIds.length) throw new Error('Tags must belong to the same game as the task')
            }
            if (newTagNames.length) {
              const gameTags = await tx
                .select({ id: tags.id, name: tags.name })
                .from(tags)
                .where(eq(tags.gameId, input.gameId))
              const existingByName = new Map(gameTags.map((tag) => [tag.name.toLocaleLowerCase(), tag.id]))
              for (const name of newTagNames) {
                const existingId = existingByName.get(name.toLocaleLowerCase())
                if (existingId) {
                  if (!linkedTagIds.includes(existingId)) linkedTagIds.push(existingId)
                  continue
                }
                const created = await tx.insert(tags).values({ gameId: input.gameId, name }).returning({ id: tags.id })
                const id = created[0]!.id
                existingByName.set(name.toLocaleLowerCase(), id)
                linkedTagIds.push(id)
              }
            }
            if (blockerTaskIds.length) {
              const validBlockers = await tx
                .select({ id: tasks.id })
                .from(tasks)
                .where(and(eq(tasks.gameId, input.gameId), inArray(tasks.id, blockerTaskIds)))
              if (validBlockers.length !== blockerTaskIds.length) {
                throw new Error('Blockers must belong to the same game as the task')
              }
            }

            const rows = await tx.insert(tasks).values(taskValues).returning()
            const created = rows[0]!
            if (linkedTagIds.length) {
              await tx.insert(taskTagLinks).values(linkedTagIds.map((tagId) => ({ taskId: created.id, tagId })))
            }
            if (blockerTaskIds.length) {
              await tx
                .insert(taskDependencies)
                .values(blockerTaskIds.map((blockerTaskId) => ({ blockerTaskId, blockedTaskId: created.id })))
            }
            if (checklist.length) {
              await tx.insert(taskChecklistItems).values(
                checklist.map((text, sortOrder) => ({
                  taskId: created.id,
                  text,
                  sortOrder,
                })),
              )
            }
            return created
          })
      if (blockerTaskIds.length) await syncBlockedStatus(ctx.db, input.gameId)
      const g = await ctx.db.select({ key: games.key }).from(games).where(eq(games.id, input.gameId)).limit(1)
      return { ...task, taskKey: taskKeyOf(g[0]?.key ?? null, seq) }
    }),

  update: publicProcedure.input(z.object({ id: z.string(), patch: taskPatch })).mutation(async ({ ctx, input }) => {
    const { recurrence: recurrencePatch, ...plainPatch } = input.patch
    const set: Record<string, unknown> = stripUndefined({ ...plainPatch })
    if (input.patch.description !== undefined) {
      set.description = taskDescriptionToMarkdown(input.patch.description)
    }
    if (recurrencePatch !== undefined) {
      set.recurrenceInterval = recurrencePatch?.every ?? null
      set.recurrenceUnit = recurrencePatch?.unit ?? null
    }
    const now = new Date().toISOString()
    set.updatedAt = now
    if (input.patch.status === 'done') set.completedAt = now
    if (input.patch.status && input.patch.status !== 'done') set.completedAt = null
    const existing =
      input.patch.status === 'done' || recurrencePatch !== undefined
        ? (await ctx.db.select().from(tasks).where(eq(tasks.id, input.id)).limit(1))[0]
        : null
    const effectiveRecurrence = existing
      ? recurrencePatch === null
        ? null
        : (recurrencePatch ??
          (existing.recurrenceInterval && existing.recurrenceUnit
            ? { every: existing.recurrenceInterval, unit: existing.recurrenceUnit }
            : null))
      : null
    let updated = null
    const shouldAdvanceRecurrence =
      !!existing &&
      !!effectiveRecurrence &&
      (input.patch.status === 'done' || (existing.status === 'done' && recurrencePatch !== undefined))
    if (existing && effectiveRecurrence && shouldAdvanceRecurrence) {
      const schedule = nextRecurringSchedule({
        dueDate: (plainPatch.dueDate === undefined ? existing.dueDate : plainPatch.dueDate) ?? null,
        startDate: (plainPatch.startDate === undefined ? existing.startDate : plainPatch.startDate) ?? null,
        completedOn: now.slice(0, 10),
        recurrence: effectiveRecurrence,
      })
      set.status = 'todo'
      set.completedAt = null
      set.lastCompletedAt = now
      set.dueDate = schedule.dueDate
      set.startDate = schedule.startDate
      updated = await ctx.db.transaction(async (tx) => {
        await tx.update(taskChecklistItems).set({ done: false }).where(eq(taskChecklistItems.taskId, input.id))
        return (await tx.update(tasks).set(set).where(eq(tasks.id, input.id)).returning())[0] ?? null
      })
    } else {
      updated = (await ctx.db.update(tasks).set(set).where(eq(tasks.id, input.id)).returning())[0] ?? null
    }
    // A status change can free or re-block dependents.
    if (updated && input.patch.status) await syncBlockedStatus(ctx.db, updated.gameId)
    return updated
  }),

  /**
   * Atomically reconcile verified checklist work and finish the parent only when
   * no checklist item or dependency remains open.
   */
  complete: publicProcedure
    .input(z.object({ id: z.string(), completedChecklistItemIds: z.array(z.string()).optional() }))
    .mutation(async ({ ctx, input }) => {
      const completedChecklistItemIds = [...new Set(input.completedChecklistItemIds ?? [])]
      const result = await ctx.db.transaction(async (tx) => {
        const task = (await tx.select().from(tasks).where(eq(tasks.id, input.id)).limit(1))[0]
        if (!task) throw new Error('Task not found')
        if (task.status === 'cancelled') throw new Error('A cancelled task cannot be completed')

        const dependencyRows = await tx
          .select()
          .from(taskDependencies)
          .where(eq(taskDependencies.blockedTaskId, task.id))
        if (dependencyRows.length) {
          const blockerRows = await tx
            .select({ id: tasks.id, title: tasks.title, status: tasks.status })
            .from(tasks)
            .where(
              inArray(
                tasks.id,
                dependencyRows.map((dependency) => dependency.blockerTaskId),
              ),
            )
          const open = blockerRows.filter((blocker) => blocker.status !== 'done' && blocker.status !== 'cancelled')
          if (open.length)
            throw new Error(`Task still has open blockers: ${open.map((blocker) => blocker.title).join(', ')}`)
        }

        const before = await tx
          .select()
          .from(taskChecklistItems)
          .where(eq(taskChecklistItems.taskId, task.id))
          .orderBy(asc(taskChecklistItems.sortOrder))
        const knownIds = new Set(before.map((item) => item.id))
        const unknownId = completedChecklistItemIds.find((id) => !knownIds.has(id))
        if (unknownId) throw new Error('Checklist item does not belong to this task')
        if (completedChecklistItemIds.length) {
          await tx
            .update(taskChecklistItems)
            .set({ done: true })
            .where(
              and(eq(taskChecklistItems.taskId, task.id), inArray(taskChecklistItems.id, completedChecklistItemIds)),
            )
        }

        const checklist = await tx
          .select()
          .from(taskChecklistItems)
          .where(eq(taskChecklistItems.taskId, task.id))
          .orderBy(asc(taskChecklistItems.sortOrder))
        const remainingChecklist = checklist.filter((item) => !item.done)
        if (remainingChecklist.length) {
          return { completed: false, task, checklist, remainingChecklist }
        }

        const now = new Date().toISOString()
        const schedule = recurringSchedule(task, now.slice(0, 10))
        if (schedule) {
          await tx.update(taskChecklistItems).set({ done: false }).where(eq(taskChecklistItems.taskId, task.id))
          const updated = (
            await tx
              .update(tasks)
              .set({
                status: 'todo',
                startDate: schedule.startDate,
                dueDate: schedule.dueDate,
                completedAt: null,
                lastCompletedAt: now,
                updatedAt: now,
              })
              .where(eq(tasks.id, task.id))
              .returning()
          )[0]!
          return {
            completed: true,
            recurring: true,
            nextDueDate: schedule.dueDate,
            task: updated,
            checklist,
            remainingChecklist: [],
          }
        }
        const updated = (
          await tx
            .update(tasks)
            .set({ status: 'done', completedAt: task.completedAt ?? now, lastCompletedAt: now, updatedAt: now })
            .where(eq(tasks.id, task.id))
            .returning()
        )[0]!
        return {
          completed: true,
          recurring: false,
          nextDueDate: null,
          task: updated,
          checklist,
          remainingChecklist: [],
        }
      })
      if (result.completed) await syncBlockedStatus(ctx.db, result.task.gameId)
      return { ...result, checklistSummary: summarizeChecklist(result.checklist) }
    }),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(tasks).where(eq(tasks.id, input.id))
    return { id: input.id }
  }),

  // ---- batch management (for tag-grouped tracks) ----
  bulkUpdate: publicProcedure
    .input(
      z.object({
        ids: z.array(z.string()).min(1),
        patch: z.object({ status: status.optional(), priority: priority.optional() }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const set: Record<string, unknown> = stripUndefined({ ...input.patch })
      const now = new Date().toISOString()
      set.updatedAt = now
      if (input.patch.status === 'done') set.completedAt = now
      if (input.patch.status && input.patch.status !== 'done') set.completedAt = null
      if (input.patch.status === 'done') {
        const selected = await ctx.db.select().from(tasks).where(inArray(tasks.id, input.ids))
        const recurring = selected.filter((task) => task.recurrenceInterval && task.recurrenceUnit)
        const recurringIds = new Set(recurring.map((task) => task.id))
        const ordinaryIds = input.ids.filter((id) => !recurringIds.has(id))
        await ctx.db.transaction(async (tx) => {
          if (ordinaryIds.length) await tx.update(tasks).set(set).where(inArray(tasks.id, ordinaryIds))
          for (const task of recurring) {
            const schedule = recurringSchedule(task, now.slice(0, 10))!
            await tx.update(taskChecklistItems).set({ done: false }).where(eq(taskChecklistItems.taskId, task.id))
            await tx
              .update(tasks)
              .set({
                ...set,
                status: 'todo',
                startDate: schedule.startDate,
                dueDate: schedule.dueDate,
                completedAt: null,
                lastCompletedAt: now,
              })
              .where(eq(tasks.id, task.id))
          }
        })
      } else {
        await ctx.db.update(tasks).set(set).where(inArray(tasks.id, input.ids))
      }
      if (input.patch.status) {
        const affected = await ctx.db
          .selectDistinct({ gameId: tasks.gameId })
          .from(tasks)
          .where(inArray(tasks.id, input.ids))
        for (const game of affected) await syncBlockedStatus(ctx.db, game.gameId)
      }
      return { count: input.ids.length }
    }),

  bulkRemove: publicProcedure.input(z.object({ ids: z.array(z.string()).min(1) })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(tasks).where(inArray(tasks.id, input.ids))
    return { count: input.ids.length }
  }),

  bulkAssignTag: publicProcedure
    .input(z.object({ ids: z.array(z.string()).min(1), tagId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [tag] = await ctx.db.select({ gameId: tags.gameId }).from(tags).where(eq(tags.id, input.tagId)).limit(1)
      if (!tag) throw new Error('Tag not found')
      const linkedTasks = await ctx.db
        .select({ id: tasks.id, gameId: tasks.gameId })
        .from(tasks)
        .where(inArray(tasks.id, input.ids))
      if (linkedTasks.length !== new Set(input.ids).size || linkedTasks.some((task) => task.gameId !== tag.gameId)) {
        throw new Error('Tasks and tag must belong to the same game')
      }
      await ctx.db
        .insert(taskTagLinks)
        .values([...new Set(input.ids)].map((taskId) => ({ taskId, tagId: input.tagId })))
        .onConflictDoNothing()
      return { count: input.ids.length }
    }),

  bulkUnassignTag: publicProcedure
    .input(z.object({ ids: z.array(z.string()).min(1), tagId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(taskTagLinks)
        .where(and(inArray(taskTagLinks.taskId, input.ids), eq(taskTagLinks.tagId, input.tagId)))
      return { count: input.ids.length }
    }),

  // ---- checklist ----
  addChecklistItem: publicProcedure
    .input(z.object({ taskId: z.string(), text: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.select().from(taskChecklistItems).where(eq(taskChecklistItems.taskId, input.taskId))
      const rows = await ctx.db
        .insert(taskChecklistItems)
        .values({ taskId: input.taskId, text: input.text, sortOrder: existing.length })
        .returning()
      return rows[0]!
    }),

  toggleChecklistItem: publicProcedure
    .input(z.object({ id: z.string(), done: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.update(taskChecklistItems).set({ done: input.done }).where(eq(taskChecklistItems.id, input.id))
      return { id: input.id }
    }),

  removeChecklistItem: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(taskChecklistItems).where(eq(taskChecklistItems.id, input.id))
    return { id: input.id }
  }),

  reorderChecklist: publicProcedure
    .input(z.object({ taskId: z.string(), orderedIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        for (let i = 0; i < input.orderedIds.length; i++) {
          await tx
            .update(taskChecklistItems)
            .set({ sortOrder: i })
            .where(and(eq(taskChecklistItems.id, input.orderedIds[i]!), eq(taskChecklistItems.taskId, input.taskId)))
        }
      })
      return { ok: true }
    }),

  // ---- tags ----
  assignTag: publicProcedure
    .input(z.object({ taskId: z.string(), tagId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [task, tag] = await Promise.all([
        ctx.db.select({ gameId: tasks.gameId }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1),
        ctx.db.select({ gameId: tags.gameId }).from(tags).where(eq(tags.id, input.tagId)).limit(1),
      ])
      if (!task[0] || !tag[0] || task[0].gameId !== tag[0].gameId) {
        throw new Error('Task and tag must belong to the same game')
      }
      await ctx.db.insert(taskTagLinks).values(input).onConflictDoNothing()
      return { ok: true }
    }),

  unassignTag: publicProcedure
    .input(z.object({ taskId: z.string(), tagId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(taskTagLinks)
        .where(and(eq(taskTagLinks.taskId, input.taskId), eq(taskTagLinks.tagId, input.tagId)))
      return { ok: true }
    }),

  // ---- dependencies ----
  addDependency: publicProcedure
    .input(z.object({ blockerTaskId: z.string(), blockedTaskId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const pair = await ctx.db
        .select({ id: tasks.id, gameId: tasks.gameId })
        .from(tasks)
        .where(inArray(tasks.id, [input.blockerTaskId, input.blockedTaskId]))
      if (pair.length !== 2 || pair[0]!.gameId !== pair[1]!.gameId) {
        throw new Error('Dependencies are only allowed between tasks in the same game')
      }
      const gameId = pair[0]!.gameId
      if (await wouldCycle(ctx.db, gameId, input.blockerTaskId, input.blockedTaskId)) {
        throw new Error('Циклическая зависимость не допускается')
      }
      const dup = await ctx.db
        .select()
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.blockerTaskId, input.blockerTaskId),
            eq(taskDependencies.blockedTaskId, input.blockedTaskId),
          ),
        )
      if (dup.length) return dup[0]!
      const rows = await ctx.db
        .insert(taskDependencies)
        .values({ blockerTaskId: input.blockerTaskId, blockedTaskId: input.blockedTaskId })
        .onConflictDoNothing()
        .returning()
      await syncBlockedStatus(ctx.db, gameId)
      if (rows[0]) return rows[0]
      const existing = await ctx.db
        .select()
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.blockerTaskId, input.blockerTaskId),
            eq(taskDependencies.blockedTaskId, input.blockedTaskId),
          ),
        )
        .limit(1)
      return existing[0]!
    }),

  removeDependency: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const dep = await ctx.db.select().from(taskDependencies).where(eq(taskDependencies.id, input.id)).limit(1)
    await ctx.db.delete(taskDependencies).where(eq(taskDependencies.id, input.id))
    if (dep[0]) {
      const blocked = await ctx.db
        .select({ gameId: tasks.gameId })
        .from(tasks)
        .where(eq(tasks.id, dep[0].blockedTaskId))
        .limit(1)
      if (blocked[0]) await syncBlockedStatus(ctx.db, blocked[0].gameId)
    }
    return { id: input.id }
  }),
})
