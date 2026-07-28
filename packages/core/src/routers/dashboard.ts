import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import {
  aiProposalChanges,
  aiRuns,
  apiSpend,
  creatorPicks,
  festivalPicks,
  games,
  industryEvents,
  inboxComments,
  providerSettings,
  sources,
  tags,
  taskTagLinks,
  tasks,
  wishlistPoints,
} from '@marcat/db'
import { router, publicProcedure } from '../trpc'
import { resolveWishlistBalance } from '../wishlist'

const dayMs = 86_400_000
const daysUntil = (iso: string, today: string) =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / dayMs)

type Meta = { name: string; color: string; key: string | null }

/**
 * Cross-game dashboard: one aggregate query that powers every All-Games panel
 * (deadlines, festival deadlines, overdue/upcoming tasks, AI review queue,
 * failed syncs, spend vs budget, wishlist movement). Deterministic — no LLM.
 */
export const dashboardRouter = router({
  overview: publicProcedure.query(async ({ ctx }) => {
    const db = ctx.db
    const today = new Date().toISOString().slice(0, 10)

    const gs = await db.select().from(games).where(eq(games.archived, false)).orderBy(asc(games.name))
    const gameMap = new Map<string, Meta>(gs.map((g) => [g.id, { name: g.name, color: g.color, key: g.key }]))
    const ids = gs.map((g) => g.id)
    const meta = (id: string | null): Meta => (id && gameMap.get(id)) || { name: '?', color: '#888888', key: null }

    // --- Deadlines (dated tags) with linked-task progress + at-risk flags ---
    const datedTags = ids.length
      ? await db
          .select()
          .from(tags)
          .where(and(inArray(tags.gameId, ids), isNotNull(tags.targetDate)))
      : []
    const tagLinks = ids.length
      ? await db
          .select({
            taskId: taskTagLinks.taskId,
            tagId: taskTagLinks.tagId,
            tagName: tags.name,
            tagColor: tags.color,
            tagColorEnabled: tags.colorEnabled,
            status: tasks.status,
            dueDate: tasks.dueDate,
          })
          .from(taskTagLinks)
          .innerJoin(tasks, eq(taskTagLinks.taskId, tasks.id))
          .innerJoin(tags, eq(taskTagLinks.tagId, tags.id))
          .where(inArray(tasks.gameId, ids))
      : []
    const byTag = new Map<string, { status: string; dueDate: string | null }[]>()
    for (const l of tagLinks) byTag.set(l.tagId, [...(byTag.get(l.tagId) ?? []), l])
    const byTaskTags = new Map<string, { id: string; name: string; color: string; colorEnabled: boolean }[]>()
    for (const l of tagLinks) {
      byTaskTags.set(l.taskId, [
        ...(byTaskTags.get(l.taskId) ?? []),
        { id: l.tagId, name: l.tagName, color: l.tagColor, colorEnabled: l.tagColorEnabled },
      ])
    }
    const deadlines = datedTags
      .map((tg) => {
        const linked = byTag.get(tg.id) ?? []
        const open = linked.filter((x) => x.status !== 'done' && x.status !== 'cancelled')
        const overdueCount = open.filter((x) => x.dueDate && x.dueDate < today).length
        const dl = daysUntil(tg.targetDate!, today)
        const alarm = overdueCount > 0 || (dl < 0 && open.length > 0)
        const warn = !alarm && dl >= 0 && dl <= 14 && open.length > 0
        const m = meta(tg.gameId)
        return {
          gameId: tg.gameId,
          gameName: m.name,
          color: m.color,
          id: tg.id,
          name: tg.name,
          type: tg.type,
          targetDate: tg.targetDate!,
          daysLeft: dl,
          openCount: open.length,
          overdueCount,
          alarm,
          warn,
        }
      })
      .sort((a, b) => (a.targetDate < b.targetDate ? -1 : 1))

    // --- Tasks: overdue + upcoming (dated, still open) across games ---
    const allTasks = ids.length
      ? await db
          .select({
            id: tasks.id,
            gameId: tasks.gameId,
            title: tasks.title,
            dueDate: tasks.dueDate,
            status: tasks.status,
            priority: tasks.priority,
            seq: tasks.seq,
          })
          .from(tasks)
          .where(inArray(tasks.gameId, ids))
      : []
    const openDated = allTasks.filter(
      (t): t is typeof t & { dueDate: string } => !!t.dueDate && t.status !== 'done' && t.status !== 'cancelled',
    )
    const withTaskMeta = (t: (typeof openDated)[number]) => {
      const m = meta(t.gameId)
      return {
        id: t.id,
        gameId: t.gameId,
        gameName: m.name,
        color: m.color,
        title: t.title,
        dueDate: t.dueDate,
        status: t.status,
        priority: t.priority,
        taskKey: m.key ? `${m.key}-${t.seq}` : null,
        tags: byTaskTags.get(t.id) ?? [],
        daysLeft: daysUntil(t.dueDate, today),
      }
    }
    const tasksOverdue = openDated
      .filter((t) => t.dueDate < today)
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))
      .map(withTaskMeta)
    const tasksUpcoming = openDated
      .filter((t) => t.dueDate >= today)
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))
      .slice(0, 12)
      .map(withTaskMeta)

    // --- Festival deadlines (picked festivals with an upcoming apply deadline / date) ---
    const fp = ids.length
      ? await db
          .select({
            gameId: festivalPicks.gameId,
            status: festivalPicks.status,
            id: industryEvents.id,
            name: industryEvents.name,
            startDate: industryEvents.startDate,
            applyDeadline: industryEvents.applyDeadline,
          })
          .from(festivalPicks)
          .innerJoin(industryEvents, eq(industryEvents.id, festivalPicks.industryEventId))
      : []
    const festivals = fp
      .filter((f) => gameMap.has(f.gameId))
      .map((f) => {
        const m = meta(f.gameId)
        return {
          gameId: f.gameId,
          gameName: m.name,
          color: m.color,
          id: f.id,
          name: f.name,
          status: f.status,
          startDate: f.startDate,
          applyDeadline: f.applyDeadline,
          deadlineDays: f.applyDeadline ? daysUntil(f.applyDeadline, today) : null,
          festDays: daysUntil(f.startDate, today),
        }
      })
      // keep only festivals that are still ahead (deadline OR the event itself)
      .filter((f) => f.festDays >= 0 || (f.deadlineDays != null && f.deadlineDays >= 0))
      .sort((a, b) => (a.deadlineDays ?? 99999) - (b.deadlineDays ?? 99999))

    // --- AI review queue (runs with pending proposal changes) ---
    const runs = ids.length
      ? await db
          .select()
          .from(aiRuns)
          .where(and(inArray(aiRuns.gameId, ids), eq(aiRuns.archived, false)))
      : []
    let aiReview: {
      gameId: string
      gameName: string
      color: string
      runId: string
      prompt: string
      pendingChanges: number
    }[] = []
    if (runs.length) {
      const changes = await db
        .select({ runId: aiProposalChanges.runId, status: aiProposalChanges.status })
        .from(aiProposalChanges)
        .where(
          inArray(
            aiProposalChanges.runId,
            runs.map((r) => r.id),
          ),
        )
      const pending = new Map<string, number>()
      for (const c of changes) if (c.status === 'pending') pending.set(c.runId, (pending.get(c.runId) ?? 0) + 1)
      aiReview = runs
        .filter((r) => (pending.get(r.id) ?? 0) > 0)
        .map((r) => {
          const m = meta(r.gameId)
          return {
            gameId: r.gameId ?? '',
            gameName: m.name,
            color: m.color,
            runId: r.id,
            prompt: r.prompt,
            pendingChanges: pending.get(r.id) ?? 0,
          }
        })
    }

    // --- Failed syncs ---
    const srcs = ids.length ? await db.select().from(sources).where(inArray(sources.gameId, ids)) : []
    const syncs = srcs
      .filter((s) => s.lastStatus === 'error')
      .map((s) => {
        const m = meta(s.gameId)
        return {
          gameId: s.gameId,
          gameName: m.name,
          color: m.color,
          platform: s.platform,
          handle: s.handle,
          lastSyncedAt: s.lastSyncedAt,
        }
      })

    // --- Unhandled public feedback ---
    const feedbackRows = ids.length
      ? await db.select().from(inboxComments).where(inArray(inboxComments.gameId, ids))
      : []
    const comments = gs
      .map((game) => ({
        gameId: game.id,
        count: feedbackRows.filter(
          (comment) => comment.gameId === game.id && (comment.status === 'unread' || comment.status === 'open'),
        ).length,
      }))
      .filter((item) => item.count > 0)

    // --- Spend vs budget (global, per paid provider) ---
    const spendRows = await db.select().from(apiSpend).where(eq(apiSpend.date, today))
    const budgets = await db.select().from(providerSettings)
    const spend = (['twitterapi', 'scrapecreators'] as const).map((p) => {
      const todayCostUsd = spendRows.find((s) => s.provider === p)?.costUsd ?? 0
      const dailyBudgetUsd = budgets.find((b) => b.provider === p)?.dailyBudgetUsd ?? null
      return {
        provider: p,
        todayCostUsd,
        dailyBudgetUsd,
        over: dailyBudgetUsd != null && todayCostUsd >= dailyBudgetUsd,
      }
    })

    // --- Wishlists: latest balance + most-recent movement per game ---
    const wl = ids.length
      ? await db
          .select({
            gameId: wishlistPoints.gameId,
            date: wishlistPoints.date,
            adds: wishlistPoints.adds,
            balance: wishlistPoints.balance,
          })
          .from(wishlistPoints)
          .where(inArray(wishlistPoints.gameId, ids))
          .orderBy(asc(wishlistPoints.date))
      : []
    const wlByGame = new Map<string, { date: string; adds: number | null; balance: number | null }[]>()
    for (const p of wl) wlByGame.set(p.gameId, [...(wlByGame.get(p.gameId) ?? []), p])
    const wishlists = gs.map((g) => {
      const pts = wlByGame.get(g.id) ?? []
      const last = pts[pts.length - 1]
      const prev = pts[pts.length - 2]
      const balance = resolveWishlistBalance(pts)
      const change =
        last && (last.adds ?? 0) > 0
          ? last.adds!
          : last?.balance != null && prev?.balance != null
            ? last.balance - prev.balance
            : 0
      return { gameId: g.id, gameName: g.name, color: g.color, balance, change, lastDate: last?.date ?? null }
    })

    // --- Outreach queue: only pinned prospects are an intentional next step. ---
    const creatorRows = ids.length
      ? await db
          .select({ gameId: creatorPicks.gameId, status: creatorPicks.pipelineStatus, pinned: creatorPicks.pinned })
          .from(creatorPicks)
          .where(inArray(creatorPicks.gameId, ids))
      : []
    const creatorProspects = gs.map((g) => ({
      gameId: g.id,
      count: creatorRows.filter((row) => row.gameId === g.id && row.status === 'prospect' && row.pinned).length,
    }))

    return {
      games: gs.map((g) => ({ id: g.id, name: g.name, color: g.color })),
      deadlines,
      festivals,
      tasksOverdue,
      tasksUpcoming,
      aiReview,
      syncs,
      comments,
      spend,
      wishlists,
      creatorProspects,
    }
  }),
})
