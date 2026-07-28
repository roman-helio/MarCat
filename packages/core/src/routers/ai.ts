import fs from 'node:fs'
import { join } from 'node:path'
import { and, asc, desc, eq, inArray, type InferInsertModel } from 'drizzle-orm'
import {
  aiMessages,
  aiProposalChanges,
  aiRuns,
  creatorDiscoveryProfiles,
  creatorDiscoveryReferences,
  creatorDiscoveryRuns,
  creatorPicks,
  creators,
  events,
  festivalPicks,
  games,
  insights,
  industryEvents,
  inboxComments,
  nextTaskSeq,
  projectCards,
  sources,
  tags,
  taskChecklistItems,
  taskDependencies,
  taskTagLinks,
  tasks,
  type DB,
} from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { syncBlockedStatus } from './tasks'
import { taskDescriptionToMarkdown } from '../util/richText'
import { channelKeyOf } from './creators'
import type { AgentRunResult } from '../context'
import { knowledgeContext, retrieveKnowledge } from '../knowledge/marketing'
import { OFFICIAL_LINK_TYPES } from '../gameSemantics'
import { ACTIVITY_CHANNELS, ACTIVITY_PLATFORMS, ACTIVITY_TYPES } from '../activitySemantics'
import { hashDiscoveryProfile, type DiscoveryProfileSnapshot } from '../youtubeDiscovery'
import {
  PROJECT_CARD_INSIGHT_TITLE,
  projectCardGameId,
  projectCardInsightId,
  updateProjectCardInsight,
} from '../projectCardInsight'

const MCP_AGENTS_MD = `# MarCat — marketing plan (via MCP)

This project is wired to MarCat through an MCP server. Start with \`get_project_card\` when you
know the project key (for example \`{ "key": "SAS" }\`): this is the one-call project brief with
owner-maintained context plus live MarCat state. If you do not know the key, call \`list_games\`
first to get a gameId. Find tasks with \`search_tasks\`, load selected records with \`get_task\`,
use \`list_tasks\` only when the complete catalogue is genuinely needed, and read \`list_tags\`, \`list_activities\`,
	\`list_insights\` (titles only), \`get_insight\` (full text), \`get_wishlist_series\` or change the plan (\`update_game\`, \`update_project_card\`, \`create_task\`,
\`update_task\`, \`add_dependency\`, \`create_tag\`, \`assign_tag\`, \`create_activity\`, …).
Use \`list_festivals\`, \`create_festival\`, \`update_festival\`, \`import_festivals\`,
\`pick_festival\` and \`set_festival_status\` for the shared festival catalogue. A project card is
durable common context for agents; put stable facts, repo/docs links, product positioning and
agent notes there instead of copying the same context into every task. A tag with a targetDate is a
deadline; dependencies are real blocker→blocked edges. Festival dates must be ISO \`YYYY-MM-DD\`;
use \`endDate\` for ranges and \`applyDeadline\` for submission deadlines. Changes apply directly
to the live plan. An activity is a dated note attached to the project, a task, a festival or a
	creator. Published content uses type + normalized platform + placement (subreddit/account/publication)
	+ full body + URL; direction/channel are correspondence only. Set
	\`showOnWishlist: true\` only when it should be a marker on the wishlist chart; edit an existing
	record with \`update_activity\` rather than adding a correction. Game \`officialLinks\` are canonical
	owned website/social/community/press-kit URLs, distinct from release/store \`platforms\` and import \`sources\`.
Player feedback imported from review sources lives in the Comments inbox; inspect it with
\`list_comments\` and only set \`replied\` after a human has actually posted the response.
An insight is durable project knowledge: inspect the title catalogue, then load only relevant full
notes before planning or analysis. Use \`create_insight\` or \`update_insight\` for conclusions and
hypothesis results; keep dated events and correspondence in the activity journal. Every project has
a required \`Карточка проекта\` insight backed by the canonical project card. Fill it with
\`update_insight\` or \`update_project_card\`; it cannot be renamed or deleted.
For high-volume YouTube research use \`list_youtube_discovery_profiles\`,
\`create_youtube_discovery_profile\`, \`start_youtube_discovery\`, \`list_youtube_discovery_runs\`
and \`list_youtube_discovery_candidates\`. Every run writes to a staging artifact first; promote
candidates explicitly with \`review_youtube_discovery_candidate\`. The desktop app, never MCP,
owns the protected YouTube API key.
`

/** Write a ready .mcp.json (+ AGENTS.md) into a project folder so an external agent can use MarCat. */
function writeMcpConfig(
  appPaths: { dbPath: string; mcpServerPath: string } | undefined,
  after: Record<string, unknown>,
): boolean {
  const folder = typeof after.folder === 'string' ? after.folder.trim() : ''
  if (!folder || !appPaths?.mcpServerPath || !appPaths?.dbPath) return false
  try {
    const config = {
      mcpServers: { marcat: { command: 'node', args: [appPaths.mcpServerPath], env: { MARCAT_DB: appPaths.dbPath } } },
    }
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(join(folder, '.mcp.json'), JSON.stringify(config, null, 2) + '\n')
    fs.writeFileSync(join(folder, 'AGENTS.md'), MCP_AGENTS_MD)
    return true
  } catch {
    return false
  }
}

