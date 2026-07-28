import { asc, desc, eq, or } from 'drizzle-orm'
import {
  events,
  festivalPicks,
  games,
  insights,
  industryEvents,
  projectCards,
  tags,
  taskTagLinks,
  tasks,
  wishlistPoints,
  type DB,
} from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { resolveWishlistBalance } from '../wishlist'
import { buildTaskFocusQueue } from '../taskFocus'
import { getProjectCardInsight } from '../projectCardInsight'

const dayMs = 86_400_000
const todayIso = () => new Date().toISOString().slice(0, 10)
const daysUntil = (iso: string, today: string) =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / dayMs)

const link = z.object({ label: z.string().min(1), url: z.string().min(1) })
const doc = z.object({ label: z.string().min(1), path: z.string().optional(), url: z.string().optional() })
const lookup = z.object({ gameId: z.string().optional(), key: z.string().optional() })
const patch = lookup.extend({
  oneLiner: z.string().optional(),
  description: z.string().optional(),
  audience: z.string().optional(),
  positioning: z.string().optional(),
  repository: z.string().optional(),
  branch: z.string().optional(),
  devhubWikiUrl: z.string().optional(),
  agentNotes: z.string().optional(),
  links: z.array(link).optional(),
  docs: z.array(doc).optional(),
  updatedBy: z.enum(['manual', 'mcp', 'ai']).optional(),
})

type Link = z.infer<typeof link>
type Doc = z.infer<typeof doc>
type Lookup = z.infer<typeof lookup>

function normalizeKey(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10)
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  try {
    const value = JSON.parse(raw || '[]')
    return Array.isArray(value) ? (value as T[]) : []
  } catch {
    return []
  }
}

function parsePlatforms(raw: string | null): { id: string; url: string }[] {
  return parseJsonArray<unknown>(raw)
    .map((x) =>
      typeof x === 'string'
        ? { id: x, url: '' }
        : { id: String((x as { id?: unknown }).id ?? ''), url: String((x as { url?: unknown }).url ?? '') },
    )
    .filter((p) => p.id)
}

async function resolveGame(db: DB, input: Lookup) {
  if (input.gameId) {
    const rows = await db.select().from(games).where(eq(games.id, input.gameId)).limit(1)
    if (rows[0]) return rows[0]
  }
  const key = normalizeKey(input.key ?? '')
  if (key) {
    const rows = await db
      .select()
      .from(games)
      .where(or(eq(games.key, key), eq(games.devhubProject, key)))
      .limit(1)
    if (rows[0]) return rows[0]
  }
  throw new Error('Project card needs a known gameId or project key.')
}

