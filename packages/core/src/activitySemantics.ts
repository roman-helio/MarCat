/** Shared activity vocabulary used by the database API, desktop UI and MCP. */
export const ACTIVITY_TYPES = ['post', 'video', 'stream', 'press', 'festival', 'update', 'other'] as const
export const ACTIVITY_PLATFORMS = [
  'youtube',
  'twitter',
  'tiktok',
  'instagram',
  'reddit',
  'telegram',
  'steam',
  'press',
  'other',
] as const
export const ACTIVITY_CHANNELS = ['email', 'dm', 'form', 'call', 'meeting', 'other'] as const
export const ACTIVITY_DIRECTIONS = ['outbound', 'inbound'] as const
export const ACTIVITY_SUBJECTS = ['project', 'task', 'festival', 'creator'] as const
export const ACTIVITY_CREATED_BY = ['manual', 'source', 'ai'] as const

export type ActivityType = (typeof ACTIVITY_TYPES)[number]
export type ActivityPlatform = (typeof ACTIVITY_PLATFORMS)[number]
export type ActivityChannel = (typeof ACTIVITY_CHANNELS)[number]
