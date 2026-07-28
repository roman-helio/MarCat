/** Official owned/project presences. These are not import connectors or release targets. */
export const OFFICIAL_LINK_TYPES = [
  'website',
  'discord',
  'youtube',
  'twitter',
  'bluesky',
  'instagram',
  'tiktok',
  'reddit',
  'telegram',
  'facebook',
  'itch',
  'presskit',
  'metacritic',
  'opencritic',
  'other',
] as const

export type OfficialLinkType = (typeof OFFICIAL_LINK_TYPES)[number]

export interface OfficialLink {
  type: OfficialLinkType
  url: string
  label?: string
}
