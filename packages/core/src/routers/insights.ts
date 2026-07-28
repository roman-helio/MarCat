import { and, desc, eq, like } from 'drizzle-orm'
import { insights } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import {
  getProjectCardInsight,
  isProjectCardTitle,
  PROJECT_CARD_INSIGHT_TITLE,
  projectCardGameId,
  updateProjectCardInsight,
} from '../projectCardInsight'

const title = z.string().trim().min(1).max(240)
const body = z.string().trim().min(1).max(200_000)
const createdBy = z.enum(['manual', 'mcp', 'ai'])

const catalogInput = z.object({
  gameId: z.string().min(1),
  search: z.string().trim().max(240).optional(),
})

/**
 * Insights expose a compact title-only catalogue by default. Consumers fetch a
 * full note explicitly by id, which keeps project briefs and MCP prompts small.
 */
export const insightsRouter = router({
  catalog: publicProcedure.input(catalogInput).query(async ({ ctx, input }) => {
    const where = input.search
      ? and(eq(insights.gameId, input.gameId), like(insights.title, `%${input.search}%`))
      : eq(insights.gameId, input.gameId)
    const rows = await ctx.db
      .select({
        id: insights.id,
        title: insights.title,
        createdBy: insights.createdBy,
        createdAt: insights.createdAt,
        updatedAt: insights.updatedAt,
      })
      .from(insights)
      .where(where)
      .orderBy(desc(insights.updatedAt), desc(insights.createdAt))
    const projectCard = await getProjectCardInsight(ctx.db, input.gameId)
    const includeProjectCard =
      projectCard &&
      (!input.search || PROJECT_CARD_INSIGHT_TITLE.toLocaleLowerCase().includes(input.search.toLocaleLowerCase()))
    const projectCardCatalogEntry = projectCard
      ? {
          id: projectCard.id,
          title: projectCard.title,
          createdBy: projectCard.createdBy,
          createdAt: projectCard.createdAt,
          updatedAt: projectCard.updatedAt,
          kind: projectCard.kind,
          required: projectCard.required,
          filled: !!projectCard.body.trim(),
        }
      : null
    return [
      ...(includeProjectCard && projectCardCatalogEntry ? [projectCardCatalogEntry] : []),
      ...rows.map((row) => ({ ...row, kind: 'insight' as const, required: false as const, filled: true as const })),
    ]
  }),

  get: publicProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
    const gameId = projectCardGameId(input.id)
    if (gameId) return getProjectCardInsight(ctx.db, gameId)
    const row = (await ctx.db.select().from(insights).where(eq(insights.id, input.id)).limit(1))[0]
    return row ? { ...row, kind: 'insight' as const, required: false as const } : null
  }),

  create: publicProcedure
    .input(
      z.object({
        gameId: z.string().min(1),
        title,
        body,
        createdBy: createdBy.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (isProjectCardTitle(input.title)) {
        throw new Error(`«${PROJECT_CARD_INSIGHT_TITLE}» уже существует как обязательный инсайт.`)
      }
      const rows = await ctx.db
        .insert(insights)
        .values({
          gameId: input.gameId,
          title: input.title,
          body: input.body,
          createdBy: input.createdBy ?? 'manual',
        })
        .returning()
      return rows[0]!
    }),

  update: publicProcedure
    .input(
      z
        .object({
          id: z.string().min(1),
          title: title.optional(),
          body: body.optional(),
          updatedBy: createdBy.optional(),
        })
        .refine((value) => value.title !== undefined || value.body !== undefined, 'Nothing to update'),
    )
    .mutation(async ({ ctx, input }) => {
      const gameId = projectCardGameId(input.id)
      if (gameId) {
        if (input.title !== undefined && !isProjectCardTitle(input.title)) {
          throw new Error(`«${PROJECT_CARD_INSIGHT_TITLE}» — обязательный инсайт, его нельзя переименовать.`)
        }
        if (input.body === undefined) return getProjectCardInsight(ctx.db, gameId)
        return updateProjectCardInsight(ctx.db, gameId, input.body, input.updatedBy ?? 'manual')
      }
      const rows = await ctx.db
        .update(insights)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(insights.id, input.id))
        .returning()
      return rows[0] ?? null
    }),

  remove: publicProcedure.input(z.object({ id: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    if (projectCardGameId(input.id)) {
      throw new Error(`«${PROJECT_CARD_INSIGHT_TITLE}» — обязательный инсайт, его нельзя удалить.`)
    }
    await ctx.db.delete(insights).where(eq(insights.id, input.id))
    return { id: input.id }
  }),
})
