import { createHash } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  creatorPicks,
  events,
  festivalPicks,
  games,
  industryEvents,
  sources,
  taskDependencies,
  tasks,
  wishlistPoints,
  type DB,
} from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import type { CompanionAdviceAction, CompanionMood } from '../context'
import { knowledgeContext, localizedKnowledge, retrieveKnowledge, type KnowledgeLang } from '../knowledge/marketing'
import { resolveWishlistBalance } from '../wishlist'

const LEVEL_THRESHOLDS = [0, 100, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000]
const DAY_MS = 86_400_000

type Priority = 'low' | 'medium' | 'high'

export interface LocalAdvice {
  id: string
  title: string
  message: string
  why: string
  mood: CompanionMood
  priority: Priority
  action: CompanionAdviceAction
  knowledgeIds: string[]
  shouldAskClaude: boolean
}

const tr = (lang: KnowledgeLang, ru: string, en: string) => (lang === 'ru' ? ru : en)
const today = () => new Date().toISOString().slice(0, 10)
const daysFromToday = (iso: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / DAY_MS)
const taskPath = (gameId: string, taskId: string) => `/g/${gameId}/tasks?task=${encodeURIComponent(taskId)}`

function levelProgress(balance: number | null) {
  const value = Math.max(0, balance ?? 0)
  let level = 1
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) if (value >= LEVEL_THRESHOLDS[i]!) level = i + 1
  const floor = LEVEL_THRESHOLDS[level - 1]!
  const next = level < LEVEL_THRESHOLDS.length ? LEVEL_THRESHOLDS[level]! : null
  const pct = next == null ? 100 : Math.min(100, Math.round(((value - floor) / Math.max(1, next - floor)) * 100))
  return { level, next, remaining: next == null ? 0 : Math.max(0, next - value), pct }
}

function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
}

