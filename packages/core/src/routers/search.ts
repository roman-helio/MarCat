import { creators, events, games, industryEvents, insights, projectCards, sources, tasks } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { PROJECT_CARD_INSIGHT_TITLE, projectCardInsightId } from '../projectCardInsight'

const searchScope = z.enum(['all', 'games', 'tasks', 'creators', 'festivals', 'insights', 'activities', 'sources'])

type SearchKind = Exclude<z.infer<typeof searchScope>, 'all' | 'games'> | 'game'

interface SearchCandidate {
  id: string
  kind: SearchKind
  title: string
  subtitle?: string
  excerpt?: string
  gameId?: string
  gameName?: string
  score: number
}

const normalize = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()

function matchScore(query: string, title: string, fields: Array<string | null | undefined>): number | null {
  const normalizedTitle = normalize(title)
  const normalizedFields = fields.map((value) => normalize(value ?? '')).filter(Boolean)
  const haystack = [normalizedTitle, ...normalizedFields].join(' ')
  const terms = query.split(' ').filter(Boolean)
  if (!terms.every((term) => haystack.includes(term))) return null
  if (normalizedTitle === query) return 0
  if (normalizedTitle.startsWith(query)) return 10
  if (normalizedTitle.includes(query)) return 20 + normalizedTitle.indexOf(query)
  if (terms.every((term) => normalizedTitle.includes(term))) return 40
  const firstMatch = Math.min(...terms.map((term) => haystack.indexOf(term)).filter((index) => index >= 0))
  return 60 + Math.min(firstMatch, 30)
}

function matchExcerpt(query: string, fields: Array<string | null | undefined>): string | undefined {
  const term = query.split(' ').find(Boolean)
  if (!term) return undefined
  const field = fields.find((value) => normalize(value ?? '').includes(term))?.trim()
  if (!field) return undefined
  const normalizedField = normalize(field)
  const matchAt = normalizedField.indexOf(term)
  const start = Math.max(0, matchAt - 42)
  const end = Math.min(field.length, start + 110)
  return `${start > 0 ? '…' : ''}${field.slice(start, end)}${end < field.length ? '…' : ''}`
}

