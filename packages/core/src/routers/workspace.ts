import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import type { MarkdownWorkspaceCoordinator } from '../workspace/coordinator'

const game = z.object({ gameId: z.string().min(1) })
const entityType = z.enum(['project', 'insight', 'task', 'tag', 'activity'])

const coordinator = (workspace: MarkdownWorkspaceCoordinator | undefined): MarkdownWorkspaceCoordinator => {
  if (!workspace) throw new Error('Markdown workspaces are unavailable in this runtime')
  return workspace
}

export const workspaceRouter = router({
  configs: publicProcedure.query(({ ctx }) => coordinator(ctx.workspace).listConfigs()),
  status: publicProcedure.input(game).query(({ ctx, input }) => coordinator(ctx.workspace).status(input.gameId)),
  configure: publicProcedure
    .input(
      game.extend({
        rootPath: z.string().min(1),
        workspaceFolder: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const workspace = coordinator(ctx.workspace)
      const config = await workspace.configure({ ...input, enabled: true })
      const result = await workspace.enable(input.gameId)
      return { config, result }
    }),
  disable: publicProcedure.input(game).mutation(async ({ ctx, input }) => {
    await coordinator(ctx.workspace).disable(input.gameId)
    return { ok: true as const }
  }),
  reconcile: publicProcedure
    .input(game)
    .mutation(({ ctx, input }) => coordinator(ctx.workspace).reconcile(input.gameId)),
  exportAll: publicProcedure
    .input(game)
    .mutation(({ ctx, input }) => coordinator(ctx.workspace).exportAll(input.gameId)),
  issues: publicProcedure
    .input(game.extend({ includeResolved: z.boolean().optional() }))
    .query(({ ctx, input }) => coordinator(ctx.workspace).listIssues(input.gameId, input.includeResolved)),
  resolveIssue: publicProcedure.input(z.object({ id: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    await coordinator(ctx.workspace).resolveIssue(input.id)
    return { ok: true as const }
  }),
  decideMissing: publicProcedure
    .input(
      game.extend({
        entityType,
        entityId: z.string().min(1),
        decision: z.enum(['restore', 'quarantine']),
      }),
    )
    .mutation(({ ctx, input }) =>
      coordinator(ctx.workspace).decideMissing(input.gameId, input.entityType, input.entityId, input.decision),
    ),
  paths: publicProcedure.input(game).query(({ ctx, input }) => coordinator(ctx.workspace).paths(input.gameId)),
})
