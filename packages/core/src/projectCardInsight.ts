import { eq } from 'drizzle-orm'
import { games, projectCards, type DB } from '@marcat/db'

export const PROJECT_CARD_INSIGHT_TITLE = 'Карточка проекта'
export const PROJECT_CARD_INSIGHT_PREFIX = 'project-card:'

export const projectCardInsightId = (gameId: string) => `${PROJECT_CARD_INSIGHT_PREFIX}${gameId}`

export const projectCardGameId = (id: string): string | null =>
  id.startsWith(PROJECT_CARD_INSIGHT_PREFIX) ? id.slice(PROJECT_CARD_INSIGHT_PREFIX.length) || null : null

export const isProjectCardTitle = (value: string): boolean =>
  value.trim().toLocaleLowerCase() === PROJECT_CARD_INSIGHT_TITLE.toLocaleLowerCase()

export async function getProjectCardInsight(db: DB, gameId: string) {
  const [game] = await db
    .select({ id: games.id, createdAt: games.createdAt })
    .from(games)
    .where(eq(games.id, gameId))
    .limit(1)
  if (!game) return null
  const [card] = await db.select().from(projectCards).where(eq(projectCards.gameId, gameId)).limit(1)
  const timestamp = card?.updatedAt ?? game.createdAt
  return {
    id: projectCardInsightId(gameId),
    gameId,
    title: PROJECT_CARD_INSIGHT_TITLE,
    body: card?.description ?? '',
    createdBy: card?.updatedBy ?? ('manual' as const),
    createdAt: timestamp,
    updatedAt: timestamp,
    kind: 'project_card' as const,
    required: true as const,
  }
}

export async function updateProjectCardInsight(
  db: DB,
  gameId: string,
  body: string,
  updatedBy: 'manual' | 'mcp' | 'ai',
) {
  const updatedAt = new Date().toISOString()
  await db
    .insert(projectCards)
    .values({ gameId, description: body, updatedBy, updatedAt })
    .onConflictDoUpdate({
      target: projectCards.gameId,
      set: { description: body, updatedBy, updatedAt },
    })
  return getProjectCardInsight(db, gameId)
}