async function buildSnapshot(db: DB, gameId: string, route: string, lang: KnowledgeLang) {
  const game = (await db.select().from(games).where(eq(games.id, gameId)).limit(1))[0]
  if (!game) throw new Error('Game not found')

  const [taskRows, points, activityRows, creatorRows, festivals, sourceRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.gameId, gameId)).orderBy(asc(tasks.sortOrder), asc(tasks.createdAt)),
    db.select().from(wishlistPoints).where(eq(wishlistPoints.gameId, gameId)).orderBy(asc(wishlistPoints.date)),
    db.select().from(events).where(eq(events.gameId, gameId)),
    db.select().from(creatorPicks).where(eq(creatorPicks.gameId, gameId)),
    db
      .select({
        id: industryEvents.id,
        name: industryEvents.name,
        startDate: industryEvents.startDate,
        applyDeadline: industryEvents.applyDeadline,
        status: festivalPicks.status,
      })
      .from(festivalPicks)
      .innerJoin(industryEvents, eq(industryEvents.id, festivalPicks.industryEventId))
      .where(eq(festivalPicks.gameId, gameId)),
    db
      .select({
        platform: sources.platform,
        handle: sources.handle,
        displayName: sources.displayName,
        enabled: sources.enabled,
      })
      .from(sources)
      .where(eq(sources.gameId, gameId)),
  ])
  const officialLinks = (() => {
    try {
      const value = JSON.parse(game.officialLinks ?? '[]')
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  })()

  const taskIds = taskRows.map((task) => task.id)
  const dependencies = taskIds.length
    ? await db
        .select()
        .from(taskDependencies)
        .where(and(inArray(taskDependencies.blockerTaskId, taskIds), inArray(taskDependencies.blockedTaskId, taskIds)))
    : []
  const taskById = new Map(taskRows.map((task) => [task.id, task]))
  const open = taskRows.filter((task) => task.status !== 'done' && task.status !== 'cancelled')
  const overdue = open
    .filter((task) => task.dueDate && task.dueDate < today())
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
  const blocked = open.filter((task) => task.status === 'blocked')
  const doing = open.filter((task) => task.status === 'doing')
  const upcoming = open
    .filter((task) => task.dueDate && task.dueDate >= today())
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))

  const last = points.at(-1)
  const previous = points.at(-2)
  const balance = resolveWishlistBalance(points)
  const wishlistChange =
    last && (last.adds ?? 0) > 0
      ? last.adds!
      : last?.balance != null && previous?.balance != null
        ? last.balance - previous.balance
        : 0

  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS).toISOString()
  const completedRecently = taskRows.filter((task) => task.completedAt && task.completedAt >= sevenDaysAgo).length
  const activitiesRecently = activityRows.filter((activity) => activity.createdAt >= sevenDaysAgo).length
  const outreachProgress = creatorRows.filter((pick) => pick.pipelineStatus !== 'prospect').length
  const festivalProgress = festivals.filter((festival) => festival.status !== 'none').length
  const meaningfulActions = completedRecently + activitiesRecently + outreachProgress + festivalProgress
  const huntScore = Math.min(
    100,
    completedRecently * 18 +
      Math.min(activitiesRecently, 3) * 8 +
      (doing.length ? 12 : 0) +
      (wishlistChange > 0 ? 24 : 0) +
      Math.min(outreachProgress + festivalProgress, 2) * 8,
  )

  const defaultAction = (id: string, label: string, path: string): CompanionAdviceAction => ({ id, label, path })
  let advice: LocalAdvice

  // Real work risk wins over setup nudges: reduce chaos before asking for configuration.
  if (!overdue.length && !blocked.length && !game.steamStoreUrl) {
    advice = {
      id: 'setup-steam',
      title: tr(lang, 'Дай мне след', 'Give me a trail'),
      message: tr(
        lang,
        'Добавь ссылку на страницу Steam. Тогда я смогу связывать задачи, кампании и рост вишлистов с одной целью.',
        'Add the Steam store URL. Then I can tie tasks, campaigns and wishlist growth to one goal.',
      ),
      why: tr(
        lang,
        'Без страницы Steam советы остаются общими: непонятно, что именно должно превращать внимание во вишлисты.',
        'Without a Steam page, advice stays generic because there is no concrete destination for attention to convert.',
      ),
      mood: 'curious',
      priority: 'medium',
      action: defaultAction('edit-project', tr(lang, 'Открыть проект', 'Open project'), `/?edit=${gameId}`),
      knowledgeIds: ['product-first-steps', 'steam-page-quality'],
      shouldAskClaude: false,
    }
  } else if (!overdue.length && !blocked.length && !points.length) {
    advice = {
      id: 'connect-wishlist-data',
      title: tr(lang, 'Я пока не чувствую вишлисты', 'I cannot sense wishlists yet'),
      message: tr(
        lang,
        'Импортируй CSV Steam или добавь первую точку вручную. После этого я покажу путь до следующего уровня.',
        'Import a Steam CSV or add the first point manually. Then I can show the path to the next level.',
      ),
      why: tr(
        lang,
        'Задачи показывают усилия, а данные Steam — результат. Для честных подсказок коту нужны обе стороны.',
        'Tasks show effort while Steam data shows results. Honest advice needs both sides.',
      ),
      mood: 'hungry',
      priority: 'medium',
      action: defaultAction('open-analytics', tr(lang, 'Добавить данные', 'Add data'), `/g/${gameId}/analytics`),
      knowledgeIds: ['product-wishlist-data', 'wishlist-momentum'],
      shouldAskClaude: false,
    }
  } else if (!taskRows.length) {
    advice = {
      id: 'create-first-task',
      title: tr(lang, 'Нужна первая добыча', 'We need the first target'),
      message: tr(
        lang,
        'Создай одну ближайшую маркетинговую задачу. Не весь план — только следующий проверяемый шаг.',
        'Create one nearest marketing task. Not the whole plan—just the next testable step.',
      ),
      why: tr(
        lang,
        'Короткая очередь помогает начать работу и даёт коту конкретный объект для следующей подсказки.',
        'A short queue helps work begin and gives the cat a concrete object for the next suggestion.',
      ),
      mood: 'curious',
      priority: 'medium',
      action: defaultAction('open-tasks', tr(lang, 'Создать задачу', 'Create task'), `/g/${gameId}/tasks`),
      knowledgeIds: ['product-task-focus', 'launch-sequence'],
      shouldAskClaude: false,
    }
  } else if (overdue.length) {
    const task = overdue[0]!
    advice = {
      id: 'close-overdue',
      title: tr(lang, 'Сначала расчистим хвост', 'Clear the loose end first'),
      message: tr(
        lang,
        `Просрочена задача «${task.title}». Реши её, перенеси срок или честно закрой.`,
        `“${task.title}” is overdue. Do it, reschedule it, or close it honestly.`,
      ),
      why: tr(
        lang,
        'Просроченная работа искажает приоритеты и мешает понять, что действительно блокирует кампанию.',
        'Overdue work distorts priorities and hides what truly blocks the campaign.',
      ),
      mood: 'worried',
      priority: 'high',
      action: defaultAction(
        'open-overdue-task',
        tr(lang, 'Разобрать задачу', 'Review task'),
        taskPath(gameId, task.id),
      ),
      knowledgeIds: ['product-task-focus'],
      shouldAskClaude: true,
    }
  } else if (blocked.length) {
    const blockedTask = blocked[0]!
    const edge = dependencies.find((dependency) => dependency.blockedTaskId === blockedTask.id)
    const blocker = edge ? taskById.get(edge.blockerTaskId) : undefined
    const target = blocker ?? blockedTask
    advice = {
      id: 'unblock-work',
      title: tr(lang, 'Нашёл узкое место', 'I found the bottleneck'),
      message: blocker
        ? tr(
            lang,
            `«${blockedTask.title}» ждёт задачу «${blocker.title}». Сейчас полезнее открыть блокер.`,
            `“${blockedTask.title}” is waiting for “${blocker.title}”. Opening the blocker is more useful now.`,
          )
        : tr(
            lang,
            `У задачи «${blockedTask.title}» нет понятного следующего шага.`,
            `“${blockedTask.title}” has no clear next step.`,
          ),
      why: tr(
        lang,
        'Кот предлагает действие по реальной зависимости, а не выстраивает несвязанные карточки в фиктивную цепочку.',
        'The cat follows a real dependency instead of arranging unrelated cards into a fake chain.',
      ),
      mood: 'hunting',
      priority: 'high',
      action: defaultAction('open-blocker', tr(lang, 'Открыть блокер', 'Open blocker'), taskPath(gameId, target.id)),
      knowledgeIds: ['product-task-focus'],
      shouldAskClaude: true,
    }
  } else {
    const nearFestival = festivals
      .map((festival) => ({ ...festival, days: daysFromToday(festival.applyDeadline ?? festival.startDate) }))
      .filter((festival) => festival.days >= 0 && festival.days <= 30 && festival.status !== 'submitted')
      .sort((a, b) => a.days - b.days)[0]
    if (nearFestival) {
      advice = {
        id: 'festival-readiness',
        title: tr(lang, 'Проверим готовность к фестивалю', 'Check festival readiness'),
        message: tr(
          lang,
          `${nearFestival.name} уже через ${nearFestival.days} дн. Проверь демо, страницу Steam и план коммуникации.`,
          `${nearFestival.name} is ${nearFestival.days}d away. Check the demo, Steam page and communication plan.`,
        ),
        why: tr(
          lang,
          'Фестиваль усиливает подготовленную страницу и демо, но редко компенсирует их неготовность.',
          'A festival amplifies a prepared page and demo, but rarely compensates for unfinished foundations.',
        ),
        mood: 'hunting',
        priority: 'high',
        action: defaultAction(
          'open-festival',
          tr(lang, 'Проверить фестиваль', 'Check festival'),
          `/g/${gameId}/festivals?festival=${encodeURIComponent(nearFestival.id)}`,
        ),
        knowledgeIds: ['next-fest-readiness', 'steam-page-quality'],
        shouldAskClaude: true,
      }
    } else if (doing.length) {
      const task = doing[0]!
      advice = {
        id: 'finish-doing',
        title: tr(lang, 'Доведём охоту до результата', 'Finish this hunt'),
        message: tr(
          lang,
          `В работе «${task.title}». Лучший следующий шаг — закрыть её до начала новой.`,
          `“${task.title}” is in progress. Finish it before starting another task.`,
        ),
        why: tr(
          lang,
          'Одна завершённая маркетинговая итерация даёт больше информации, чем несколько одновременно начатых.',
          'One completed marketing iteration yields more information than several half-started ones.',
        ),
        mood: 'hunting',
        priority: 'medium',
        action: defaultAction(
          'open-doing-task',
          tr(lang, 'Продолжить задачу', 'Continue task'),
          taskPath(gameId, task.id),
        ),
        knowledgeIds: ['product-task-focus'],
        shouldAskClaude: true,
      }
    } else if (!open.length) {
      advice = {
        id: 'plan-next-cycle',
        title: tr(lang, 'Миска пуста, но хвостов нет', 'The bowl is empty, and the queue is clear'),
        message: tr(
          lang,
          'Все текущие задачи закрыты. Выбери один следующий маркетинговый эксперимент вместо большой новой очереди.',
          'All current tasks are closed. Choose one next marketing experiment instead of building a large new queue.',
        ),
        why: tr(
          lang,
          'Новый цикл лучше начинать с гипотезы: какой рычаг проверяем — трафик, конверсию страницы или готовность к событию.',
          'A new cycle should start with a hypothesis: traffic, store conversion, or event readiness.',
        ),
        mood: 'content',
        priority: 'low',
        action: defaultAction('open-tasks', tr(lang, 'Начать новый цикл', 'Start a new cycle'), `/g/${gameId}/tasks`),
        knowledgeIds: ['launch-sequence', 'wishlist-momentum'],
        shouldAskClaude: true,
      }
    } else if (wishlistChange > 0) {
      advice = {
        id: 'inspect-growth',
        title: tr(lang, `Ням: +${wishlistChange} вишлистов`, `Nom: +${wishlistChange} wishlists`),
        message: tr(
          lang,
          'Рост подтверждён. Посмотри, какие активности были рядом с ним, и реши, стоит ли повторять эксперимент.',
          'Growth is confirmed. Review nearby activities and decide whether the experiment is worth repeating.',
        ),
        why: tr(
          lang,
          'Совпадение по времени не доказывает причинность, но помогает сформулировать следующую проверяемую гипотезу.',
          'Timing does not prove causality, but it helps form the next testable hypothesis.',
        ),
        mood: 'proud',
        priority: 'low',
        action: defaultAction('open-growth', tr(lang, 'Посмотреть динамику', 'View trend'), `/g/${gameId}/analytics`),
        knowledgeIds: ['wishlist-momentum', 'product-wishlist-data'],
        shouldAskClaude: false,
      }
    } else {
      const task = upcoming[0] ?? open[0]!
      advice = {
        id: 'next-task',
        title: tr(lang, 'Вот следующая цель', 'Here is the next target'),
        message: tr(
          lang,
          `Начни с «${task.title}». Остальная очередь подождёт.`,
          `Start with “${task.title}”. The rest of the queue can wait.`,
        ),
        why: tr(
          lang,
          'Выбрана ближайшая открытая задача; кот не создаёт новую работу, пока в плане уже есть следующий шаг.',
          'This is the nearest open task; the cat avoids creating new work while a next step already exists.',
        ),
        mood: 'hungry',
        priority: 'medium',
        action: defaultAction('open-next-task', tr(lang, 'Открыть задачу', 'Open task'), taskPath(gameId, task.id)),
        knowledgeIds: ['product-task-focus'],
        shouldAskClaude: true,
      }
    }
  }

  const routeHelpId = route.includes('/tasks')
    ? 'product-task-focus'
    : route.includes('/analytics') || route.includes('/events')
      ? 'product-wishlist-data'
      : route.includes('/creators')
        ? 'influencer-fit'
        : route.includes('/festivals')
          ? 'next-fest-readiness'
          : 'product-first-steps'
  const knowledge = retrieveKnowledge({ preferredIds: [...advice.knowledgeIds, routeHelpId], route, limit: 4 }).map(
    (card) => localizedKnowledge(card, lang),
  )
  const help = knowledge.find((card) => card.id === routeHelpId) ?? knowledge[0]!
  const level = levelProgress(balance)
  const fingerprint = fingerprintOf({
    route: route.replace(/[?].*$/, ''),
    balance,
    lastPoint: last?.date ?? null,
    wishlistChange,
    tasks: taskRows.map((task) => [task.id, task.status, task.dueDate, task.updatedAt]),
    festivals: festivals.map((festival) => [festival.id, festival.status, festival.applyDeadline]),
    advice: advice.id,
  })

  return {
    game: {
      id: game.id,
      name: game.name,
      steamStoreUrl: game.steamStoreUrl,
      releaseDate: game.releaseDate,
      officialLinks,
      sources: sourceRows,
    },
    fingerprint,
    wishlist: { balance, change: wishlistChange, lastDate: last?.date ?? null },
    growth: level,
    hunt: { score: huntScore, meaningfulActions },
    advice,
    knowledge,
    help,
    signalSummary: {
      openTasks: open.length,
      overdueTasks: overdue.length,
      blockedTasks: blocked.length,
      doingTasks: doing.length,
      completedRecently,
      activitiesRecently,
      nearbyFestival: festivals.some((festival) => {
        const days = daysFromToday(festival.applyDeadline ?? festival.startDate)
        return days >= 0 && days <= 30
      }),
      route,
    },
  }
}

