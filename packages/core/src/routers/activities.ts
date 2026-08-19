import { and, desc, eq, gte, lte, or, sql, type SQL } from 'drizzle-orm'
import { creatorPicks, creators, events, festivalPicks, industryEvents, tasks, type DB } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { stripUndefined } from '../util/slug'
import {
  ACTIVITY_CHANNELS,
  ACTIVITY_CREATED_BY,
  ACTIVITY_DIRECTIONS,
  ACTIVITY_PLATFORMS,
  ACTIVITY_SUBJECTS,
  ACTIVITY_TYPES,
} from '../activitySemantics'

export const activitySubject = z.enum(ACTIVITY_SUBJECTS)
const direction = z.enum(ACTIVITY_DIRECTIONS)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const creatorStatuses = new Set(['prospect', 'contacted', 'replied', 'agreed', 'published', 'closed'])
const festivalStatuses = new Set(['none', 'materials', 'submitted', 'replied', 'approved', 'rejected'])

const editableFields = z.object({
  occurredAt: day.optional(),
  subjectType: activitySubject.optional(),
  subjectId: z.string().nullable().optional(),
  title: z.string().max(300).optional(),
  body: z.string().optional(),
  direction: direction.nullable().optional(),
  channel: z.enum(ACTIVITY_CHANNELS).nullable().optional(),
  statusAfter: z.string().max(80).nullable().optional(),
  showOnWishlist: z.boolean().optional(),
  type: z.enum(ACTIVITY_TYPES).optional(),
  platform: z.enum(ACTIVITY_PLATFORMS).nullable().optional(),
  placement: z.string().max(300).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  views: z.number().int().nullable().optional(),
  likes: z.number().int().nullable().optional(),
  comments: z.number().int().nullable().optional(),
  isOwn: z.boolean().optional(),
})

const activityListInput = z.object({
  gameId: z.string(),
  subjectType: activitySubject.optional(),
  subjectId: z.string().nullable().optional(),
  wishlistOnly: z.boolean().optional(),
  search: z.string().optional(),
  from: day.optional(),
  to: day.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
})

function activityFilters(input: z.infer<typeof activityListInput>): SQL[] {
  const filters: SQL[] = [eq(events.gameId, input.gameId)]
  if (input.subjectType) filters.push(eq(events.subjectType, input.subjectType))
  if (input.subjectId !== undefined) {
    filters.push(input.subjectId === null ? sql`${events.subjectId} IS NULL` : eq(events.subjectId, input.subjectId))
  }
  if (input.wishlistOnly) filters.push(eq(events.showOnWishlist, true))
  if (input.from) filters.push(gte(events.occurredAt, input.from))
  if (input.to) filters.push(lte(events.occurredAt, input.to))
  const query = input.search?.trim()
  if (query) {
    const forms = [
      ...new Set([
        query,
        query.toLocaleLowerCase(),
        query.toLocaleUpperCase(),
        `${query.slice(0, 1).toLocaleUpperCase()}${query.slice(1).toLocaleLowerCase()}`,
      ]),
    ]
    const searchable = [events.title, events.description, events.subjectLabel, events.channel, events.platform]
    filters.push(
      or(...forms.flatMap((form) => searchable.map((column) => sql`instr(coalesce(${column}, ''), ${form}) > 0`)))!,
    )
  }
  return filters
}

