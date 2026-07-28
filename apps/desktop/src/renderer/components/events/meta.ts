import {
  ACTIVITY_PLATFORMS,
  ACTIVITY_TYPES,
  type ActivityPlatform,
  type ActivityType,
} from '@marcat/core/activity-semantics'

export const EVENT_TYPES = ACTIVITY_TYPES
export type EventType = ActivityType

export const PLATFORMS = ACTIVITY_PLATFORMS
export type Platform = ActivityPlatform

/** Display name (proper nouns stay the same in both languages) + marker color. */
export const PLATFORM_META: Record<Platform, { label: string; color: string }> = {
  youtube: { label: 'YouTube', color: '#FF3B30' },
  twitter: { label: 'X / Twitter', color: '#1DA1F2' },
  tiktok: { label: 'TikTok', color: '#25C0C7' },
  instagram: { label: 'Instagram', color: '#E1306C' },
  reddit: { label: 'Reddit', color: '#FF4500' },
  telegram: { label: 'Telegram', color: '#229ED9' },
  steam: { label: 'Steam', color: '#5A8FBB' },
  press: { label: 'Press', color: '#8A62D3' },
  other: { label: '', color: '#9A9AA2' },
}

export function platformColor(platform?: string | null): string {
  return (platform && PLATFORM_META[platform as Platform]?.color) || PLATFORM_META.other.color
}