/** Fast, local, cross-entity search for the desktop quick-search surface. */
export const searchRouter = router({
  run: publicProcedure
    .input(
      z.object({
        query: z.string().trim().min(1).max(120),
        scope: searchScope.default('all'),
        gameId: z.string().optional(),
        limit: z.number().int().min(1).max(80).default(40),
      }),
    )
    .query(async ({ ctx, input }) => {
      const query = normalize(input.query)
      const includes = (scope: Exclude<z.infer<typeof searchScope>, 'all'>) =>
        input.scope === 'all' || input.scope === scope

      const [gameRows, taskRows, creatorRows, festivalRows, insightRows, projectCardRows, activityRows, sourceRows] =
        await Promise.all([
          ctx.db.select({ id: games.id, name: games.name, key: games.key }).from(games),
          includes('tasks')
            ? ctx.db
                .select({
                  id: tasks.id,
                  gameId: tasks.gameId,
                  seq: tasks.seq,
                  title: tasks.title,
                  description: tasks.description,
                  status: tasks.status,
                  dueDate: tasks.dueDate,
                })
                .from(tasks)
            : Promise.resolve([]),
          includes('creators')
            ? ctx.db
                .select({
                  id: creators.id,
                  name: creators.name,
                  handle: creators.handle,
                  kind: creators.kind,
                  primaryPlatform: creators.primaryPlatform,
                  language: creators.language,
                  region: creators.region,
                  topicsJson: creators.topicsJson,
                  playedGamesJson: creators.playedGamesJson,
                  contactsJson: creators.contactsJson,
                  notes: creators.notes,
                  description: creators.description,
                })
                .from(creators)
            : Promise.resolve([]),
          includes('festivals')
            ? ctx.db
                .select({
                  id: industryEvents.id,
                  name: industryEvents.name,
                  type: industryEvents.type,
                  startDate: industryEvents.startDate,
                  applyDeadline: industryEvents.applyDeadline,
                  organizer: industryEvents.organizer,
                  description: industryEvents.description,
                  notes: industryEvents.notes,
                })
                .from(industryEvents)
            : Promise.resolve([]),
          includes('insights')
            ? ctx.db
                .select({
                  id: insights.id,
                  gameId: insights.gameId,
                  title: insights.title,
                  body: insights.body,
                })
                .from(insights)
            : Promise.resolve([]),
          includes('insights')
            ? ctx.db
                .select({
                  gameId: projectCards.gameId,
                  description: projectCards.description,
                  oneLiner: projectCards.oneLiner,
                  audience: projectCards.audience,
                  positioning: projectCards.positioning,
                })
                .from(projectCards)
            : Promise.resolve([]),
          includes('activities')
            ? ctx.db
                .select({
                  id: events.id,
                  gameId: events.gameId,
                  title: events.title,
                  description: events.description,
                  occurredAt: events.occurredAt,
                  type: events.type,
                  platform: events.platform,
                  placement: events.placement,
                  subjectLabel: events.subjectLabel,
                })
                .from(events)
            : Promise.resolve([]),
          includes('sources')
            ? ctx.db
                .select({
                  id: sources.id,
                  gameId: sources.gameId,
                  platform: sources.platform,
                  handle: sources.handle,
                  displayName: sources.displayName,
                  lastStatus: sources.lastStatus,
                })
                .from(sources)
            : Promise.resolve([]),
        ])

      const gameById = new Map(gameRows.map((game) => [game.id, game]))
      const candidates: SearchCandidate[] = []
      const add = (
        candidate: Omit<SearchCandidate, 'score' | 'excerpt'>,
        fields: Array<string | null | undefined>,
        excerptFields: Array<string | null | undefined> = fields,
      ) => {
        const score = matchScore(query, candidate.title, fields)
        if (score == null) return
        candidates.push({ ...candidate, score, excerpt: matchExcerpt(query, excerptFields) })
      }
      const inCurrentGame = (gameId: string) => input.scope === 'all' || !input.gameId || gameId === input.gameId

      if (includes('games')) {
        for (const game of gameRows) {
          add(
            {
              id: game.id,
              kind: 'game',
              title: game.name,
              subtitle: game.key ?? undefined,
              gameId: game.id,
              gameName: game.name,
            },
            [game.key],
          )
        }
      }

      for (const task of taskRows) {
        if (!inCurrentGame(task.gameId)) continue
        const game = gameById.get(task.gameId)
        const taskKey = game?.key && task.seq != null ? `${game.key}-${task.seq}` : null
        add(
          {
            id: task.id,
            kind: 'tasks',
            title: task.title,
            subtitle: [taskKey, game?.name, task.dueDate].filter(Boolean).join(' · '),
            gameId: task.gameId,
            gameName: game?.name,
          },
          [taskKey, task.description, task.status, task.dueDate],
          [task.description],
        )
      }

      for (const creator of creatorRows) {
        add(
          {
            id: creator.id,
            kind: 'creators',
            title: creator.name,
            subtitle: [creator.handle, creator.primaryPlatform ?? creator.kind, creator.language]
              .filter(Boolean)
              .join(' · '),
          },
          [
            creator.handle,
            creator.kind,
            creator.primaryPlatform,
            creator.language,
            creator.region,
            creator.topicsJson,
            creator.playedGamesJson,
            creator.contactsJson,
            creator.notes,
            creator.description,
          ],
          [creator.description, creator.notes, creator.playedGamesJson, creator.topicsJson],
        )
      }

      for (const festival of festivalRows) {
        add(
          {
            id: festival.id,
            kind: 'festivals',
            title: festival.name,
            subtitle: [festival.organizer, festival.startDate, festival.applyDeadline].filter(Boolean).join(' · '),
          },
          [
            festival.type,
            festival.organizer,
            festival.description,
            festival.notes,
            festival.startDate,
            festival.applyDeadline,
          ],
          [festival.description, festival.notes],
        )
      }

      for (const insight of insightRows) {
        if (!inCurrentGame(insight.gameId)) continue
        const game = gameById.get(insight.gameId)
        add(
          {
            id: insight.id,
            kind: 'insights',
            title: insight.title,
            subtitle: game?.name,
            gameId: insight.gameId,
            gameName: game?.name,
          },
          [insight.body],
          [insight.body],
        )
      }

      const projectCardByGame = new Map(projectCardRows.map((card) => [card.gameId, card]))
      for (const game of gameRows) {
        if (!includes('insights') || !inCurrentGame(game.id)) continue
        const card = projectCardByGame.get(game.id)
        add(
          {
            id: projectCardInsightId(game.id),
            kind: 'insights',
            title: PROJECT_CARD_INSIGHT_TITLE,
            subtitle: game.name,
            gameId: game.id,
            gameName: game.name,
          },
          [card?.description, card?.oneLiner, card?.audience, card?.positioning],
          [card?.description, card?.oneLiner, card?.audience, card?.positioning],
        )
      }

      for (const activity of activityRows) {
        if (!inCurrentGame(activity.gameId)) continue
        const game = gameById.get(activity.gameId)
        add(
          {
            id: activity.id,
            kind: 'activities',
            title: activity.title,
            subtitle: [game?.name, activity.occurredAt, activity.platform].filter(Boolean).join(' · '),
            gameId: activity.gameId,
            gameName: game?.name,
          },
          [activity.description, activity.type, activity.platform, activity.placement, activity.subjectLabel],
          [activity.description],
        )
      }

      for (const source of sourceRows) {
        if (!inCurrentGame(source.gameId)) continue
        const game = gameById.get(source.gameId)
        add(
          {
            id: source.id,
            kind: 'sources',
            title: source.displayName || source.handle,
            subtitle: [game?.name, source.platform, source.handle].filter(Boolean).join(' · '),
            gameId: source.gameId,
            gameName: game?.name,
          },
          [source.handle, source.platform, source.lastStatus],
        )
      }

      const kindOrder: Record<SearchKind, number> = {
        tasks: 0,
        creators: 1,
        festivals: 2,
        insights: 3,
        activities: 4,
        sources: 5,
        game: 6,
      }
      return candidates
        .sort(
          (left, right) =>
            left.score - right.score ||
            kindOrder[left.kind] - kindOrder[right.kind] ||
            left.title.localeCompare(right.title),
        )
        .slice(0, input.limit)
        .map(({ score: _score, ...candidate }) => candidate)
    }),
})