function activityExcerpt(body: string, query: string | undefined, maxLength = 240): string | null {
  const text = body.replace(/\s+/g, ' ').trim()
  if (!text) return null
  const matchAt = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : 0
  const start = Math.max(0, matchAt < 0 ? 0 : matchAt - 80)
  const end = Math.min(text.length, start + maxLength)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function titleFrom(title: string | undefined, body: string | undefined, dir?: 'outbound' | 'inbound' | null): string {
  const explicit = title?.trim()
  if (explicit) return explicit.slice(0, 300)
  const firstLine = body
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (firstLine) return firstLine.slice(0, 300)
  return dir === 'inbound' ? 'Received reply' : dir === 'outbound' ? 'Sent message' : 'Activity'
}

async function resolveSubject(
  ctx: { db: DB },
  gameId: string,
  subjectType: (typeof ACTIVITY_SUBJECTS)[number],
  subjectId: string | null | undefined,
): Promise<{ id: string | null; label: string | null }> {
  if (subjectType === 'project') return { id: null, label: null }
  if (!subjectId) throw new Error('Choose what this activity belongs to')

  if (subjectType === 'task') {
    const row = await ctx.db
      .select({ id: tasks.id, label: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.id, subjectId), eq(tasks.gameId, gameId)))
      .limit(1)
    if (!row[0]) throw new Error('Task not found in this project')
    return row[0]
  }
  if (subjectType === 'festival') {
    const row = await ctx.db
      .select({ id: industryEvents.id, label: industryEvents.name })
      .from(industryEvents)
      .where(eq(industryEvents.id, subjectId))
      .limit(1)
    if (!row[0]) throw new Error('Festival not found')
    return row[0]
  }
  const row = await ctx.db
    .select({ id: creators.id, label: creators.name })
    .from(creators)
    .where(eq(creators.id, subjectId))
    .limit(1)
  if (!row[0]) throw new Error('Creator not found')
  return row[0]
}

async function applyStatusAfter(
  ctx: { db: DB },
  gameId: string,
  subjectType: string,
  subjectId: string | null,
  statusAfter: string | null | undefined,
): Promise<void> {
  if (!statusAfter || !subjectId) return
  if (subjectType === 'creator') {
    if (!creatorStatuses.has(statusAfter)) throw new Error('Unknown creator status')
    await ctx.db
      .update(creatorPicks)
      .set({ pipelineStatus: statusAfter })
      .where(and(eq(creatorPicks.gameId, gameId), eq(creatorPicks.creatorId, subjectId)))
  } else if (subjectType === 'festival') {
    if (!festivalStatuses.has(statusAfter)) throw new Error('Unknown festival status')
    await ctx.db
      .update(festivalPicks)
      .set({ status: statusAfter })
      .where(and(eq(festivalPicks.gameId, gameId), eq(festivalPicks.industryEventId, subjectId)))
  } else {
    throw new Error('statusAfter is valid only for creator or festival activities')
  }
}

