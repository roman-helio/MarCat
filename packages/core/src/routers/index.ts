import { router, publicProcedure } from '../trpc'
import { gamesRouter } from './games'
import { tasksRouter } from './tasks'
import { tagsRouter } from './tags'
import { eventsRouter } from './events'
import { wishlistsRouter } from './wishlists'
import { analyticsRouter } from './analytics'
import { utmRouter } from './utm'
import { aiRouter } from './ai'
import { sourcesRouter } from './sources'
import { systemRouter } from './system'
import { festivalsRouter } from './festivals'
import { creatorsRouter } from './creators'
import { dashboardRouter } from './dashboard'
import { projectCardsRouter } from './projectCards'
import { activitiesRouter } from './activities'
import { companionRouter } from './companion'
import { insightsRouter } from './insights'
import { storefrontRouter } from './storefront'
import { workspaceRouter } from './workspace'
import { gmassRouter } from './gmass'
import { commentsRouter } from './comments'
import { searchRouter } from './search'

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true as const, app: 'MarCat' })),
  games: gamesRouter,
  tasks: tasksRouter,
  tags: tagsRouter,
  events: eventsRouter,
  wishlists: wishlistsRouter,
  analytics: analyticsRouter,
  utm: utmRouter,
  ai: aiRouter,
  sources: sourcesRouter,
  system: systemRouter,
  festivals: festivalsRouter,
  creators: creatorsRouter,
  dashboard: dashboardRouter,
  projectCards: projectCardsRouter,
  activities: activitiesRouter,
  companion: companionRouter,
  insights: insightsRouter,
  storefront: storefrontRouter,
  workspace: workspaceRouter,
  gmass: gmassRouter,
  comments: commentsRouter,
  search: searchRouter,
})

export type AppRouter = typeof appRouter
