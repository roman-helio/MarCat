import { and, desc, eq } from 'drizzle-orm'
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
  list: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        subjectType: activitySubject.optional(),
        subjectId: z.string().nullable().optional(),
        wishlistOnly: z.boolean().optional(),
        search: z.string().optional(),
        from: day.optional(),
        to: day.optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      let rows = await ctx.db
        .select()
        .from(events)
        .where(eq(events.gameId, input.gameId))
        .orderBy(desc(events.occurredAt), desc(events.createdAt))
      if (input.subjectType) rows = rows.filter((row) => row.subjectType === input.subjectType)
      if (input.subjectId !== undefined) rows = rows.filter((row) => row.subjectId === input.subjectId)
      if (input.wishlistOnly) rows = rows.filter((row) => row.showOnWishlist)
      if (input.from) rows = rows.filter((row) => row.occurredAt >= input.from!)
      if (input.to) rows = rows.filter((row) => row.occurredAt <= input.to!)
      const needle = input.search?.trim().toLocaleLowerCase()
      if (needle) {
        rows = rows.filter((row) =>
          [row.title, row.description, row.subjectLabel, row.channel, row.platform]
            .filter(Boolean)
            .some((value) => value!.toLocaleLowerCase().includes(needle)),
        )
      }
      return rows.slice(0, input.limit ?? 300).map((row) => ({ ...row, body: row.description }))
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