async function buildProjectCard(db: DB, input: Lookup) {
  const game = await resolveGame(db, input)
  const today = todayIso()
  const projectKey = game.devhubProject ?? game.key ?? null

  const [card] = await db.select().from(projectCards).where(eq(projectCards.gameId, game.id)).limit(1)
  const insightCatalog = await db
    .select({
      id: insights.id,
      title: insights.title,
      createdBy: insights.createdBy,
      updatedAt: insights.updatedAt,
    })
    .from(insights)
    .where(eq(insights.gameId, game.id))
    .orderBy(desc(insights.updatedAt))
  const requiredProjectCardInsight = await getProjectCardInsight(db, game.id)
  const requiredProjectCardCatalogEntry = requiredProjectCardInsight
    ? {
        id: requiredProjectCardInsight.id,
        title: requiredProjectCardInsight.title,
        createdBy: requiredProjectCardInsight.createdBy,
        createdAt: requiredProjectCardInsight.createdAt,
        updatedAt: requiredProjectCardInsight.updatedAt,
        kind: requiredProjectCardInsight.kind,
        required: requiredProjectCardInsight.required,
        filled: !!requiredProjectCardInsight.body.trim(),
      }
    : null
  const ts = await db.select().from(tasks).where(eq(tasks.gameId, game.id))
  const openTasks = ts.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
  const datedTags = await db.select().from(tags).where(eq(tags.gameId, game.id)).orderBy(asc(tags.targetDate))
  const linked = await db
    .select({ tagId: taskTagLinks.tagId, status: tasks.status, dueDate: tasks.dueDate })
    .from(taskTagLinks)
    .innerJoin(tasks, eq(tasks.id, taskTagLinks.taskId))
    .where(eq(tasks.gameId, game.id))
  const tagStats = new Map<string, { total: number; open: number; overdue: number }>()
  for (const l of linked) {
    const current = tagStats.get(l.tagId) ?? { total: 0, open: 0, overdue: 0 }
    current.total++
    if (l.status !== 'done' && l.status !== 'cancelled') {
      current.open++
      if (l.dueDate && l.dueDate < today) current.overdue++
    }
    tagStats.set(l.tagId, current)
  }

  const festivals = await db
    .select({
      industryEventId: industryEvents.id,
      name: industryEvents.name,
      type: industryEvents.type,
      status: festivalPicks.status,
      startDate: industryEvents.startDate,
      endDate: industryEvents.endDate,
      applyDeadline: industryEvents.applyDeadline,
      organizer: industryEvents.organizer,
      url: industryEvents.url,
      applyUrl: industryEvents.applyUrl,
    })
    .from(festivalPicks)
    .innerJoin(industryEvents, eq(industryEvents.id, festivalPicks.industryEventId))
    .where(eq(festivalPicks.gameId, game.id))
  const recentActivities = await db
    .select({
      id: events.id,
      occurredAt: events.occurredAt,
      subjectType: events.subjectType,
      subjectId: events.subjectId,
      subjectLabel: events.subjectLabel,
      showOnWishlist: events.showOnWishlist,
      direction: events.direction,
      channel: events.channel,
      type: events.type,
      platform: events.platform,
      placement: events.placement,
      title: events.title,
      body: events.description,
      url: events.url,
      views: events.views,
      likes: events.likes,
      comments: events.comments,
      isOwn: events.isOwn,
      statusAfter: events.statusAfter,
      createdBy: events.createdBy,
    })
    .from(events)
    .where(eq(events.gameId, game.id))
    .orderBy(desc(events.occurredAt), desc(events.createdAt))
    .limit(20)
  const recentEvents = recentActivities.filter((activity) => activity.showOnWishlist).slice(0, 8)
  const points = await db
    .select({
      date: wishlistPoints.date,
      adds: wishlistPoints.adds,
      deletes: wishlistPoints.deletes,
      balance: wishlistPoints.balance,
      net: wishlistPoints.net,
    })
    .from(wishlistPoints)
    .where(eq(wishlistPoints.gameId, game.id))
    .orderBy(asc(wishlistPoints.date))

  const latest = points.at(-1) ?? null
  const previous = points.at(-2) ?? null
  const latestBalance = resolveWishlistBalance(points)
  const latestChange =
    latest?.adds != null && latest.adds > 0
      ? latest.adds
      : latest?.balance != null && previous?.balance != null
        ? latest.balance - previous.balance
        : null
  const taskFocus = await buildTaskFocusQueue(db, game.id, 8, today)

  return {
    project: {
      gameId: game.id,
      name: game.name,
      key: game.key,
      devhubProject: projectKey,
      steamAppId: game.steamAppId,
      steamStoreUrl: game.steamStoreUrl,
      releaseDate: game.releaseDate,
      platforms: parsePlatforms(game.platforms),
      officialLinks: parseJsonArray<{ type: string; url: string; label?: string }>(game.officialLinks),
      color: game.color,
      archived: game.archived,
    },
    card: {
      oneLiner: card?.oneLiner ?? '',
      description: card?.description ?? '',
      audience: card?.audience ?? '',
      positioning: card?.positioning ?? '',
      repository: card?.repository ?? '',
      branch: card?.branch ?? '',
      devhubWikiUrl: card?.devhubWikiUrl ?? '',
      agentNotes: card?.agentNotes ?? '',
      links: parseJsonArray<Link>(card?.linksJson),
      docs: parseJsonArray<Doc>(card?.docsJson),
      updatedAt: card?.updatedAt ?? null,
      updatedBy: card?.updatedBy ?? 'manual',
    },
    insights: [
      ...(requiredProjectCardCatalogEntry ? [requiredProjectCardCatalogEntry] : []),
      ...insightCatalog.map((insight) => ({
        ...insight,
        kind: 'insight' as const,
        required: false as const,
        filled: true as const,
      })),
    ],
    status: {
      tasks: {
        total: ts.length,
        open: openTasks.length,
        doing: ts.filter((t) => t.status === 'doing').length,
        blocked: ts.filter((t) => t.status === 'blocked').length,
        overdue: openTasks.filter((t) => t.dueDate && t.dueDate < today).length,
        next: taskFocus.focus,
        needsClarification: taskFocus.needsClarification,
      },
      deadlines: datedTags
        .filter((t) => t.targetDate)
        .map((t) => {
          const stats = tagStats.get(t.id) ?? { total: 0, open: 0, overdue: 0 }
          return {
            id: t.id,
            name: t.name,
            type: t.type,
            targetDate: t.targetDate!,
            daysLeft: daysUntil(t.targetDate!, today),
            linkedTasks: stats.total,
            openTasks: stats.open,
            overdueTasks: stats.overdue,
          }
        }),
      festivals: festivals
        .sort((a, b) => ((a.applyDeadline ?? a.startDate) < (b.applyDeadline ?? b.startDate) ? -1 : 1))
        .map((f) => ({
          ...f,
          applyDaysLeft: f.applyDeadline ? daysUntil(f.applyDeadline, today) : null,
          startDaysLeft: daysUntil(f.startDate, today),
        })),
      recentEvents,
      recentActivities: recentActivities.map((activity) => ({
        ...activity,
        body: activity.body.slice(0, 600),
      })),
      wishlist: {
        points: points.length,
        latestDate: latest?.date ?? null,
        latestAdds: latest?.adds ?? null,
        latestDeletes: latest?.deletes ?? null,
        latestNet: latest?.net ?? null,
        latestBalance,
        latestChange,
      },
    },
    agentEntryPoints: {
      projectKey,
      marcat: `get_project_card({ key: "${projectKey ?? game.key ?? game.id}" })`,
      devhub: projectKey ? `DevHub project ${projectKey}` : null,
    },
  }
}

