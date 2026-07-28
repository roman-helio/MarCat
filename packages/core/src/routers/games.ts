import { desc, eq, ne } from 'drizzle-orm'
import { games, makeGameKey } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { slugify, stripUndefined } from '../util/slug'
import { OFFICIAL_LINK_TYPES } from '../gameSemantics'

const platform = z.object({ id: z.string(), url: z.string().optional() })
const officialLink = z.object({
  type: z.enum(OFFICIAL_LINK_TYPES),
  url: z.string().min(1),
  label: z.string().optional(),
})
const gameFields = z.object({
  name: z.string().min(1).max(120),
  // Only the name is required; everything else can be filled in later.
  releaseDate: z.string().nullish(),
  /** Each enabled platform can carry a URL (Steam page, web build, store, …). */
  platforms: z.array(platform).optional(),
  /** Official website/social/community/press-kit presences. Distinct from import sources. */
  officialLinks: z.array(officialLink).optional(),
  /** Legacy external API field. The UI now uses `key` as the single project prefix. */
  devhubProject: z.string().nullish(),
  /** Short project key used for task ids and DevHub lookup (SAS-12). Auto-derived if omitted. */
  key: z.string().max(10).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
})

const sanitizeKey = (raw: string): string =>
  raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10)

/** Make a key unique against the set of taken keys (append 2,3,… on collision). */
function uniqueKey(base: string, taken: Set<string>): string {
  let key = base || 'GAME'
  let n = 2
  while (taken.has(key)) key = `${base}${n++}`
  return key
}

type Platform = { id: string; url: string }
type OfficialLink = z.infer<typeof officialLink>

/** Steam app id is read straight out of the store URL (…/app/<id>/…). */
const appIdFromUrl = (url?: string | null): number | null => {
  const m = (url ?? '').match(/\/app\/(\d+)/)
  return m ? Number(m[1]) : null
}
/** Tolerant parse: handles legacy string[] platforms and the new {id,url}[] shape. */
const parsePlatforms = (s: string | null): Platform[] => {
  try {
    const a = JSON.parse(s ?? '[]')
    if (!Array.isArray(a)) return []
    return a
      .map(
        (x): Platform =>
          typeof x === 'string'
            ? { id: x, url: '' }
            : { id: String((x as { id?: unknown }).id ?? ''), url: String((x as { url?: unknown }).url ?? '') },
      )
      .filter((p) => p.id)
  } catch {
    return []
  }
}
const parseOfficialLinks = (s: string | null): OfficialLink[] => {
  try {
    const value = JSON.parse(s ?? '[]')
    if (!Array.isArray(value)) return []
    return value.flatMap((item): OfficialLink[] => {
      const type = String((item as { type?: unknown }).type ?? 'other') as OfficialLink['type']
      const url = String((item as { url?: unknown }).url ?? '')
      const label = String((item as { label?: unknown }).label ?? '')
      if (!OFFICIAL_LINK_TYPES.includes(type) || !url) return []
      return [{ type, url, ...(label ? { label } : {}) }]
    })
  } catch {
    return []
  }
}
const steamUrlOf = (platforms?: { id: string; url?: string }[]): string | null =>
  platforms?.find((p) => p.id === 'pc_steam')?.url || null
const withGameData = <
  T extends {
    platforms: string | null
    officialLinks: string | null
    key?: string | null
    devhubProject?: string | null
  },
>(
  row: T,
) => ({
  ...row,
  platforms: parsePlatforms(row.platforms),
  officialLinks: parseOfficialLinks(row.officialLinks),
  devhubProject: row.devhubProject ?? row.key ?? null,
})

export const gamesRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(games).orderBy(desc(games.createdAt))
    return rows.map(withGameData)
  }),

  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(games).where(eq(games.id, input.id)).limit(1)
    return rows[0] ? withGameData(rows[0]) : null
  }),

  create: publicProcedure.input(gameFields).mutation(async ({ ctx, input }) => {
    const slug = `${slugify(input.name)}-${crypto.randomUUID().slice(0, 4)}`
    const steamUrl = steamUrlOf(input.platforms)
    // One project key is used for local task ids and DevHub project lookup.
    const existing = await ctx.db.select({ key: games.key }).from(games)
    const taken = new Set(existing.map((g) => g.key).filter((k): k is string => !!k))
    const requested = input.key ? sanitizeKey(input.key) : input.devhubProject ? sanitizeKey(input.devhubProject) : ''
    const key = uniqueKey(requested || makeGameKey(input.name, taken), taken)
    const rows = await ctx.db
      .insert(games)
      .values({
        name: input.name,
        slug,
        key,
        steamAppId: appIdFromUrl(steamUrl),
        steamStoreUrl: steamUrl,
        releaseDate: input.releaseDate ?? null,
        platforms: input.platforms ? JSON.stringify(input.platforms) : null,
        officialLinks: input.officialLinks ? JSON.stringify(input.officialLinks) : null,
        devhubProject: key,
        ...(input.color ? { color: input.color } : {}),
      })
      .returning()
    return withGameData(rows[0]!)
  }),

  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        patch: gameFields.partial().extend({ archived: z.boolean().optional() }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { platforms, officialLinks, devhubProject, key, ...rest } = input.patch
      const patch = stripUndefined({ ...rest, updatedAt: new Date().toISOString() }) as Record<string, unknown>
      if (platforms !== undefined) {
        patch.platforms = JSON.stringify(platforms)
        const steamUrl = steamUrlOf(platforms)
        patch.steamStoreUrl = steamUrl
        patch.steamAppId = appIdFromUrl(steamUrl)
      }
      if (officialLinks !== undefined) patch.officialLinks = JSON.stringify(officialLinks)
      if (devhubProject !== undefined) patch.devhubProject = devhubProject
      const incomingProjectKey = key ?? devhubProject
      if (incomingProjectKey !== undefined && incomingProjectKey !== null) {
        // Keep the project key unique (renaming it re-labels every task id of this game)
        // and mirror it into the legacy DevHub field so older clients keep working.
        const others = await ctx.db.select({ key: games.key }).from(games).where(ne(games.id, input.id))
        const taken = new Set(others.map((g) => g.key).filter((k): k is string => !!k))
        const nextKey = uniqueKey(sanitizeKey(incomingProjectKey) || 'GAME', taken)
        patch.key = nextKey
        patch.devhubProject = nextKey
      }
      const rows = await ctx.db.update(games).set(patch).where(eq(games.id, input.id)).returning()
      return rows[0] ? withGameData(rows[0]) : null
    }),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(games).where(eq(games.id, input.id))
    return { id: input.id }
  }),
})