export const activitiesRouter = router({
  list: publicProcedure.input(activityListInput).query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select()
      .from(events)
      .where(and(...activityFilters(input)))
      .orderBy(desc(events.occurredAt), desc(events.createdAt))
      .limit(input.limit ?? 300)
      .offset(input.offset ?? 0)
    return rows.map((row) => ({ ...row, body: row.description }))
  }),

  /** Compact page for agents; full bodies remain available through get. */
  search: publicProcedure.input(activityListInput).query(async ({ ctx, input }) => {
    const filters = activityFilters(input)
    const limit = Math.min(input.limit ?? 20, 100)
    const offset = input.offset ?? 0
    const [rows, countRows] = await Promise.all([
      ctx.db
        .select()
        .from(events)
        .where(and(...filters))
        .orderBy(desc(events.occurredAt), desc(events.createdAt), desc(events.id))
        .limit(limit)
        .offset(offset),
      ctx.db
        .select({ value: sql<number>`count(*)` })
        .from(events)
        .where(and(...filters)),
    ])
    const totalCount = Number(countRows[0]?.value ?? 0)
    const nextOffset = offset + rows.length
    return {
      totalCount,
      offset,
      limit,
      nextOffset: nextOffset < totalCount ? nextOffset : null,
      items: rows.map((row) => ({
        id: row.id,
        gameId: row.gameId,
        occurredAt: row.occurredAt,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        subjectLabel: row.subjectLabel,
        showOnWishlist: row.showOnWishlist,
        direction: row.direction,
        channel: row.channel,
        statusAfter: row.statusAfter,
        type: row.type,
        platform: row.platform,
        placement: row.placement,
        title: row.title,
        excerpt: activityExcerpt(row.description, input.search),
        url: row.url,
        views: row.views,
        likes: row.likes,
        comments: row.comments,
        isOwn: row.isOwn,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    }
  }),

  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const row = (await ctx.db.select().from(events).where(eq(events.id, input.id)).limit(1))[0]
    return row ? { ...row, body: row.description } : null
  }),

  create: publicProcedure
    .input(
      editableFields.extend({
        gameId: z.string(),
        subjectType: activitySubject.default('project'),
        subjectId: z.string().nullable().optional(),
        createdBy: z.enum(ACTIVITY_CREATED_BY).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!input.title?.trim() && !input.body?.trim()) throw new Error('Write a note first')
      const subject = await resolveSubject(ctx, input.gameId, input.subjectType, input.subjectId)
      return ctx.db.transaction(async (tx) => {
        const rows = await tx
          .insert(events)
          .values({
            gameId: input.gameId,
            occurredAt: input.occurredAt ?? new Date().toISOString().slice(0, 10),
            subjectType: input.subjectType,
            subjectId: subject.id,
            subjectLabel: subject.label,
            showOnWishlist: input.showOnWishlist ?? false,
            direction: input.direction ?? null,
            channel: input.channel ?? null,
            statusAfter: input.statusAfter ?? null,
            type: input.type ?? 'other',
            platform: input.platform ?? null,
            placement: input.placement ?? null,
            title: titleFrom(input.title, input.body, input.direction),
            description: input.body ?? '',
            url: input.url ?? null,
            views: input.views ?? null,
            likes: input.likes ?? null,
            comments: input.comments ?? null,
            isOwn: input.isOwn ?? input.direction !== 'inbound',
            creatorId: input.subjectType === 'creator' ? subject.id : null,
            createdBy: input.createdBy ?? 'manual',
          })
          .returning()
        await applyStatusAfter(
          { db: tx as unknown as DB },
          input.gameId,
          input.subjectType,
          subject.id,
          input.statusAfter,
        )
        return { ...rows[0]!, body: rows[0]!.description }
      })
    }),

  update: publicProcedure
    .input(z.object({ id: z.string(), patch: editableFields }))
    .mutation(async ({ ctx, input }) => {
      const current = (await ctx.db.select().from(events).where(eq(events.id, input.id)).limit(1))[0]
      if (!current) return null
      const subjectType = input.patch.subjectType ?? current.subjectType
      const subjectId = input.patch.subjectId !== undefined ? input.patch.subjectId : current.subjectId
      const subject =
        input.patch.subjectType !== undefined || input.patch.subjectId !== undefined
          ? await resolveSubject(ctx, current.gameId, subjectType, subjectId)
          : { id: current.subjectId, label: current.subjectLabel }
      const patch = stripUndefined({
        occurredAt: input.patch.occurredAt,
        subjectType,
        subjectId: subject.id,
        subjectLabel: subject.label,
        title:
          input.patch.title !== undefined || input.patch.body !== undefined
            ? titleFrom(input.patch.title, input.patch.body, input.patch.direction ?? current.direction)
            : undefined,
        description: input.patch.body,
        direction: input.patch.direction,
        channel: input.patch.channel,
        statusAfter: input.patch.statusAfter,
        showOnWishlist: input.patch.showOnWishlist,
        type: input.patch.type,
        platform: input.patch.platform,
        placement: input.patch.placement,
        url: input.patch.url,
        views: input.patch.views,
        likes: input.patch.likes,
        comments: input.patch.comments,
        isOwn: input.patch.isOwn,
        creatorId: subjectType === 'creator' ? subject.id : null,
        updatedAt: new Date().toISOString(),
      })
      return ctx.db.transaction(async (tx) => {
        const rows = await tx.update(events).set(patch).where(eq(events.id, input.id)).returning()
        await applyStatusAfter(
          { db: tx as unknown as DB },
          current.gameId,
          subjectType,
          subject.id,
          input.patch.statusAfter,
        )
        return rows[0] ? { ...rows[0], body: rows[0].description } : null
      })
    }),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(events).where(eq(events.id, input.id))
    return { id: input.id }
  }),
})