export const projectCardsRouter = router({
  get: publicProcedure.input(lookup).query(async ({ ctx, input }) => {
    const card = await buildProjectCard(ctx.db, input)
    return {
      ...card,
      workspace: ctx.workspace ? await ctx.workspace.status(card.project.gameId) : null,
    }
  }),

  update: publicProcedure.input(patch).mutation(async ({ ctx, input }) => {
    const game = await resolveGame(ctx.db, input)
    const updatedAt = new Date().toISOString()
    const values: Partial<typeof projectCards.$inferInsert> = {
      updatedAt,
      updatedBy: input.updatedBy ?? 'manual',
    }
    const setString = (
      key:
        | 'oneLiner'
        | 'description'
        | 'audience'
        | 'positioning'
        | 'repository'
        | 'branch'
        | 'devhubWikiUrl'
        | 'agentNotes',
      value: string | undefined,
    ) => {
      if (value !== undefined) values[key] = value
    }
    setString('oneLiner', input.oneLiner)
    setString('description', input.description)
    setString('audience', input.audience)
    setString('positioning', input.positioning)
    setString('repository', input.repository)
    setString('branch', input.branch)
    setString('devhubWikiUrl', input.devhubWikiUrl)
    setString('agentNotes', input.agentNotes)
    if (input.links !== undefined) values.linksJson = JSON.stringify(input.links)
    if (input.docs !== undefined) values.docsJson = JSON.stringify(input.docs)

    const existing = await ctx.db.select().from(projectCards).where(eq(projectCards.gameId, game.id)).limit(1)
    if (existing.length) {
      await ctx.db.update(projectCards).set(values).where(eq(projectCards.gameId, game.id))
    } else {
      await ctx.db.insert(projectCards).values({ gameId: game.id, ...values })
    }
    const card = await buildProjectCard(ctx.db, { gameId: game.id })
    return { ...card, workspace: ctx.workspace ? await ctx.workspace.status(game.id) : null }
  }),
})
