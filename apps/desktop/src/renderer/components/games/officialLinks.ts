import { OFFICIAL_LINK_TYPES, type OfficialLink, type OfficialLinkType } from '@marcat/core/game-semantics'

export type { OfficialLink, OfficialLinkType }

const placeholders: Partial<Record<OfficialLinkType, string>> = {
  website: 'https://yourgame.com',
  discord: 'https://discord.gg/…',
  youtube: 'https://youtube.com/@…',
  twitter: 'https://x.com/…',
  bluesky: 'https://bsky.app/profile/…',
  instagram: 'https://instagram.com/…',
  tiktok: 'https://tiktok.com/@…',
  reddit: 'https://reddit.com/r/…',
  telegram: 'https://t.me/…',
  facebook: 'https://facebook.com/…',
  itch: 'https://….itch.io/…',
  presskit: 'https://yourgame.com/presskit',
  metacritic: 'https://www.metacritic.com/game/…',
  opencritic: 'https://opencritic.com/game/…',
}

export const OFFICIAL_LINK_OPTIONS = OFFICIAL_LINK_TYPES.map((type) => ({
  type,
  labelKey: `link.${type}`,
  placeholder: placeholders[type] ?? 'https://…',
}))