async function buildContext(db: DB, gameId: string, knowledgeQuery = ''): Promise<string> {
  const game = (await db.select().from(games).where(eq(games.id, gameId)).limit(1))[0]
  const card = (await db.select().from(projectCards).where(eq(projectCards.gameId, gameId)).limit(1))[0]
  const ts = await db.select().from(tasks).where(eq(tasks.gameId, gameId))
  const activities = await db.select().from(events).where(eq(events.gameId, gameId))
  const insightRows = await db.select().from(insights).where(eq(insights.gameId, gameId))
  const wantsFeedback = /comment|review|feedback|player|коммент|отзыв|игрок/iu.test(knowledgeQuery)
  const feedbackRows = wantsFeedback
    ? await db
        .select()
        .from(inboxComments)
        .where(eq(inboxComments.gameId, gameId))
        .orderBy(desc(inboxComments.publishedAt))
        .limit(30)
    : []
  const wishlistEvents = activities.filter((item) => item.showOnWishlist)
  const tg = await db.select().from(tags).where(eq(tags.gameId, gameId))
  const links = await db
    .select({ taskId: taskTagLinks.taskId, name: tags.name })
    .from(taskTagLinks)
    .innerJoin(tags, eq(taskTagLinks.tagId, tags.id))
    .where(eq(tags.gameId, gameId))
  const tagsByTask = new Map<string, string[]>()
  for (const l of links) tagsByTask.set(l.taskId, [...(tagsByTask.get(l.taskId) ?? []), l.name])
  const ids = new Set(ts.map((t) => t.id))
  const titleById = new Map(ts.map((t) => [t.id, t.title]))
  const deps = (await db.select().from(taskDependencies)).filter(
    (d) => ids.has(d.blockerTaskId) && ids.has(d.blockedTaskId),
  )
  const active = ts.filter((t) => t.status !== 'cancelled')
  // Festivals this game participates in (picked), with prep status + key fields.
  const picked = await db
    .select({
      id: industryEvents.id,
      name: industryEvents.name,
      startDate: industryEvents.startDate,
      applyDeadline: industryEvents.applyDeadline,
      organizer: industryEvents.organizer,
      costUsd: industryEvents.costUsd,
      status: festivalPicks.status,
    })
    .from(festivalPicks)
    .innerJoin(industryEvents, eq(industryEvents.id, festivalPicks.industryEventId))
    .where(eq(festivalPicks.gameId, gameId))
  // Creators/influencers this game picked, with pipeline status.
  const pickedCreators = await db
    .select({
      id: creators.id,
      name: creators.name,
      kind: creators.kind,
      audience: creators.audience,
      costUsd: creators.costUsd,
      status: creatorPicks.pipelineStatus,
    })
    .from(creatorPicks)
    .innerJoin(creators, eq(creators.id, creatorPicks.creatorId))
    .where(eq(creatorPicks.gameId, gameId))
  const discoveryProfiles = await db
    .select()
    .from(creatorDiscoveryProfiles)
    .where(eq(creatorDiscoveryProfiles.gameId, gameId))
    .orderBy(desc(creatorDiscoveryProfiles.updatedAt))
  const discoveryProfileIds = discoveryProfiles.map((profile) => profile.id)
  const discoveryReferences = discoveryProfileIds.length
    ? await db
        .select()
        .from(creatorDiscoveryReferences)
        .where(inArray(creatorDiscoveryReferences.profileId, discoveryProfileIds))
    : []
  const discoveryRuns = await db
    .select()
    .from(creatorDiscoveryRuns)
    .where(eq(creatorDiscoveryRuns.gameId, gameId))
    .orderBy(desc(creatorDiscoveryRuns.createdAt))
    .limit(10)
  const configuredSources = await db
    .select({
      platform: sources.platform,
      handle: sources.handle,
      displayName: sources.displayName,
      enabled: sources.enabled,
    })
    .from(sources)
    .where(eq(sources.gameId, gameId))
  const projectKey = game?.devhubProject ?? game?.key ?? null
  const officialLinks = (() => {
    try {
      const value = JSON.parse(game?.officialLinks ?? '[]')
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  })() as { type?: string; url?: string; label?: string }[]
  const projectCard = [
    `Required insight: entityId=${projectCardInsightId(gameId)} "${PROJECT_CARD_INSIGHT_TITLE}". This canonical brief must be filled, may be updated as an insight, and cannot be renamed or deleted.`,
    card?.oneLiner ? `- One-liner: ${card.oneLiner}` : '',
    card?.description ? `- Description: ${card.description}` : '- Status: not filled yet',
    card?.audience ? `- Audience: ${card.audience}` : '',
    card?.positioning ? `- Positioning: ${card.positioning}` : '',
    card?.repository ? `- Repository: ${card.repository}` : '',
    card?.branch ? `- Branch: ${card.branch}` : '',
    card?.devhubWikiUrl ? `- DevHub/wiki: ${card.devhubWikiUrl}` : '',
    card?.agentNotes ? `- Agent notes: ${card.agentNotes}` : '',
    card?.docsJson && card.docsJson !== '[]' ? `- Docs JSON: ${card.docsJson}` : '',
    card?.linksJson && card.linksJson !== '[]' ? `- Links JSON: ${card.linksJson}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const knowledge = knowledgeQuery
    ? knowledgeContext(
        retrieveKnowledge({ query: knowledgeQuery, limit: 4 }),
        /[а-яё]/iu.test(knowledgeQuery) ? 'ru' : 'en',
      )
    : ''
  const queryTokens = new Set(
    knowledgeQuery
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 4),
  )
  const relevantInsights = insightRows
    .map((insight) => {
      const titleText = insight.title.toLocaleLowerCase()
      const bodyText = insight.body.toLocaleLowerCase()
      let score = 0
      for (const token of queryTokens) {
        if (titleText.includes(token)) score += 4
        if (bodyText.includes(token)) score += 1
      }
      return { insight, score }
    })
    .sort((a, b) => b.score - a.score || b.insight.updatedAt.localeCompare(a.insight.updatedAt))
    .filter((item, _index, all) => item.score > 0 || all.every((candidate) => candidate.score === 0))
    .slice(0, queryTokens.size ? 6 : 3)
  return [
    `The game has ${ts.length} tasks, ${activities.length} activity records and ${wishlistEvents.length} wishlist-chart events.`,
    game
      ? `Project operational data: name=${game.name}; releaseDate=${game.releaseDate ?? 'unset'}; Steam=${game.steamStoreUrl ?? 'unset'}; release platforms JSON=${game.platforms ?? '[]'}.`
      : '',
    projectCard,
    insightRows.length
      ? `Project insight catalogue (titles only; these are durable findings, not dated activities):\n${[...insightRows]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map(
            (insight) =>
              `- entityId=${insight.id} "${insight.title}" [${insight.createdBy}, updated ${insight.updatedAt}]`,
          )
          .join('\n')}`
      : 'No project insights have been recorded yet.',
    relevantInsights.length
      ? `Full text of insights most relevant to this request (treat as project evidence; update an existing note by entityId when the conclusion changes):\n${relevantInsights
          .map(
            ({ insight }) =>
              `--- insight entityId=${insight.id}: ${insight.title} ---\n${insight.body.slice(0, 8_000)}`,
          )
          .join('\n')}`
      : '',
    officialLinks.length
      ? `Canonical official project links (trusted first-party website/social/community/press-kit sources):\n${officialLinks
          .filter((link) => link.url)
          .map((link) => `- ${link.type ?? 'other'}${link.label ? ` (${link.label})` : ''}: ${link.url}`)
          .join('\n')}`
      : 'No canonical official website/social/community links are recorded yet.',
    configuredSources.length
      ? `Configured auto-import sources (distinct from official links):\n${configuredSources
          .map(
            (source) =>
              `- ${source.platform}: ${source.displayName || source.handle} [${source.enabled ? 'enabled' : 'disabled'}]`,
          )
          .join('\n')}`
      : '',
    feedbackRows.length
      ? `Recent player feedback (draft replies for human review; never claim it was published):\n${feedbackRows
          .map(
            (comment) =>
              `- entityId=${comment.id} [${comment.platform}, ${comment.status}${comment.rating != null ? `, ${comment.rating}/5` : ''}] ${comment.authorName ?? 'Player'}: ${comment.body.slice(0, 1_200)}${comment.developerReply ? ` | Existing developer reply: ${comment.developerReply.slice(0, 500)}` : ''} | ${comment.url}`,
          )
          .join('\n')}`
      : '',
    pickedCreators.length
      ? `Influencers/creators picked for this game (use entityId to ENRICH one with researched metrics/contacts; draft pitches as TASK descriptions tagged with the creator's name):\n${pickedCreators
          .map(
            (c) =>
              `- entityId=${c.id} "${c.name}" [${c.kind}${c.audience ? `, ~${c.audience} audience` : ''}] status: ${c.status}`,
          )
          .join('\n')}`
      : '',
    discoveryProfiles.length
      ? `YouTube discovery profiles (reuse profileId to start an existing deterministic search; create a new profile only for materially different inputs):\n${discoveryProfiles
          .map((profile) => {
            const refs = discoveryReferences
              .filter((reference) => reference.profileId === profile.id)
              .map((reference) => reference.label)
            const latestRun = discoveryRuns.find((run) => run.profileId === profile.id)
            return `- profileId=${profile.id} "${profile.name}" [${profile.mode}] references: ${refs.join(', ')}${latestRun ? `; latest run ${latestRun.id}=${latestRun.status}` : ''}`
          })
          .join('\n')}`
      : 'No YouTube discovery profiles exist yet. The agent may propose a creator_discovery_search change; the protected YouTube key must be configured by the user in the app.',
    projectKey ? `Project key for MarCat task ids and DevHub lookup: ${projectKey}` : '',
    picked.length
      ? `Festivals this game is participating in (use entityId to ENRICH one after web research — fill organizer, description, applyUrl, applyDeadline, fee, steamEvent/steamFeature):\n${picked
          .map(
            (f) =>
              `- entityId=${f.id} "${f.name}" runs ${f.startDate}${f.applyDeadline ? `, apply by ${f.applyDeadline}` : ''} [status: ${f.status}]${f.organizer ? `, org: ${f.organizer}` : ''}`,
          )
          .join('\n')}`
      : '',
    tg.length
      ? `Existing tags (reuse these names; a tag with a deadline date is a milestone):\n${tg
          .map((t) => `- ${t.name}${t.targetDate ? ` (deadline ${t.targetDate})` : ''}`)
          .join('\n')}`
      : '',
    active.length
      ? `Existing tasks (reference by EXACT title to link them):\n${active
          .map((t) => {
            const tn = tagsByTask.get(t.id)
            return `- "${t.title}" [${t.priority}, ${t.status}]${t.dueDate ? ` due ${t.dueDate}` : ''}${tn?.length ? ` #${tn.join(' #')}` : ''}`
          })
          .join('\n')}`
      : '',
    deps.length
      ? `Dependencies (blocker -> blocked, by title):\n${deps
          .map((d) => `- "${titleById.get(d.blockerTaskId)}" -> "${titleById.get(d.blockedTaskId)}"`)
          .join('\n')}`
      : '',
    activities.length
      ? `Recent activity journal (entityId is required to edit an existing record):\n${activities
          .sort((a, b) => `${b.occurredAt}|${b.createdAt}`.localeCompare(`${a.occurredAt}|${a.createdAt}`))
          .slice(0, 30)
          .map(
            (a) =>
              `- entityId=${a.id} ${a.occurredAt} [${a.subjectType}${a.subjectLabel ? `: ${a.subjectLabel}` : ''}${a.showOnWishlist ? ', on wishlist chart' : ''}] ${a.title}${a.description ? ` — ${a.description.slice(0, 500)}` : ''}`,
          )
          .join('\n')}`
      : '',
    knowledge,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Model tiers MarCat routes to. We only ever use Sonnet (simple) or Opus (complex) — never Fable/Haiku. */
const MODEL_IDS = { sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8' } as const
export function modelIdFor(tier?: 'sonnet' | 'opus'): string {
  return tier === 'opus' ? MODEL_IDS.opus : MODEL_IDS.sonnet
}

const str = (v: unknown, fb = '') => (typeof v === 'string' && v.trim() ? v.trim() : fb)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : str(v) ? [str(v)] : []
const today = () => new Date().toISOString().slice(0, 10)

/** Find a game tag by name (case-insensitive) or create one; returns its id. */
async function ensureTag(db: DB, gameId: string, name: string): Promise<string> {
  const existing = await db.select().from(tags).where(eq(tags.gameId, gameId))
  const hit = existing.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase())
  if (hit) return hit.id
  const rows = await db.insert(tags).values({ gameId, name: name.trim() }).returning()
  return rows[0]!.id
}

function parseJsonStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function discoveryReferencesFromAgent(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') {
        const label = item.trim()
        return label ? { label, aliases: [], queryTerms: [label], weight: 1 } : null
      }
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const label = str(record.label)
      if (!label) return null
      const aliases = strList(record.aliases)
      const queryTerms = strList(record.queryTerms)
      return {
        label: label.slice(0, 160),
        aliases,
        queryTerms: queryTerms.length ? queryTerms : [label],
        weight: Math.min(10, Math.max(0.1, num(record.weight) ?? 1)),
      }
    })
    .filter((reference): reference is NonNullable<typeof reference> => !!reference)
    .slice(0, 100)
}

async function queueAgentDiscoverySearch(db: DB, gameId: string, after: Record<string, unknown>): Promise<boolean> {
  let profile = str(after.profileId)
    ? (
        await db
          .select()
          .from(creatorDiscoveryProfiles)
          .where(
            and(eq(creatorDiscoveryProfiles.id, str(after.profileId)), eq(creatorDiscoveryProfiles.gameId, gameId)),
          )
          .limit(1)
      )[0]
    : undefined

  if (!profile) {
    const name = str(after.name)
    const references = discoveryReferencesFromAgent(after.references)
    if (!name || !references.length) return false
    const existing = await db.select().from(creatorDiscoveryProfiles).where(eq(creatorDiscoveryProfiles.gameId, gameId))
    profile = existing.find((item) => item.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())
    if (!profile) {
      profile = (
        await db
          .insert(creatorDiscoveryProfiles)
          .values({
            gameId,
            name: name.slice(0, 160),
            mode: str(after.mode) === 'topic' ? 'topic' : 'games',
            languagesJson: JSON.stringify(strList(after.languages).slice(0, 10)),
            includeTermsJson: JSON.stringify(strList(after.includeTerms).slice(0, 100)),
            excludeTermsJson: JSON.stringify(strList(after.excludeTerms).slice(0, 100)),
            seedChannelsJson: JSON.stringify(strList(after.seedChannels).slice(0, 200)),
            maxSearchRequests: Math.min(100, Math.max(1, Math.round(num(after.maxSearchRequests) ?? 10))),
            maxChannels: Math.min(5_000, Math.max(10, Math.round(num(after.maxChannels) ?? 500))),
            recentVideoLimit: Math.min(100, Math.max(10, Math.round(num(after.recentVideoLimit) ?? 50))),
            discoverContacts: bool(after.discoverContacts) ?? true,
          })
          .returning()
      )[0]
      await db.insert(creatorDiscoveryReferences).values(
        references.map((reference) => ({
          profileId: profile!.id,
          label: reference.label,
          aliasesJson: JSON.stringify(reference.aliases),
          queryTermsJson: JSON.stringify(reference.queryTerms),
          weight: reference.weight,
        })),
      )
    }
  }

  if (!profile) return false
  const referenceRows = await db
    .select()
    .from(creatorDiscoveryReferences)
    .where(eq(creatorDiscoveryReferences.profileId, profile.id))
    .orderBy(asc(creatorDiscoveryReferences.createdAt))
  if (!referenceRows.length) return false
  const snapshot: DiscoveryProfileSnapshot = {
    profileId: profile.id,
    gameId: profile.gameId,
    name: profile.name,
    mode: profile.mode,
    languages: parseJsonStringList(profile.languagesJson),
    includeTerms: parseJsonStringList(profile.includeTermsJson),
    excludeTerms: parseJsonStringList(profile.excludeTermsJson),
    seedChannels: parseJsonStringList(profile.seedChannelsJson),
    maxSearchRequests: profile.maxSearchRequests,
    maxChannels: profile.maxChannels,
    recentVideoLimit: profile.recentVideoLimit,
    discoverContacts: profile.discoverContacts,
    references: referenceRows.map((reference) => ({
      id: reference.id,
      label: reference.label,
      aliases: parseJsonStringList(reference.aliasesJson),
      queryTerms: parseJsonStringList(reference.queryTermsJson),
      weight: reference.weight,
    })),
  }
  const profileHash = hashDiscoveryProfile(snapshot)
  const matchingRuns = await db
    .select()
    .from(creatorDiscoveryRuns)
    .where(and(eq(creatorDiscoveryRuns.profileId, profile.id), eq(creatorDiscoveryRuns.profileHash, profileHash)))
    .orderBy(desc(creatorDiscoveryRuns.createdAt))
  const duplicate = matchingRuns.find((run) =>
    ['queued', 'running', 'paused', 'waiting_for_quota'].includes(run.status),
  )
  const freshCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString()
  const fresh = matchingRuns.find(
    (run) => run.status === 'completed' && !!run.finishedAt && run.finishedAt >= freshCutoff,
  )
  if (duplicate || fresh) return true
  await db.insert(creatorDiscoveryRuns).values({
    gameId,
    profileId: profile.id,
    profileHash,
    profileSnapshotJson: JSON.stringify(snapshot),
  })
  return true
}

async function applyChange(db: DB, gameId: string, entity: string, op: string, after: Record<string, unknown>) {
  // Most proposals create. Existing catalogue records and journal entries may be edited by id.
  if (
    op !== 'create' &&
    entity !== 'festival' &&
    entity !== 'creator' &&
    entity !== 'activity' &&
    entity !== 'insight' &&
    entity !== 'game'
  ) {
    return false
  }
  if (entity === 'game' && op === 'update' && Array.isArray(after.officialLinks)) {
    const officialLinks = after.officialLinks
      .map((value) => {
        const link = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
        const type = str(link.type)
        const url = str(link.url)
        if (!OFFICIAL_LINK_TYPES.includes(type as (typeof OFFICIAL_LINK_TYPES)[number]) || !url) return null
        return { type, url, ...(str(link.label) ? { label: str(link.label) } : {}) }
      })
      .filter(Boolean)
    await db
      .update(games)
      .set({ officialLinks: JSON.stringify(officialLinks), updatedAt: new Date().toISOString() })
      .where(eq(games.id, gameId))
    return true
  }
  if (entity === 'creator_discovery_search' && op === 'create') {
    return queueAgentDiscoverySearch(db, gameId, after)
  }
  if (entity === 'insight') {
    const existingId = str(after.entityId) || str(after.id)
    if (op === 'update') {
      if (!existingId) return false
      const cardGameId = projectCardGameId(existingId)
      if (cardGameId) {
        if (cardGameId !== gameId || !str(after.body)) return false
        await updateProjectCardInsight(db, gameId, str(after.body), 'ai')
        return true
      }
      const existing = (
        await db
          .select()
          .from(insights)
          .where(and(eq(insights.id, existingId), eq(insights.gameId, gameId)))
          .limit(1)
      )[0]
      if (!existing) return false
      const set: Partial<InferInsertModel<typeof insights>> = { updatedAt: new Date().toISOString() }
      if (after.title !== undefined && str(after.title)) set.title = str(after.title).slice(0, 240)
      if (after.body !== undefined && str(after.body)) set.body = str(after.body)
      if (Object.keys(set).length === 1) return false
      await db.update(insights).set(set).where(eq(insights.id, existingId))
      return true
    }
    if (!str(after.title) || !str(after.body)) return false
    await db.insert(insights).values({
      gameId,
      title: str(after.title).slice(0, 240),
      body: str(after.body),
      createdBy: 'ai',
    })
    return true
  }
  if (entity === 'task' && str(after.title)) {
    const seq = await nextTaskSeq(db, gameId)
    const rows = await db
      .insert(tasks)
      .values({
        gameId,
        seq,
        title: str(after.title),
        priority: ['low', 'med', 'high', 'urgent'].includes(str(after.priority))
          ? (str(after.priority) as 'low')
          : 'med',
        status: 'todo',
        startDate: str(after.startDate) || null,
        dueDate: str(after.dueDate) || null,
        description: taskDescriptionToMarkdown(str(after.description)),
      })
      .returning()
    const taskId = rows[0]!.id
    // Optional checklist sub-steps.
    const checklist = strList(after.checklist)
    for (let i = 0; i < checklist.length; i++) {
      await db.insert(taskChecklistItems).values({ taskId, text: checklist[i]!, sortOrder: i })
    }
    // Optional track tags (single `tag` or `tags` array) — grouped, batch-filterable.
    const tagNames = [...strList(after.tags), ...strList(after.tag)]
    for (const name of tagNames) {
      const tagId = await ensureTag(db, gameId, name)
      const dup = await db
        .select()
        .from(taskTagLinks)
        .where(and(eq(taskTagLinks.taskId, taskId), eq(taskTagLinks.tagId, tagId)))
      if (!dup.length) await db.insert(taskTagLinks).values({ taskId, tagId })
    }
    return true
  }
  if (entity === 'event' && str(after.title)) {
    await db.insert(events).values({
      gameId,
      occurredAt: str(after.occurredAt) || today(),
      type: str(after.type, 'other'),
      platform: str(after.platform) || null,
      title: str(after.title),
      url: str(after.url) || null,
      views: num(after.views),
      showOnWishlist: true,
    })
    return true
  }
  if (entity === 'activity') {
    const existingId = str(after.entityId) || str(after.id)
    const existing = existingId
      ? (
          await db
            .select()
            .from(events)
            .where(and(eq(events.id, existingId), eq(events.gameId, gameId)))
            .limit(1)
        )[0]
      : undefined
    if (op !== 'create' && !existing) return false

    const subjectTypeRaw = str(after.subjectType, existing?.subjectType ?? 'project')
    const subjectType = ['project', 'task', 'festival', 'creator'].includes(subjectTypeRaw)
      ? (subjectTypeRaw as 'project' | 'task' | 'festival' | 'creator')
      : 'project'
    const subjectId = subjectType === 'project' ? null : str(after.subjectId, existing?.subjectId ?? '') || null
    let subjectLabel: string | null = existing?.subjectLabel ?? null
    if (subjectType === 'task' && subjectId) {
      const row = await db
        .select({ label: tasks.title })
        .from(tasks)
        .where(and(eq(tasks.id, subjectId), eq(tasks.gameId, gameId)))
        .limit(1)
      if (!row[0]) return false
      subjectLabel = row[0].label
    } else if (subjectType === 'festival' && subjectId) {
      const row = await db
        .select({ label: industryEvents.name })
        .from(industryEvents)
        .where(eq(industryEvents.id, subjectId))
        .limit(1)
      if (!row[0]) return false
      subjectLabel = row[0].label
    } else if (subjectType === 'creator' && subjectId) {
      const row = await db.select({ label: creators.name }).from(creators).where(eq(creators.id, subjectId)).limit(1)
      if (!row[0]) return false
      subjectLabel = row[0].label
    } else if (subjectType !== 'project') {
      return false
    }

    const body =
      typeof after.body === 'string'
        ? after.body
        : typeof after.description === 'string'
          ? after.description
          : undefined
    const fallbackTitle =
      body
        ?.split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? ''
    const title = str(after.title) || fallbackTitle.slice(0, 300)
    const direction = ['outbound', 'inbound'].includes(str(after.direction))
      ? (str(after.direction) as 'outbound' | 'inbound')
      : null
    const statusAfter = str(after.statusAfter) || null
    const channelRaw = str(after.channel)
    const channel =
      direction && ACTIVITY_CHANNELS.includes(channelRaw as (typeof ACTIVITY_CHANNELS)[number])
        ? (channelRaw as (typeof ACTIVITY_CHANNELS)[number])
        : null
    const typeRaw = str(after.type, existing?.type ?? 'other')
    const activityType = ACTIVITY_TYPES.includes(typeRaw as (typeof ACTIVITY_TYPES)[number]) ? typeRaw : 'other'
    const platformRaw = str(after.platform, existing?.platform ?? '')
    const platform = ACTIVITY_PLATFORMS.includes(platformRaw as (typeof ACTIVITY_PLATFORMS)[number])
      ? platformRaw
      : null
    const showOnWishlist = bool(after.showOnWishlist) ?? existing?.showOnWishlist ?? false
    if (showOnWishlist && direction) return false
    if (direction && !channel) return false
    if (statusAfter && !['creator', 'festival'].includes(subjectType)) return false

    if (existing) {
      const set: Partial<InferInsertModel<typeof events>> = {
        subjectType,
        subjectId,
        subjectLabel,
        creatorId: subjectType === 'creator' ? subjectId : null,
        updatedAt: new Date().toISOString(),
      }
      if (after.occurredAt !== undefined) set.occurredAt = str(after.occurredAt, existing.occurredAt)
      if (after.title !== undefined || body !== undefined) set.title = title || existing.title
      if (body !== undefined) set.description = body
      if (after.direction !== undefined) set.direction = direction
      if (after.channel !== undefined || after.direction !== undefined) set.channel = channel
      if (after.statusAfter !== undefined) set.statusAfter = statusAfter
      if (after.showOnWishlist !== undefined) set.showOnWishlist = showOnWishlist
      if (after.type !== undefined) set.type = activityType
      if (after.platform !== undefined) set.platform = platform
      if (after.placement !== undefined) set.placement = str(after.placement) || null
      if (after.url !== undefined) set.url = str(after.url) || null
      if (after.views !== undefined) set.views = num(after.views)
      if (after.likes !== undefined) set.likes = num(after.likes)
      if (after.comments !== undefined) set.comments = num(after.comments)
      if (after.isOwn !== undefined) set.isOwn = bool(after.isOwn) ?? existing.isOwn
      await db.update(events).set(set).where(eq(events.id, existing.id))
    } else {
      if (!title && !body?.trim()) return false
      await db.insert(events).values({
        gameId,
        occurredAt: str(after.occurredAt) || today(),
        subjectType,
        subjectId,
        subjectLabel,
        showOnWishlist,
        direction,
        channel,
        statusAfter,
        type: activityType,
        platform,
        placement: str(after.placement) || null,
        title:
          title ||
          (direction === 'inbound' ? 'Received reply' : direction === 'outbound' ? 'Sent message' : 'Activity'),
        description: body ?? '',
        url: str(after.url) || null,
        views: num(after.views),
        likes: num(after.likes),
        comments: num(after.comments),
        isOwn: bool(after.isOwn) ?? direction !== 'inbound',
        creatorId: subjectType === 'creator' ? subjectId : null,
        createdBy: 'ai',
      })
    }
    if (statusAfter && subjectId && subjectType === 'creator') {
      await db
        .update(creatorPicks)
        .set({ pipelineStatus: statusAfter })
        .where(and(eq(creatorPicks.gameId, gameId), eq(creatorPicks.creatorId, subjectId)))
    } else if (statusAfter && subjectId && subjectType === 'festival') {
      await db
        .update(festivalPicks)
        .set({ status: statusAfter })
        .where(and(eq(festivalPicks.gameId, gameId), eq(festivalPicks.industryEventId, subjectId)))
    }
    return true
  }
  // Researched industry event (Steam festival, conference…).
  // The cat may CREATE one (name + startDate) or ENRICH an existing one (entityId set) after web research.
  if (entity === 'festival') {
    // Fields the cat is allowed to fill — undefined keys are left untouched on update.
    const set: Partial<InferInsertModel<typeof industryEvents>> = {}
    const put = (k: string, v: unknown) => {
      if (v !== null && v !== undefined && v !== '') (set as Record<string, unknown>)[k] = v
    }
    put('name', str(after.name) || undefined)
    put('type', str(after.type) || undefined)
    put('startDate', str(after.startDate) || undefined)
    put('endDate', str(after.endDate) || undefined)
    put('applyDeadline', str(after.applyDeadline) || undefined)
    put('url', str(after.url) || undefined)
    put('applyUrl', str(after.applyUrl) || undefined)
    put('organizer', str(after.organizer) || undefined)
    put('description', str(after.description) || undefined)
    put('notes', str(after.notes) || undefined)
    put('steamEvent', str(after.steamEvent) || undefined)
    put('steamFeature', str(after.steamFeature) || undefined)
    put('media', bool(after.media))
    put('offline', bool(after.offline))
    put('costUsd', num(after.costUsd ?? after.feeUsd))

    const existingId = str(after.entityId) || str(after.id)
    if (existingId) {
      // Enrich an existing festival in the shared catalogue.
      if (Object.keys(set).length) {
        await db.update(industryEvents).set(set).where(eq(industryEvents.id, existingId))
      }
      // Ensure this game is participating.
      const dup = await db
        .select()
        .from(festivalPicks)
        .where(and(eq(festivalPicks.gameId, gameId), eq(festivalPicks.industryEventId, existingId)))
      if (!dup.length) await db.insert(festivalPicks).values({ gameId, industryEventId: existingId })
      return true
    }
    // Create a new festival + auto-pick for this game.
    if (str(after.name) && str(after.startDate)) {
      const rows = await db
        .insert(industryEvents)
        .values({
          ...set,
          name: str(after.name),
          startDate: str(after.startDate),
          type: str(after.type, 'festival'),
          source: 'ai',
        })
        .returning()
      await db.insert(festivalPicks).values({ gameId, industryEventId: rows[0]!.id })
      return true
    }
    return false
  }
  // A dated tag = a deadline (former "milestone"). Plain tags come in via task.tags.
  if (entity === 'tag' && str(after.name)) {
    const tagId = await ensureTag(db, gameId, str(after.name))
    const set: Record<string, unknown> = {}
    if (str(after.targetDate)) set.targetDate = str(after.targetDate)
    if (['release', 'festival', 'sale', 'update', 'track', 'other'].includes(str(after.type))) {
      set.type = str(after.type)
    }
    if (Object.keys(set).length) await db.update(tags).set(set).where(eq(tags.id, tagId))
    return true
  }
  // A researched creator/influencer. CREATE a new one (+auto-pick) or ENRICH an existing one (entityId).
  if (entity === 'creator' && (str(after.name) || str(after.entityId) || str(after.id))) {
    const set: Partial<InferInsertModel<typeof creators>> = {}
    const put = (k: string, v: unknown) => {
      if (v !== null && v !== undefined && v !== '') (set as Record<string, unknown>)[k] = v
    }
    put('name', str(after.name) || undefined)
    put('handle', str(after.handle) || undefined)
    put('kind', str(after.kind) || undefined)
    put('primaryPlatform', str(after.primaryPlatform) || undefined)
    put('audience', num(after.audience))
    put('avgViews', num(after.avgViews))
    put('engagementRate', num(after.engagementRate))
    put('lastActiveAt', str(after.lastActiveAt) || undefined)
    put('cadencePerMonth', num(after.cadencePerMonth))
    put('language', str(after.language) || undefined)
    put('region', str(after.region) || undefined)
    put('costUsd', num(after.costUsd ?? after.rateUsd))
    put('acceptsKeysOnly', bool(after.acceptsKeysOnly))
    put('notes', str(after.notes) || undefined)
    put('description', str(after.description) || undefined)
    if (Array.isArray(after.topics)) put('topicsJson', JSON.stringify(after.topics))
    if (Array.isArray(after.playedGames)) put('playedGamesJson', JSON.stringify(after.playedGames))
    if (Array.isArray(after.contacts)) put('contactsJson', JSON.stringify(after.contacts))
    if (Array.isArray(after.channels)) put('channelsJson', JSON.stringify(after.channels))
    const channelKey = str(after.channelKey) || channelKeyOf(str(after.handle) || null)
    if (channelKey) put('channelKey', channelKey)

    const existingId = str(after.entityId) || str(after.id)
    if (existingId) {
      if (Object.keys(set).length) await db.update(creators).set(set).where(eq(creators.id, existingId))
      const dup = await db
        .select()
        .from(creatorPicks)
        .where(and(eq(creatorPicks.gameId, gameId), eq(creatorPicks.creatorId, existingId)))
      if (!dup.length) await db.insert(creatorPicks).values({ gameId, creatorId: existingId, addedBy: 'ai' })
      return true
    }
    if (str(after.name)) {
      // Dedup by channel key before creating.
      let creatorId: string | undefined
      if (channelKey) {
        const found = await db.select({ id: creators.id }).from(creators).where(eq(creators.channelKey, channelKey))
        if (found.length) creatorId = found[0]!.id
      }
      if (!creatorId) {
        const rows = await db
          .insert(creators)
          .values({ ...set, name: str(after.name), source: 'ai' })
          .returning({ id: creators.id })
        creatorId = rows[0]!.id
      }
      const dup = await db
        .select()
        .from(creatorPicks)
        .where(and(eq(creatorPicks.gameId, gameId), eq(creatorPicks.creatorId, creatorId)))
      if (!dup.length) await db.insert(creatorPicks).values({ gameId, creatorId, addedBy: 'ai' })
      return true
    }
    return false
  }
  // Pick an existing catalogue creator into this game's outreach pipeline.
  if (entity === 'creator_pick') {
    const creatorId = str(after.creatorId) || str(after.entityId) || str(after.id)
    if (!creatorId) return false
    const keysSentJson = Array.isArray(after.keysSent) ? JSON.stringify(after.keysSent) : undefined
    const dup = await db
      .select()
      .from(creatorPicks)
      .where(and(eq(creatorPicks.gameId, gameId), eq(creatorPicks.creatorId, creatorId)))
    if (!dup.length) await db.insert(creatorPicks).values({ gameId, creatorId, addedBy: 'ai', keysSentJson })
    else if (keysSentJson !== undefined) {
      await db
        .update(creatorPicks)
        .set({ keysSentJson })
        .where(and(eq(creatorPicks.gameId, gameId), eq(creatorPicks.creatorId, creatorId)))
    }
    return true
  }
  return false
}

const activeAiRuns = new Map<string, AbortController>()

async function settleAgentRun(
  db: DB,
  runId: string,
  result: AgentRunResult,
  options: { replacePending?: boolean; fallbackSessionId?: string | null } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await tx.select({ status: aiRuns.status }).from(aiRuns).where(eq(aiRuns.id, runId)).limit(1)
    if (current[0]?.status !== 'running') return
    if (options.replacePending) {
      await tx
        .delete(aiProposalChanges)
        .where(and(eq(aiProposalChanges.runId, runId), eq(aiProposalChanges.status, 'pending')))
    }
    if (result.changes.length) {
      await tx.insert(aiProposalChanges).values(
        result.changes.map((change) => ({
          runId,
          op: change.op,
          entity: change.entity,
          afterJson: JSON.stringify(change.after ?? {}),
        })),
      )
    }
    await tx.insert(aiMessages).values({ runId, role: 'assistant', content: result.summary || '(no summary)' })
    await tx
      .update(aiRuns)
      .set({
        status: 'proposed',
        summary: result.summary,
        rawOutput: result.rawOutput,
        model: result.model ?? null,
        sessionId: result.sessionId ?? options.fallbackSessionId ?? null,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(aiRuns.id, runId))
  })
}

async function failAgentRun(db: DB, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await db.transaction(async (tx) => {
    const current = await tx.select({ status: aiRuns.status }).from(aiRuns).where(eq(aiRuns.id, runId)).limit(1)
    if (current[0]?.status !== 'running') return
    await tx.insert(aiMessages).values({ runId, role: 'assistant', content: `Error: ${message}` })
    await tx
      .update(aiRuns)
      .set({ status: 'error', summary: message, finishedAt: new Date().toISOString() })
      .where(eq(aiRuns.id, runId))
  })
}

export const aiRouter = router({
  /** Selected CLI, authentication mode and alternatives for the embedded agent. */
  available: publicProcedure.query(({ ctx }) => {
    const status = ctx.agent?.status?.()
    const provider = status?.provider ?? ctx.secrets?.getAiProvider() ?? 'claude'
    return {
      available: status?.available ?? false,
      provider,
      providers:
        status?.providers ??
        ({
          claude: { available: false, authenticated: false, authMode: 'none' },
          codex: { available: false, authenticated: false, authMode: 'none' },
        } as const),
      hasToken: !!ctx.secrets?.getClaudeToken(),
    }
  }),

  setProvider: publicProcedure.input(z.object({ provider: z.enum(['claude', 'codex']) })).mutation(({ ctx, input }) => {
    ctx.secrets?.setAiProvider(input.provider)
    return { ok: true }
  }),

  setToken: publicProcedure.input(z.object({ token: z.string() })).mutation(({ ctx, input }) => {
    ctx.secrets?.setClaudeToken(input.token.trim() || null)
    return { ok: true }
  }),

  listRuns: publicProcedure.input(z.object({ gameId: z.string() })).query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.gameId, input.gameId), eq(aiRuns.archived, false)))
      .orderBy(desc(aiRuns.createdAt))
    if (!rows.length) return []
    // Count still-pending proposal changes per run so the UI can tell apart
    // "has changes waiting for review" from chat-only / already-applied runs.
    const changes = await ctx.db
      .select({ runId: aiProposalChanges.runId, status: aiProposalChanges.status })
      .from(aiProposalChanges)
      .where(
        inArray(
          aiProposalChanges.runId,
          rows.map((r) => r.id),
        ),
      )
    const pending = new Map<string, number>()
    for (const c of changes) if (c.status === 'pending') pending.set(c.runId, (pending.get(c.runId) ?? 0) + 1)
    return rows.map((r) => ({ ...r, pendingChanges: pending.get(r.id) ?? 0 }))
  }),

  getRun: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(aiRuns).where(eq(aiRuns.id, input.id)).limit(1)
    const run = rows[0]
    if (!run) return null
    const changes = await ctx.db
      .select()
      .from(aiProposalChanges)
      .where(eq(aiProposalChanges.runId, run.id))
      .orderBy(asc(aiProposalChanges.createdAt))
    const messages = await ctx.db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.runId, run.id))
      .orderBy(asc(aiMessages.createdAt))
    return {
      run,
      messages,
      changes: changes.map((c) => ({ ...c, after: JSON.parse(c.afterJson) as Record<string, unknown> })),
    }
  }),

  run: publicProcedure
    .input(
      z.object({
        gameId: z.string(),
        prompt: z.string().min(1),
        mode: z.string().optional(),
        // Which model tier to use: 'sonnet' for simple tasks, 'opus' for research-heavy ones.
        model: z.enum(['sonnet', 'opus']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const agent = ctx.agent
      if (!agent) {
        throw new Error('AI agent not available. Configure Claude Code or Codex CLI in Settings.')
      }
      const modelId = agent.provider?.() === 'codex' ? 'codex' : modelIdFor(input.model)
      // Insert a `running` row up-front so the request appears immediately (with a spinner),
      // then drive the agent in the background and flip status to proposed/error on finish.
      const runRows = await ctx.db
        .insert(aiRuns)
        .values({
          gameId: input.gameId,
          mode: input.mode ?? 'freeform',
          prompt: input.prompt,
          status: 'running',
          model: modelId,
        })
        .returning()
      const run = runRows[0]!
      await ctx.db.insert(aiMessages).values({ runId: run.id, role: 'user', content: input.prompt })
      const controller = new AbortController()
      activeAiRuns.set(run.id, controller)
      void (async () => {
        try {
          const context = await buildContext(ctx.db, input.gameId, input.prompt)
          const res = await agent.run({
            gameId: input.gameId,
            prompt: input.prompt,
            context,
            model: modelId,
            signal: controller.signal,
          })
          await settleAgentRun(ctx.db, run.id, res)
        } catch (e) {
          await failAgentRun(ctx.db, run.id, e)
        } finally {
          activeAiRuns.delete(run.id)
        }
      })()
      return run
    }),

  /** Continue a run as a chat: resume the session with a follow-up; replaces the pending proposal. */
  reply: publicProcedure
    .input(z.object({ runId: z.string(), message: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const agent = ctx.agent
      if (!agent) throw new Error('AI agent not available.')
      const rows = await ctx.db.select().from(aiRuns).where(eq(aiRuns.id, input.runId)).limit(1)
      const run = rows[0]
      if (!run) throw new Error('Run not found')
      if (run.status === 'running' || activeAiRuns.has(run.id)) throw new Error('This AI run is already in progress')
      await ctx.db.insert(aiMessages).values({ runId: run.id, role: 'user', content: input.message })
      await ctx.db.update(aiRuns).set({ status: 'running', finishedAt: null, error: null }).where(eq(aiRuns.id, run.id))
      const controller = new AbortController()
      activeAiRuns.set(run.id, controller)
      void (async () => {
        try {
          const res = await agent.run({
            gameId: run.gameId,
            prompt: input.message,
            context: '',
            resumeSessionId: run.sessionId ?? undefined,
            // Claude keeps the original tier; Codex keeps its own configured model.
            model:
              agent.provider?.() === 'codex'
                ? undefined
                : modelIdFor((run.model ?? '').includes('opus') ? 'opus' : 'sonnet'),
            signal: controller.signal,
          })
          await settleAgentRun(ctx.db, run.id, res, { replacePending: true, fallbackSessionId: run.sessionId })
        } catch (e) {
          await failAgentRun(ctx.db, run.id, e)
        } finally {
          activeAiRuns.delete(run.id)
        }
      })()
      return run
    }),

  cancel: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    activeAiRuns.get(input.id)?.abort()
    activeAiRuns.delete(input.id)
    await ctx.db.transaction(async (tx) => {
      const current = await tx.select({ status: aiRuns.status }).from(aiRuns).where(eq(aiRuns.id, input.id)).limit(1)
      if (current[0]?.status !== 'running') return
      const message = 'AI request cancelled'
      await tx.insert(aiMessages).values({ runId: input.id, role: 'assistant', content: message })
      await tx
        .update(aiRuns)
        .set({ status: 'error', summary: message, finishedAt: new Date().toISOString() })
        .where(eq(aiRuns.id, input.id))
    })
    return { ok: true }
  }),

  archiveRun: publicProcedure
    .input(z.object({ id: z.string(), archived: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(aiRuns)
        .set({ archived: input.archived ?? true })
        .where(eq(aiRuns.id, input.id))
      return { ok: true }
    }),

  /** Edit a staged change before approving (manual tweak of an AI proposal). */
  updateChange: publicProcedure
    .input(z.object({ id: z.string(), after: z.record(z.any()) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(aiProposalChanges)
        .set({ afterJson: JSON.stringify(input.after) })
        .where(eq(aiProposalChanges.id, input.id))
      return { ok: true }
    }),

  applyRun: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(aiRuns).where(eq(aiRuns.id, input.id)).limit(1)
    const run = rows[0]
    if (!run) throw new Error('Run not found')
    const changes = await ctx.db.select().from(aiProposalChanges).where(eq(aiProposalChanges.runId, run.id))
    const pending = changes.filter((c) => c.status === 'pending')
    let applied = 0
    const databaseChanges = pending.filter((change) => change.entity !== 'mcp_config')
    const filesystemChanges = pending.filter((change) => change.entity === 'mcp_config')

    await ctx.db.transaction(async (tx) => {
      const transactionDb = tx as unknown as DB
      const setStatus = (id: string, ok: boolean) =>
        tx
          .update(aiProposalChanges)
          .set({ status: ok ? 'applied' : 'rejected' })
          .where(eq(aiProposalChanges.id, id))

      // Pass 1 — create/update domain entities atomically.
      for (const change of databaseChanges) {
        if (change.entity === 'dependency') continue
        const ok = await applyChange(transactionDb, run.gameId, change.entity, change.op, JSON.parse(change.afterJson))
        await setStatus(change.id, ok)
        if (ok) applied++
      }

      // Pass 2 — link tasks created in pass 1, with a game-scoped cycle guard.
      const all = await tx.select({ id: tasks.id, title: tasks.title }).from(tasks).where(eq(tasks.gameId, run.gameId))
      const byTitle = new Map(all.map((task) => [task.title.trim().toLowerCase(), task.id]))
      const ids = all.map((task) => task.id)
      const deps = ids.length
        ? await tx
            .select()
            .from(taskDependencies)
            .where(and(inArray(taskDependencies.blockerTaskId, ids), inArray(taskDependencies.blockedTaskId, ids)))
        : []
      const adj = new Map<string, string[]>()
      const depKeys = new Set<string>()
      for (const dependency of deps) {
        adj.set(dependency.blockerTaskId, [...(adj.get(dependency.blockerTaskId) ?? []), dependency.blockedTaskId])
        depKeys.add(`${dependency.blockerTaskId}|${dependency.blockedTaskId}`)
      }
      const reaches = (from: string, to: string): boolean => {
        const stack = [from]
        const seen = new Set<string>()
        while (stack.length) {
          const id = stack.pop()!
          if (id === to) return true
          if (seen.has(id)) continue
          seen.add(id)
          for (const next of adj.get(id) ?? []) stack.push(next)
        }
        return false
      }
      for (const change of databaseChanges) {
        if (change.entity !== 'dependency') continue
        const after = JSON.parse(change.afterJson) as Record<string, unknown>
        const blocker = byTitle.get(str(after.blocker).toLowerCase())
        const blocked = byTitle.get(str(after.blocked).toLowerCase())
        const key = `${blocker}|${blocked}`
        if (!blocker || !blocked || blocker === blocked || reaches(blocked, blocker)) {
          await setStatus(change.id, false)
          continue
        }
        if (!depKeys.has(key)) {
          await tx
            .insert(taskDependencies)
            .values({ blockerTaskId: blocker, blockedTaskId: blocked })
            .onConflictDoNothing()
          adj.set(blocker, [...(adj.get(blocker) ?? []), blocked])
          depKeys.add(key)
          applied++
        }
        await setStatus(change.id, true)
      }
      await syncBlockedStatus(transactionDb, run.gameId)
    })

    // Filesystem work cannot participate in SQLite rollback. It stays pending
    // until the atomic DB phase commits, so a failed/retried apply is idempotent.
    for (const change of filesystemChanges) {
      const ok = writeMcpConfig(ctx.appPaths, JSON.parse(change.afterJson))
      await ctx.db
        .update(aiProposalChanges)
        .set({ status: ok ? 'applied' : 'rejected' })
        .where(eq(aiProposalChanges.id, change.id))
      if (ok) applied++
    }
    await ctx.db.update(aiRuns).set({ status: 'applied' }).where(eq(aiRuns.id, run.id))
    return { applied }
  }),

  rejectRun: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.update(aiProposalChanges).set({ status: 'rejected' }).where(eq(aiProposalChanges.runId, input.id))
    await ctx.db.update(aiRuns).set({ status: 'rejected' }).where(eq(aiRuns.id, input.id))
    return { ok: true }
  }),
})
