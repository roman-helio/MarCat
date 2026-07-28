export { appRouter, type AppRouter } from './routers'
export { router, publicProcedure, middleware } from './trpc'
export type {
  Context,
  CreateContext,
  AgentRunner,
  AgentRunInput,
  AgentRunResult,
  AgentAdviceInput,
  AgentAdviceResult,
  AgentProviderStatus,
  AgentRuntimeStatus,
  AiAuthMode,
  AiProvider,
  CompanionAdviceAction,
  CompanionMood,
  ProposedChange,
  SecretsStore,
} from './context'
export { slugify, stripUndefined } from './util/slug'
export { taskDescriptionToMarkdown } from './util/richText'
export { resolveWishlistBalance, type WishlistBalancePoint } from './wishlist'
export { getSteamWishlistRank, parseSteamWishlistRows, type SteamWishlistRank } from './steamWishlistRank'
export { parseCriticScoreHtml, summarizeSteamSalesRows, syncSteamFinancials } from './storefrontMetrics'
export { computeImpact, type Classification, type EventImpact } from './analytics'
export { backfillTaskDescriptionMarkdown } from './routers/tasks'
export {
  ACTIVITY_CHANNELS,
  ACTIVITY_CREATED_BY,
  ACTIVITY_DIRECTIONS,
  ACTIVITY_PLATFORMS,
  ACTIVITY_SUBJECTS,
  ACTIVITY_TYPES,
  type ActivityChannel,
  type ActivityPlatform,
  type ActivityType,
} from './activitySemantics'
export { OFFICIAL_LINK_TYPES, type OfficialLink, type OfficialLinkType } from './gameSemantics'
export * from './workspace'
export { processGmassQueue, GMASS_ADDRESS_CATEGORIES, type GmassAddressCategory } from './gmass'
export {
  processYouTubeDiscoveryQueue,
  expireYoutubeDiscoveryCache,
  YOUTUBE_DATA_DAILY_LIMIT,
  YOUTUBE_SEARCH_DAILY_LIMIT,
  type DiscoveryMode,
  type DiscoveryProfileSnapshot,
  type DiscoveryReferenceSnapshot,
  type DiscoveryRunStatus,
} from './youtubeDiscovery'
export {
  REVIEW_PLATFORMS,
  isReviewPlatform,
  parseReviewPageHtml,
  type ReviewPlatform,
  type RemoteInboxComment,
} from './reviewConnectors'
export {
  RECURRENCE_UNITS,
  addRecurrence,
  nextRecurringSchedule,
  type RecurrenceUnit,
  type TaskRecurrence,
} from './taskRecurrence'