export const companionRouter = router({
  snapshot: publicProcedure
    .input(z.object({ gameId: z.string(), route: z.string().max(240).optional(), lang: z.enum(['ru', 'en']) }))
    .query(({ ctx, input }) => buildSnapshot(ctx.db, input.gameId, input.route ?? '', input.lang)),

  knowledge: publicProcedure
    .input(
      z.object({
        query: z.string().max(500).optional(),
        route: z.string().max(240).optional(),
        lang: z.enum(['ru', 'en']),
        limit: z.number().int().min(1).max(6).optional(),
      }),
    )
    .query(({ input }) =>
      retrieveKnowledge({ query: input.query, route: input.route, limit: input.limit }).map((card) =>
        localizedKnowledge(card, input.lang),
      ),
    ),

  advise: publicProcedure
    .input(z.object({ gameId: z.string(), route: z.string().max(240).optional(), lang: z.enum(['ru', 'en']) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.agent?.advise) throw new Error('The compact Claude advisor is not available.')
      const snapshot = await buildSnapshot(ctx.db, input.gameId, input.route ?? '', input.lang)
      const cards = retrieveKnowledge({
        query: `${snapshot.advice.title} ${snapshot.advice.message}`,
        route: input.route,
        preferredIds: snapshot.advice.knowledgeIds,
        limit: 4,
      })
      const actions: CompanionAdviceAction[] = [
        snapshot.advice.action,
        { id: 'open-tasks', label: tr(input.lang, 'Открыть задачи', 'Open tasks'), path: `/g/${input.gameId}/tasks` },
        {
          id: 'open-analytics',
          label: tr(input.lang, 'Открыть аналитику', 'Open analytics'),
          path: `/g/${input.gameId}/analytics`,
        },
      ].filter((action, index, list) => list.findIndex((candidate) => candidate.id === action.id) === index)
      const result = await ctx.agent.advise({
        gameId: input.gameId,
        language: input.lang,
        model: 'claude-sonnet-5',
        context: JSON.stringify(
          {
            project: snapshot.game,
            wishlist: snapshot.wishlist,
            hunt: snapshot.hunt,
            signals: snapshot.signalSummary,
            localRecommendation: snapshot.advice,
          },
          null,
          2,
        ),
        knowledge: knowledgeContext(cards, input.lang),
        actions,
      })
      const action = actions.find((candidate) => candidate.id === result.actionId) ?? snapshot.advice.action
      const allowedRefs = new Set(cards.map((card) => card.id))
      const knowledgeRefs = result.knowledgeRefs.filter((id) => allowedRefs.has(id)).slice(0, 3)
      return {
        fingerprint: snapshot.fingerprint,
        advice: {
          title: result.title.slice(0, 90),
          message: result.message.slice(0, 360),
          why: result.why.slice(0, 420),
          mood: result.mood,
          confidence: Math.max(0, Math.min(1, result.confidence)),
          action,
          knowledgeRefs: knowledgeRefs.length ? knowledgeRefs : snapshot.advice.knowledgeIds.slice(0, 2),
          model: result.model ?? 'claude-sonnet-5',
        },
        knowledge: cards.map((card) => localizedKnowledge(card, input.lang)),
      }
    }),
})
