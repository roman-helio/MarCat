#!/usr/bin/env node
/**
 * MarCat MCP server (stdio). Wraps the same domain layer (tRPC caller over the
 * shared marcat.db) so an external agent — your own Claude Code / Codex — can
 * READ the plan and CHANGE it. Point it at the DB via the MARCAT_DB env var.
 */
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ACTIVITY_CHANNELS,
  ACTIVITY_DIRECTIONS,
  ACTIVITY_PLATFORMS,
  ACTIVITY_SUBJECTS,
  ACTIVITY_TYPES,
  OFFICIAL_LINK_TYPES,
  appRouter,
  backfillTaskDescriptionMarkdown,
  DrizzleWorkspaceRepository,
  MarkdownWorkspaceCoordinator,
} from '@marcat/core'
import {
  backfillTaskKeys,
  configureConnection,
  createDb,
  createVerifiedBackup,
  fileUrlFromPath,
  runMigrations,
  seedPublicFestivalCatalogue,
} from '@marcat/db'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
declare const __MARCAT_VERSION__: string

function formatToolError(error: unknown): string {
  const messages: string[] = []
  let current = error
  for (let depth = 0; current != null && depth < 12; depth += 1) {
    const code = typeof current === 'object' && 'code' in current ? String(current.code) : ''
    const message = current instanceof Error ? current.message : String(current)
    const detail = code && !message.includes(code) ? `${code}: ${message}` : message
    if (detail && !messages.includes(detail)) messages.push(detail)
    current = typeof current === 'object' && 'cause' in current ? (current as { cause?: unknown }).cause : undefined
  }
  return messages.join('\nCaused by: ') || 'Unknown error'
}

function dbPath(): string {
  if (process.env.MARCAT_DB) return process.env.MARCAT_DB
  const base = process.env.APPDATA || (process.env.HOME ? join(process.env.HOME, '.config') : '')
  if (!base) throw new Error('Set MARCAT_DB to the path of your marcat.db')
  const userData = join(base, 'MarCat')
  const marker = join(userData, 'active-db-path.txt')
  try {
    const markedPath = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : ''
    const resolvedUserData = resolve(userData)
    const resolvedMarkedPath = resolve(markedPath)
    if (markedPath && resolvedMarkedPath.startsWith(resolvedUserData) && fs.existsSync(resolvedMarkedPath)) {
      return resolvedMarkedPath
    }
  } catch {
    /* ignore invalid marker */
  }
  return join(userData, 'marcat.db')
}

async function backupBeforeMigrations(
  path: string,
  db: ReturnType<typeof createDb>['db'],
  client: ReturnType<typeof createDb>['client'],
  folder: string,
): Promise<void> {
  if (!fs.existsSync(path) || fs.statSync(path).size < 4096) return
  const available = fs.readdirSync(folder).filter((name) => /^\d+_.+\.sql$/.test(name)).length
  let applied = 0
  try {
    const result = await client.execute('SELECT count(*) AS count FROM __drizzle_migrations')
    applied = Number(result.rows[0]?.count ?? 0)
  } catch {
    applied = 0
  }
  if (applied >= available) return
  const integrity = await client.execute('PRAGMA integrity_check')
  if (String(integrity.rows[0]?.integrity_check ?? '') !== 'ok') {
    throw new Error('Database integrity check failed before migration')
  }
  const dir = join(dirname(path), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(dir, `marcat-pre-migration-mcp-${stamp}.db`)
  await createVerifiedBackup(db, dest)
}

async function main(): Promise<void> {
  const path = dbPath()
  const { db, client } = createDb(fileUrlFromPath(path))
  try {
    await configureConnection(client) // same WAL durability settings as the desktop app
    // Idempotent — ensures the schema exists if the desktop app never ran.
    const serverDir = dirname(resolve(process.argv[1]))
    const packagedMigrations = resolve(serverDir, '..', 'migrations')
    const workspaceMigrations = resolve(serverDir, '..', '..', 'db', 'migrations')
    const migrations = fs.existsSync(packagedMigrations) ? packagedMigrations : workspaceMigrations
    await backupBeforeMigrations(path, db, client, migrations)
    await runMigrations(db, client, migrations)
    const packagedFestivals = resolve(serverDir, '..', 'steam-festivals.json')
    if (fs.existsSync(packagedFestivals)) {
      const publicFestivals = JSON.parse(fs.readFileSync(packagedFestivals, 'utf8')) as unknown
      await seedPublicFestivalCatalogue(client, publicFestivals)
    }
    await backfillTaskKeys(db)
    await backfillTaskDescriptionMarkdown(db)
  } catch (e) {
    console.error('[marcat-mcp] database preparation failed:', e instanceof Error ? e.message : e)
    throw e
  }
  const workspace = new MarkdownWorkspaceCoordinator(new DrizzleWorkspaceRepository(db), {
    onError: (error) => console.error('[marcat-mcp] workspace sync failed:', error),
  })
  await workspace.start()
  const caller = appRouter.createCaller({ db, workspace })

  const run = async (fn: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await fn(), null, 2) }] }
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: ${formatToolError(e)}` }],
        isError: true,
      }
    }
  }

  const server = new McpServer({ name: 'marcat', version: __MARCAT_VERSION__ })
  const id = (what: string) =>
    z.string().min(1).describe(`${what} UUID returned by MarCat; do not use its display key.`)
  const day = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Calendar date in ISO YYYY-MM-DD format.')
  const nullableDay = day.nullable().describe('ISO date YYYY-MM-DD, or null to clear it.')
  const status = z
    .enum(['todo', 'doing', 'blocked', 'done', 'cancelled'])
    .describe(
      'Task workflow: todo=not started, doing=actively worked, blocked=unable to proceed, done=finished, cancelled=will not do.',
    )
  const priority = z
    .enum(['low', 'med', 'high', 'urgent'])
    .describe('Task urgency. Use urgent only when delay threatens a dated campaign outcome.')
  const recurrence = z
    .object({
      every: z.number().int().min(1).max(3650).describe('Positive interval count.'),
      unit: z.enum(['day', 'week', 'month', 'year']).describe('Calendar unit for the interval.'),
    })
    .describe(
      'Repeat schedule. Completing the task reopens it, clears its checklist and advances the due date to the next future occurrence.',
    )
  const tagType = z
    .enum(['release', 'festival', 'sale', 'update', 'track', 'other'])
    .describe('Tag/campaign kind. A targetDate, not the type, is what makes a tag a rescheduling deadline.')
  const pickStatus = z
    .enum(['none', 'materials', 'submitted', 'replied', 'approved', 'rejected'])
    .describe('Per-game festival pipeline: none → materials → submitted → replied → approved/rejected.')
  const pipelineStatus = z
    .enum(['prospect', 'contacted', 'replied', 'agreed', 'published', 'closed'])
    .describe('Per-game creator pipeline stage. closed requires a closedReason when known.')
  const gmassAddressCategory = z.enum(['verified_business', 'business', 'manager', 'other', 'gated'])
  const gmassCampaignInput = {
    gameId: id('Game'),
    creatorIds: z.array(id('Creator')).optional().describe('Omit to use every creator picked for the game.'),
    addressCategories: z
      .array(gmassAddressCategory)
      .min(1)
      .describe('Allowed email categories. doNotContact creators are always excluded.'),
    subject: z
      .string()
      .min(1)
      .describe('Supports {{creatorName}}, {{gameName}}, {{gameKeys}}, {{channel}} and {{email}}.'),
    body: z
      .string()
      .min(1)
      .describe('Supports {{creatorName}}, {{gameName}}, {{gameKeys}}, {{channel}} and {{email}}.'),
  }
  const activitySubject = z.enum(ACTIVITY_SUBJECTS).describe('The one MarCat object this journal entry belongs to.')
  const activityDirection = z
    .enum(ACTIVITY_DIRECTIONS)
    .describe(
      'Use only for correspondence: outbound=we contacted them, inbound=they contacted/replied to us. Never use for a social post.',
    )
  const activityChannel = z
    .enum(ACTIVITY_CHANNELS)
    .describe(
      'Correspondence medium. Valid only when direction is set; a subreddit/account/publication is placement, not channel.',
    )
  const activityType = z
    .enum(ACTIVITY_TYPES)
    .describe('Shape of a chart-visible marketing beat. A Reddit submission is post; its service is platform=reddit.')
  const activityPlatform = z
    .enum(ACTIVITY_PLATFORMS)
    .describe(
      'Normalized lowercase publishing service. Use the destination service, e.g. reddit for a Reddit post containing a YouTube link.',
    )
  const creatorTouchFields = {
    creatorId: id('Creator'),
    direction: activityDirection,
    channel: z
      .enum(['email', 'dm', 'form', 'call'])
      .describe('Actual correspondence medium; defaults are intentionally avoided.'),
    summary: z.string().optional().describe('Short factual touch headline.'),
    body: z
      .string()
      .nullable()
      .optional()
      .describe('Full sent/received text when known; preserve it verbatim rather than summarizing.'),
    occurredAt: day.optional(),
    statusAfter: pipelineStatus.optional(),
  }
  const projectCardLookup = {
    gameId: id('Game').optional().describe('Preferred when already known.'),
    key: z.string().min(1).max(10).optional().describe('Human project key such as SAS. Supply gameId or key.'),
  }
  const projectCardLink = z.object({
    label: z.string().min(1).describe('Human-readable link label.'),
    url: z.string().min(1).describe('Absolute URL.'),
  })
  const projectCardDoc = z.object({
    label: z.string().min(1).describe('Human-readable document label.'),
    path: z.string().optional().describe('Absolute or repository-relative local path.'),
    url: z.string().optional().describe('Remote document URL, when available.'),
  })
  const gamePlatform = z.object({
    id: z
      .enum(['pc_steam', 'pc_web', 'mobile', 'console'])
      .describe('Release/store platform, distinct from an activity publishing platform.'),
    url: z.string().optional().describe('Store page or playable build URL for this platform.'),
  })
  const officialLink = z.object({
    type: z
      .enum(OFFICIAL_LINK_TYPES)
      .describe('Canonical owned-presence kind. Steam/store targets belong in game platforms instead.'),
    url: z.string().min(1).describe('Absolute canonical public URL.'),
    label: z.string().optional().describe('Optional custom display label, mainly for type=other.'),
  })
  const creatorContact = z.object({
    type: z.string().describe('Contact kind such as email, dm or form.'),
    value: z.string().describe('Public/business contact address or URL.'),
    sourceUrl: z.string().optional().describe('Page where the contact was found.'),
    verified: z.boolean().optional().describe('Whether the contact was independently verified.'),
    gated: z.boolean().optional().describe('Whether access requires login/payment/another gate.'),
  })
  const creatorChannel = z.object({
    platform: z.string().describe('Channel platform, normalized lowercase when possible.'),
    url: z.string().describe('Canonical channel URL; used for identity and deduplication.'),
    handle: z.string().optional().describe('Public handle including @ when customary.'),
    subscribers: z.number().int().nonnegative().optional(),
    avgViews: z.number().int().nonnegative().optional(),
    lastPostAt: day.optional(),
    postsPerMonth: z.number().nonnegative().optional(),
  })
  const creatorFields = {
    name: z.string().min(1).describe('Creator or outlet display name.'),
    handle: z.string().nullable().optional().describe('Primary public handle or canonical channel URL.'),
    kind: z
      .string()
      .nullable()
      .optional()
      .describe('Creator/outlet kind, e.g. youtuber, streamer, journalist, publication.'),
    primaryPlatform: z.string().nullable().optional().describe('Normalized primary platform.'),
    channels: z.array(creatorChannel).optional().describe('All known public channels with per-channel metrics.'),
    audience: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Derived/known total audience; channel metrics are more precise.'),
    avgViews: z.number().int().nonnegative().nullable().optional().describe('Derived/known typical views.'),
    engagementRate: z.number().nonnegative().nullable().optional().describe('Ratio, e.g. 0.035 means 3.5%.'),
    lastActiveAt: day.nullable().optional(),
    cadencePerMonth: z.number().nonnegative().nullable().optional(),
    topics: z.array(z.string()).optional().describe('Genres/themes covered by the creator.'),
    playedGames: z.array(z.string()).optional().describe('Game titles the creator plays or has covered.'),
    language: z
      .string()
      .nullable()
      .optional()
      .describe('Primary content language, preferably BCP-47 or a clear language name.'),
    region: z.string().nullable().optional().describe('Audience/creator region.'),
    contacts: z
      .array(creatorContact)
      .optional()
      .describe('Public/business contacts only; never private personal data.'),
    costUsd: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Participation/collaboration cost in USD; 0 means free and null means unknown.'),
    rateUsd: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Deprecated alias for costUsd; prefer costUsd.'),
    acceptsKeysOnly: z
      .boolean()
      .nullable()
      .optional()
      .describe('True when the creator accepts unpaid game-key outreach.'),
    currency: z.string().nullable().optional().describe('Original quote currency code when not USD.'),
    rateNote: z.string().nullable().optional().describe('Scope/conditions attached to the quoted rate.'),
    doNotContact: z.boolean().nullable().optional().describe('Compliance flag: never contact when true.'),
    notes: z.string().nullable().optional().describe('Internal factual notes.'),
    description: z.string().nullable().optional().describe('Public-facing creator/outlet description.'),
  }
  const toCreatorInput = (a: Record<string, unknown>) => {
    const { topics, playedGames, contacts, channels, rateUsd, ...rest } = a
    const firstChannelUrl = Array.isArray(channels)
      ? (
          channels.find((channel) => channel && typeof channel === 'object' && 'url' in channel) as
            | { url?: unknown }
            | undefined
        )?.url
      : undefined
    return {
      ...rest,
      ...(rest.costUsd === undefined && rateUsd !== undefined ? { costUsd: rateUsd } : {}),
      ...(rest.handle == null && typeof firstChannelUrl === 'string' ? { handle: firstChannelUrl } : {}),
      ...(topics !== undefined ? { topicsJson: JSON.stringify(topics) } : {}),
      ...(playedGames !== undefined ? { playedGamesJson: JSON.stringify(playedGames) } : {}),
      ...(contacts !== undefined ? { contactsJson: JSON.stringify(contacts) } : {}),
      ...(channels !== undefined ? { channelsJson: JSON.stringify(channels) } : {}),
    }
  }
  const parseArray = (raw: unknown): unknown[] => {
    if (typeof raw !== 'string') return []
    try {
      const value = JSON.parse(raw)
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  }
  const presentCreator = <
    T extends { topicsJson?: unknown; playedGamesJson?: unknown; contactsJson?: unknown; channelsJson?: unknown },
  >(
    row: T,
  ) => ({
    ...row,
    topics: parseArray(row.topicsJson),
    playedGames: parseArray(row.playedGamesJson),
    contacts: parseArray(row.contactsJson),
    channels: parseArray(row.channelsJson),
  })
  const festivalInput = {
    name: z.string().min(1).describe('Official event/festival/showcase/sale name.'),
    startDate: day.describe('First public event day, not the application deadline.'),
    type: z.string().optional().describe('Catalogue category such as festival, showcase, conference or sale.'),
    endDate: nullableDay.optional().describe('Last public event day; null for a one-day/unknown range.'),
    applyDeadline: nullableDay.optional().describe('Submission/application deadline, distinct from startDate.'),
    url: z.string().nullable().optional().describe('Official public information page.'),
    applyUrl: z.string().nullable().optional().describe('Direct submission/application page.'),
    organizer: z.string().nullable().optional().describe('Organization running the event.'),
    description: z.string().nullable().optional().describe('Public factual event description.'),
    notes: z.string().nullable().optional().describe('Internal planning/research notes.'),
    steamEvent: z.string().nullable().optional().describe('Related Steam event/category when applicable.'),
    steamFeature: z.string().nullable().optional().describe('Promised/available Steam featuring placement.'),
    media: z
      .boolean()
      .nullable()
      .optional()
      .describe('Whether press/media participation is a material part of the event.'),
    offline: z.boolean().nullable().optional().describe('True for an in-person/offline event.'),
    costUsd: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Participation cost in USD; 0 means free and null means unknown.'),
    feeUsd: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Deprecated alias for costUsd; prefer costUsd.'),
  }
  const festivalPatch = {
    id: id('Festival'),
    name: festivalInput.name.optional(),
    startDate: festivalInput.startDate.optional(),
    type: festivalInput.type,
    endDate: festivalInput.endDate,
    applyDeadline: festivalInput.applyDeadline,
    url: festivalInput.url,
    applyUrl: festivalInput.applyUrl,
    organizer: festivalInput.organizer,
    description: festivalInput.description,
    notes: festivalInput.notes,
    steamEvent: festivalInput.steamEvent,
    steamFeature: festivalInput.steamFeature,
    media: festivalInput.media,
    offline: festivalInput.offline,
    costUsd: festivalInput.costUsd,
    feeUsd: festivalInput.feeUsd,
  }
  const activityStatusAfter = z
    .enum([
      'none',
      'materials',
      'submitted',
      'replied',
      'approved',
      'rejected',
      'prospect',
      'contacted',
      'agreed',
      'published',
      'closed',
    ])
    .describe(
      'Optional atomic pipeline transition. Use festival statuses only for subjectType=festival and creator stages only for subjectType=creator; omit for project/task.',
    )
  const activityFields = {
    occurredAt: day.optional().describe('When the activity happened; defaults to today.'),
    subjectType: activitySubject.optional().describe('Defaults to project.'),
    subjectId: z.string().nullable().optional().describe('Required UUID for task/festival/creator; null for project.'),
    title: z
      .string()
      .max(300)
      .optional()
      .describe('Short factual headline. If omitted, the first non-empty body line becomes the title.'),
    body: z
      .string()
      .optional()
      .describe(
        'Full note, message, post copy or outcome. Preserve the complete known text; do not replace it with a summary.',
      ),
    direction: activityDirection.nullable().optional(),
    channel: activityChannel.nullable().optional(),
    statusAfter: activityStatusAfter.nullable().optional(),
    showOnWishlist: z
      .boolean()
      .optional()
      .describe(
        'True only for an actually occurred marketing beat that should be correlated with wishlist changes; false for drafts, prep and ordinary notes.',
      ),
    type: activityType.optional(),
    platform: activityPlatform.nullable().optional(),
    placement: z
      .string()
      .max(300)
      .nullable()
      .optional()
      .describe(
        'Destination inside the platform: subreddit (r/CityBuilders), account/handle, Steam News hub, publication or community. Never put this in channel.',
      ),
    url: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe('Canonical URL of the published item or referenced result.'),
    views: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Latest known view/impression count; null when unknown, never guess.'),
    likes: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Latest known likes/upvotes; null when unknown.'),
    comments: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Latest known comments/replies; null when unknown.'),
    isOwn: z
      .boolean()
      .optional()
      .describe(
        'True for content/message published by the game team; false for third-party coverage or inbound correspondence.',
      ),
  }
  const validateActivity = (a: Record<string, unknown>) => {
    if (!a.direction && a.channel)
      throw new Error('channel requires correspondence direction; use placement for a subreddit/account/publication')
    if (a.direction && !a.channel) throw new Error('Correspondence direction requires channel')
    if (a.statusAfter && !['festival', 'creator'].includes(String(a.subjectType ?? 'project'))) {
      throw new Error('statusAfter is valid only for festival or creator activities')
    }
    if (a.showOnWishlist && a.direction) {
      throw new Error('Wishlist-chart marketing beats cannot be correspondence; clear direction/channel')
    }
    if (a.showOnWishlist && ['post', 'video', 'stream'].includes(String(a.type ?? 'other')) && !a.platform) {
      throw new Error('A chart-visible post/video/stream requires normalized platform')
    }
  }

  // ---------- read ----------
  server.registerTool('list_games', { description: 'List all games (workspaces).' }, () =>
    run(() => caller.games.list()),
  )
  server.registerTool(
    'get_game',
    {
      description:
        'Get the canonical game/workspace fields, including project key, release date, store platforms/URLs, archive state and derived Steam identifiers.',
      inputSchema: { id: id('Game') },
    },
    ({ id }) => run(() => caller.games.get({ id })),
  )
  server.registerTool(
    'get_project_card',
    {
      description:
        'Get the one-call project card for an agent: stable project facts, owner notes, an insight title catalogue, useful links/docs, deadlines, current tasks, festivals, recent activity, chart events and wishlist state. Use get_insight to load the full text of a relevant insight. Pass key like "SAS" when known; gameId also works.',
      inputSchema: projectCardLookup,
    },
    (a) => run(() => caller.projectCards.get(a)),
  )
  server.registerTool(
    'get_workspace_status',
    {
      description:
        'Get Markdown workspace availability, pending writes, conflicts, missing files and synchronization health for a project.',
      inputSchema: { gameId: id('Game') },
    },
    (a) => run(() => caller.workspace.status(a)),
  )
  server.registerTool(
    'rescan_workspace',
    {
      description:
        'Reconcile a configured Markdown workspace now. External edits are imported; missing files are reported and never delete database records.',
      inputSchema: { gameId: id('Game') },
    },
    (a) => run(() => caller.workspace.reconcile(a)),
  )
  server.registerTool(
    'list_workspace_issues',
    {
      description: 'List unresolved Markdown workspace conflicts, invalid documents and missing-file decisions.',
      inputSchema: { gameId: id('Game') },
    },
    (a) => run(() => caller.workspace.issues(a)),
  )
  server.registerTool(
    'get_workspace_paths',
    {
      description: 'Get the validated absolute workspace root and registered Markdown document paths.',
      inputSchema: { gameId: id('Game') },
    },
    (a) => run(() => caller.workspace.paths(a)),
  )
  server.registerTool(
    'list_insights',
    {
      description:
        "List a game's insight catalogue. The mandatory «Карточка проекта» entry is always first; use its id with update_insight to fill it. Use other ids to fetch only relevant full notes with get_insight before planning or analysis.",
      inputSchema: {
        gameId: id('Game'),
        search: z.string().optional().describe('Optional title search; full note bodies are not searched or returned.'),
      },
    },
    (a) => run(() => caller.insights.catalog(a)),
  )
  server.registerTool(
    'get_insight',
    {
      description: 'Get one project insight with its full Markdown body and provenance.',
      inputSchema: { id: id('Insight') },
    },
    (a) => run(() => caller.insights.get(a)),
  )
  server.registerTool(
    'list_tasks',
    {
      description:
        'List tasks. A legacy call with only gameId returns the original full project list. For fast compact results, pass search/filters/detail/limit, or prefer search_tasks when looking for a specific task. Omit gameId to list across all games.',
      inputSchema: {
        gameId: z.string().optional(),
        search: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Case-insensitive title, description or task-key search.'),
        statuses: z.array(status).min(1).max(5).optional(),
        priorities: z.array(priority).min(1).max(4).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        detail: z.enum(['short', 'full']).optional().describe('Filtered calls default to compact short results.'),
      },
    },
    ({ gameId, search, statuses, priorities, limit, offset, detail }) =>
      run(() => {
        const filtered =
          search !== undefined ||
          statuses !== undefined ||
          priorities !== undefined ||
          limit !== undefined ||
          offset !== undefined ||
          detail !== undefined
        return filtered
          ? caller.tasks.search({ gameId, query: search, statuses, priorities, limit, offset, detail })
          : gameId
            ? caller.tasks.list({ gameId })
            : caller.tasks.all()
      }),
  )

  server.registerTool(
    'search_tasks',
    {
      description:
        'Search tasks in SQLite before returning data. Use this instead of list_tasks for finding work by title, description or Jira-style key; results are compact and paginated by default, then get_task can load the selected full record.',
      inputSchema: {
        query: z.string().min(1).max(200),
        gameId: z.string().optional(),
        statuses: z.array(status).min(1).max(5).optional(),
        priorities: z.array(priority).min(1).max(4).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Defaults to 20.'),
        offset: z.number().int().min(0).optional().describe('Defaults to 0.'),
        detail: z.enum(['short', 'full']).optional().describe('Defaults to short; use get_task for full details.'),
      },
    },
    ({ query, gameId, statuses, priorities, limit, offset, detail }) =>
      run(() => caller.tasks.search({ query, gameId, statuses, priorities, limit, offset, detail })),
  )

  server.registerTool(
    'get_next_actions',
    {
      description:
        'Get a deterministic, checklist-aware focus queue for one game. Use this for “what should I do now?” instead of freely summarizing list_tasks. It favors important in-progress work that is close to done, overdue actionable tasks, and blockers that unlock downstream work.',
      inputSchema: {
        gameId: id('Game'),
        limit: z.number().int().min(1).max(10).optional().describe('Number of focus items; defaults to 5.'),
      },
    },
    ({ gameId, limit }) => run(() => caller.tasks.focus({ gameId, limit })),
  )
  server.registerTool(
    'get_task',
    {
      description: 'Get one task with its checklist, blockers, blocked-tasks and tags.',
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(() => caller.tasks.get({ id })),
  )
  server.registerTool(
    'list_dependencies',
    {
      description: "List dependency edges (blocker -> blocked) among a game's tasks.",
      inputSchema: { gameId: z.string() },
    },
    ({ gameId }) => run(() => caller.tasks.listDependencies({ gameId })),
  )
  server.registerTool(
    'list_tags',
    {
      description:
        "List a game's tags with linked-task progress. A tag with targetDate is a rescheduling deadline; moving it shifts dated tagged tasks and their blocker chain.",
      inputSchema: { gameId: z.string() },
    },
    ({ gameId }) => run(() => caller.tags.withStatus({ gameId })),
  )
  server.registerTool(
    'list_events',
    { description: "List a game's marketing events.", inputSchema: { gameId: z.string() } },
    ({ gameId }) => run(() => caller.events.list({ gameId })),
  )
  server.registerTool(
    'list_activities',
    {
      description:
        'List the dated project activity journal. Filter by task/festival/creator, text, date range, or wishlist-chart visibility.',
      inputSchema: {
        gameId: z.string(),
        subjectType: activitySubject.optional(),
        subjectId: z.string().nullable().optional(),
        wishlistOnly: z.boolean().optional(),
        search: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    (a) => run(() => caller.activities.list(a)),
  )
  server.registerTool(
    'get_activity',
    { description: 'Get one activity with its full body and linked subject.', inputSchema: { id: z.string() } },
    (a) => run(() => caller.activities.get(a)),
  )
  server.registerTool(
    'get_wishlist_series',
    {
      description:
        'Wishlist time series. adds/deletes/gifts/net are period changes; balance is the running total; null means unknown, not zero. source/importBatchId preserve provenance.',
      inputSchema: { gameId: id('Game') },
    },
    ({ gameId }) => run(() => caller.wishlists.series({ gameId })),
  )
  server.registerTool(
    'get_wishlist_impact',
    {
      description:
        'Correlate chart-visible activities with wishlist adds over a trailing baseline and post-event window. This is heuristic correlation, not causal attribution.',
      inputSchema: {
        gameId: id('Game'),
        windowDays: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Days after each event; defaults to Steam UTM’s 72-hour window (3 days).'),
      },
    },
    (a) => run(() => caller.analytics.impact(a)),
  )
  server.registerTool(
    'list_utm_links',
    {
      description:
        'List generated UTM links. source identifies the traffic origin, medium the channel class, campaign the initiative, content the creative/placement variant, and term the optional targeting keyword.',
      inputSchema: { gameId: id('Game') },
    },
    (a) => run(() => caller.utm.list(a)),
  )
  server.registerTool(
    'list_sources',
    {
      description:
        'List configured import sources for a game, including platform, handle/folder, enabled state and last sync result. API keys are intentionally never returned.',
      inputSchema: { gameId: id('Game') },
    },
    (a) => run(() => caller.sources.list(a)),
  )
  server.registerTool(
    'list_source_platforms',
    {
      description:
        'List supported source connector platforms with provider, key requirement and estimated per-request cost.',
    },
    () => run(() => caller.sources.platforms()),
  )
  server.registerTool(
    'list_comments',
    {
      description:
        'List normalized player reviews/comments imported into a game inbox. Filter by configured source or workflow status when useful.',
      inputSchema: {
        gameId: id('Game'),
        sourceId: id('Source').optional(),
        status: z.enum(['unread', 'open', 'replied', 'ignored']).optional(),
      },
    },
    (a) => run(() => caller.comments.list(a)),
  )
  server.registerTool(
    'get_source_history',
    {
      description: 'Get the latest sync runs for one source: status, imported row count, cost and errors.',
      inputSchema: { sourceId: id('Source') },
    },
    (a) => run(() => caller.sources.history(a)),
  )
  server.registerTool(
    'get_source_spend',
    {
      description:
        "Get today's paid-provider request count, spend and configured daily budget. API keys are never exposed.",
    },
    () => run(() => caller.sources.spend()),
  )
  server.registerTool(
    'list_festivals',
    {
      description:
        'List the shared industry-event catalogue: Steam festivals, showcases, conferences and sales, including costUsd participation cost.',
    },
    () => run(() => caller.festivals.list()),
  )
  server.registerTool(
    'list_festival_picks',
    {
      description: 'List the festivals a game has picked, with prep/submission status.',
      inputSchema: { gameId: z.string() },
    },
    ({ gameId }) => run(() => caller.festivals.picks({ gameId })),
  )
  server.registerTool(
    'list_festival_participation',
    { description: 'List all game participation/status rows for the shared festival catalogue.' },
    () => run(() => caller.festivals.participation()),
  )

  // ---------- write ----------
  server.registerTool(
    'create_game',
    {
      description:
        'Create a game/workspace. The project key is the shared prefix for MarCat task keys and DevHub lookup; release platforms are store/build targets, not social publishing platforms.',
      inputSchema: {
        name: z.string().min(1).max(120).describe('Game/project display name.'),
        key: z
          .string()
          .max(10)
          .optional()
          .describe('Short uppercase project key such as SAS; normalized and made unique.'),
        releaseDate: nullableDay.optional().describe('Planned/actual release date, or null when unset.'),
        platforms: z
          .array(gamePlatform)
          .optional()
          .describe('Enabled release/store platforms with their canonical URLs.'),
        officialLinks: z
          .array(officialLink)
          .optional()
          .describe(
            'Official website, social, community and press-kit pages agents should treat as canonical sources. Store targets belong in platforms.',
          ),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe('Workspace color as #RRGGBB.'),
      },
    },
    (a) => run(() => caller.games.create(a)),
  )
  server.registerTool(
    'update_game',
    {
      description:
        'Update canonical game/workspace fields. Replacing platforms replaces the whole platform list; changing key relabels task display keys. archived hides the workspace without deleting it.',
      inputSchema: {
        id: id('Game'),
        name: z.string().min(1).max(120).optional(),
        key: z.string().max(10).nullable().optional(),
        releaseDate: nullableDay.optional(),
        platforms: z.array(gamePlatform).optional(),
        officialLinks: z
          .array(officialLink)
          .optional()
          .describe(
            'Replaces the complete canonical official-link list. Preserve existing entries that should remain.',
          ),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        archived: z.boolean().optional(),
      },
    },
    ({ id, ...patch }) => run(() => caller.games.update({ id, patch })),
  )
  server.registerTool(
    'create_task',
    {
      description:
        'Create a task in a game. Description accepts Markdown; paragraphs and lists are preserved. Use recurrence for routine checks that should reopen after each completion.',
      inputSchema: {
        gameId: id('Game'),
        title: z.string().min(1).max(200).describe('One concrete outcome/action, not a campaign heading.'),
        description: z.string().optional().describe('Task details in Markdown or plain text.'),
        priority: priority.optional(),
        dueDate: nullableDay.optional().describe('Completion deadline; null/omitted means unscheduled.'),
        recurrence: recurrence.optional(),
      },
    },
    (a) => run(() => caller.tasks.create(a)),
  )
  server.registerTool(
    'update_project_card',
    {
      description:
        'Create or update the owner-maintained project card fields. Use this for durable common project context, not per-task notes.',
      inputSchema: {
        ...projectCardLookup,
        oneLiner: z
          .string()
          .optional()
          .describe('Stable one-sentence product pitch, not a temporary campaign message.'),
        description: z.string().optional().describe('Durable product/project overview.'),
        audience: z.string().optional().describe('Who the game is for, including known audience segments.'),
        positioning: z.string().optional().describe('Differentiation, category and comparison context.'),
        repository: z.string().optional().describe('Canonical source repository URL or absolute path.'),
        branch: z.string().optional().describe('Current/default working branch relevant to agents.'),
        devhubWikiUrl: z.string().optional().describe('Canonical DevHub/project knowledge URL.'),
        agentNotes: z
          .string()
          .optional()
          .describe(
            'Stable owner-approved instructions/facts for future agents; do not put transient task progress here.',
          ),
        links: z.array(projectCardLink).optional().describe('Replace the complete curated link list.'),
        docs: z.array(projectCardDoc).optional().describe('Replace the complete curated document list.'),
      },
    },
    (a) => run(() => caller.projectCards.update({ ...a, updatedBy: 'mcp' })),
  )
  server.registerTool(
    'create_insight',
    {
      description:
        'Create durable project knowledge such as an audience finding, experiment conclusion or validated/rejected hypothesis. Use an activity instead for a dated event or correspondence.',
      inputSchema: {
        gameId: id('Game'),
        title: z.string().min(1).max(240).describe('Specific, scannable conclusion or question.'),
        body: z.string().min(1).describe('Full evidence, reasoning and implications in Markdown or plain text.'),
      },
    },
    (a) => run(() => caller.insights.create({ ...a, createdBy: 'mcp' })),
  )
  server.registerTool(
    'update_insight',
    {
      description:
        'Update an existing insight after new evidence or a hypothesis check. Fetch it first with get_insight. The required «Карточка проекта» insight is filled through this tool too; its title is fixed.',
      inputSchema: {
        id: id('Insight'),
        title: z.string().min(1).max(240).optional(),
        body: z.string().min(1).optional(),
      },
    },
    (a) => run(() => caller.insights.update({ ...a, updatedBy: 'mcp' })),
  )
  server.registerTool(
    'delete_insight',
    {
      description: 'Delete one ordinary project insight. The required «Карточка проекта» insight cannot be deleted.',
      inputSchema: { id: id('Insight') },
    },
    (a) => run(() => caller.insights.remove(a)),
  )
  server.registerTool(
    'update_task',
    {
      description:
        'Update a task (priority, dates, title, description, recurrence, or non-final status). Set recurrence to an interval to enable repetition, or null to disable it. Markdown descriptions are supported. When finishing work, prefer complete_task so checklist items and the parent status are reconciled atomically.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        status: status.optional(),
        priority: priority.optional(),
        startDate: nullableDay.optional(),
        dueDate: nullableDay.optional(),
        reminderAt: z.string().nullable().optional().describe('Optional reminder timestamp/date; null clears it.'),
        recurrence: recurrence.nullable().optional(),
        description: z.string().optional().describe('Task details in Markdown or plain text.'),
      },
    },
    ({ id, ...patch }) =>
      run(() => {
        if (patch.status === 'done') {
          throw new Error('Use complete_task to reconcile checklist items and blockers before closing a task')
        }
        return caller.tasks.update({ id, patch })
      }),
  )
  server.registerTool(
    'add_dependency',
    {
      description: 'Link two tasks: blocker must finish before blocked. Rejected if it would create a cycle.',
      inputSchema: { blockerTaskId: z.string(), blockedTaskId: z.string() },
    },
    (a) => run(() => caller.tasks.addDependency(a)),
  )
  server.registerTool(
    'remove_dependency',
    { description: 'Remove a dependency edge by its id.', inputSchema: { id: z.string() } },
    (a) => run(() => caller.tasks.removeDependency(a)),
  )
  server.registerTool(
    'add_checklist_item',
    {
      description:
        'Add a small sub-step inside a task. Use a separate task instead when it needs its own owner/status/dependencies.',
      inputSchema: { taskId: id('Task'), text: z.string().min(1) },
    },
    (a) => run(() => caller.tasks.addChecklistItem(a)),
  )
  server.registerTool(
    'set_checklist_item',
    {
      description:
        'Set one checklist item complete/incomplete after verifying the work. This does not complete the parent task automatically; use complete_task for the final reconciliation pass.',
      inputSchema: { id: id('Checklist item'), done: z.boolean() },
    },
    (a) => run(() => caller.tasks.toggleChecklistItem(a)),
  )

  server.registerTool(
    'complete_task',
    {
      description:
        'Finish a task safely. Pass the checklist item UUIDs whose work was actually verified in this session. MarCat marks those items done and closes the parent atomically only when no checklist items or blockers remain. A recurring task instead reopens as todo, clears its checklist and returns nextDueDate. Re-read the result before reporting completion.',
      inputSchema: {
        id: id('Task'),
        completedChecklistItemIds: z
          .array(id('Checklist item'))
          .optional()
          .describe('Only items whose underlying work was verified; omit for a task with no checklist.'),
      },
    },
    (a) => run(() => caller.tasks.complete(a)),
  )
  server.registerTool(
    'delete_checklist_item',
    { description: 'Delete one checklist item, not its parent task.', inputSchema: { id: id('Checklist item') } },
    (a) => run(() => caller.tasks.removeChecklistItem(a)),
  )
  server.registerTool(
    'create_tag',
    {
      description: 'Create a tag. Set targetDate (YYYY-MM-DD) to make it a dated deadline (countdown + cascade).',
      inputSchema: {
        gameId: id('Game'),
        name: z.string(),
        color: z.string().optional(),
        colorEnabled: z.boolean().optional(),
        targetDate: nullableDay.optional(),
        type: tagType.optional(),
      },
    },
    (a) => run(() => caller.tags.create(a)),
  )
  server.registerTool(
    'update_tag',
    {
      description:
        'Update a tag (name, color, colour highlighting, deadline date). Moving the date shifts tagged tasks + their blockers.',
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        color: z.string().optional(),
        colorEnabled: z.boolean().optional(),
        targetDate: nullableDay.optional(),
        type: tagType.optional(),
      },
    },
    ({ id, ...patch }) => run(() => caller.tags.update({ id, patch })),
  )
  server.registerTool(
    'assign_tag',
    { description: 'Attach a tag to a task.', inputSchema: { taskId: z.string(), tagId: z.string() } },
    (a) => run(() => caller.tasks.assignTag(a)),
  )
  server.registerTool(
    'unassign_tag',
    { description: 'Remove a tag from a task.', inputSchema: { taskId: z.string(), tagId: z.string() } },
    (a) => run(() => caller.tasks.unassignTag(a)),
  )
  server.registerTool(
    'add_wishlist_point',
    {
      description:
        'Upsert one manual wishlist data point by game+date. Use null for unknown values and 0 only for a known zero. adds/deletes/gifts/net are changes; balance is the running total.',
      inputSchema: {
        gameId: id('Game'),
        date: day,
        adds: z.number().int().nonnegative().nullable().optional(),
        deletes: z.number().int().nonnegative().nullable().optional(),
        gifts: z.number().int().nonnegative().nullable().optional(),
        balance: z.number().int().nonnegative().nullable().optional(),
        net: z.number().int().nullable().optional().describe('Net change; may be negative.'),
      },
    },
    (a) => run(() => caller.wishlists.addPoint(a)),
  )
  server.registerTool(
    'build_utm_link',
    {
      description:
        'Build and save a traceable campaign URL. Use stable normalized naming: source=origin/service, medium=channel class, campaign=initiative, content=creative or placement variant, term=optional keyword/audience.',
      inputSchema: {
        gameId: id('Game'),
        label: z.string().min(1).max(80).describe('Human label for this exact link variant.'),
        baseUrl: z.string().min(1).describe('Destination URL without these UTM parameters.'),
        utmSource: z.string().min(1).describe('Traffic origin/service, e.g. reddit, newsletter, creator_name.'),
        utmMedium: z.string().min(1).describe('Channel class, e.g. social, email, influencer, press.'),
        utmCampaign: z.string().min(1).describe('Stable campaign identifier shared across its link variants.'),
        utmContent: z
          .string()
          .nullable()
          .optional()
          .describe('Creative, placement or CTA variant, e.g. r_citybuilders_youtube_link.'),
        utmTerm: z.string().nullable().optional().describe('Optional targeting keyword/audience segment.'),
        eventId: id('Activity')
          .nullable()
          .optional()
          .describe('Chart-visible activity this link belongs to, when already known.'),
      },
    },
    (a) => run(() => caller.utm.build(a)),
  )
  server.registerTool(
    'create_source',
    {
      description:
        'Configure an import source. handle is a Steam CSV folder, social handle, public feedback page, package name or app id depending on platform. This never stores API keys.',
      inputSchema: {
        gameId: id('Game'),
        platform: z.enum([
          'steam',
          'twitter',
          'instagram',
          'tiktok',
          'youtube',
          'reddit',
          'telegram',
          'steam_reviews',
          'google_play_reviews',
          'itch_comments',
          'gamejolt_comments',
          'poki_comments',
          'crazygames_comments',
          'incrementaldb_comments',
        ]),
        handle: z.string().min(1).describe('Connector target: folder, handle, public URL, package name or app id.'),
        displayName: z.string().optional().describe('Optional human label for the source.'),
      },
    },
    (a) => run(() => caller.sources.create(a)),
  )
  server.registerTool(
    'set_comment_status',
    {
      description:
        'Update the human workflow state of one imported player comment. Never mark replied unless a human has actually replied.',
      inputSchema: {
        id: id('Comment'),
        status: z.enum(['unread', 'open', 'replied', 'ignored']),
      },
    },
    (a) => run(() => caller.comments.setStatus(a)),
  )
  server.registerTool(
    'update_source',
    {
      description:
        'Update a source handle/folder, display label or enabled state. API keys and provider budgets belong to Settings and are intentionally outside this tool.',
      inputSchema: {
        id: id('Source'),
        handle: z.string().optional(),
        displayName: z.string().nullable().optional(),
        enabled: z.boolean().optional(),
      },
    },
    ({ id, ...patch }) => run(() => caller.sources.update({ id, patch })),
  )
  server.registerTool(
    'create_event',
    {
      description:
        'DEPRECATED compatibility alias for a project-level, wishlist-chart-visible activity. Prefer create_activity so subject, full text, placement, ownership and metrics are explicit. Do not use for prep/drafts/notes.',
      inputSchema: {
        gameId: id('Game'),
        occurredAt: day,
        type: activityType,
        title: z.string().min(1).max(300),
        body: z.string().optional().describe('Full known content/outcome text.'),
        platform: activityPlatform.nullable().optional(),
        placement: z.string().max(300).nullable().optional(),
        url: z.string().max(2000).nullable().optional(),
        views: z.number().int().nonnegative().nullable().optional(),
        likes: z.number().int().nonnegative().nullable().optional(),
        comments: z.number().int().nonnegative().nullable().optional(),
        isOwn: z.boolean().optional(),
      },
    },
    (a) =>
      run(() => {
        validateActivity({ ...a, subjectType: 'project', showOnWishlist: true })
        return caller.activities.create({
          ...a,
          subjectType: 'project',
          subjectId: null,
          showOnWishlist: true,
          createdBy: 'ai',
        })
      }),
  )
  server.registerTool(
    'create_activity',
    {
      description:
        'Create one journal activity. Preserve all known facts in their semantic fields. Social/public content uses type+platform+placement+body+url and has no direction/channel. Correspondence uses direction+channel and normally showOnWishlist=false. statusAfter is only an atomic festival/creator pipeline transition. MCP entries are recorded as createdBy=ai.',
      inputSchema: {
        gameId: id('Game'),
        ...activityFields,
      },
    },
    (a) =>
      run(() => {
        validateActivity(a)
        return caller.activities.create({ ...a, subjectType: a.subjectType ?? 'project', createdBy: 'ai' })
      }),
  )
  server.registerTool(
    'update_activity',
    {
      description: 'Edit an existing activity, including its text, date, subject, or wishlist-chart flag.',
      inputSchema: {
        id: id('Activity'),
        ...activityFields,
      },
    },
    ({ id, ...patch }) =>
      run(async () => {
        const current = await caller.activities.get({ id })
        if (!current) throw new Error('Activity not found')
        validateActivity({ ...current, ...patch })
        return caller.activities.update({ id, patch })
      }),
  )
  server.registerTool(
    'delete_activity',
    { description: 'Delete one activity by id.', inputSchema: { id: z.string() } },
    (a) => run(() => caller.activities.remove(a)),
  )
  server.registerTool(
    'create_festival',
    {
      description:
        'Create one shared festival/showcase/sale. Dates must be ISO YYYY-MM-DD; use endDate for ranges and applyDeadline for submission deadline.',
      inputSchema: festivalInput,
    },
    (a) => run(() => caller.festivals.create(a)),
  )
  server.registerTool(
    'update_festival',
    {
      description: 'Update one shared festival by id. Use null to clear optional fields. Dates must be ISO YYYY-MM-DD.',
      inputSchema: festivalPatch,
    },
    ({ id, ...patch }) => run(() => caller.festivals.update({ id, ...patch })),
  )
  server.registerTool(
    'import_festivals',
    {
      description:
        'Bulk upsert shared festivals from a structured source. Upserts by normalized name + startDate, so repeated imports update instead of duplicating.',
      inputSchema: { items: z.array(z.object(festivalInput)).min(1) },
    },
    ({ items }) => run(() => caller.festivals.importMany({ items })),
  )
  server.registerTool(
    'pick_festival',
    {
      description: 'Mark a shared festival as relevant for a game.',
      inputSchema: { gameId: z.string(), industryEventId: z.string() },
    },
    (a) => run(() => caller.festivals.pick(a)),
  )
  server.registerTool(
    'unpick_festival',
    {
      description: 'Remove a shared festival from a game.',
      inputSchema: { gameId: z.string(), industryEventId: z.string() },
    },
    (a) => run(() => caller.festivals.unpick(a)),
  )
  server.registerTool(
    'set_festival_status',
    {
      description: 'Set a game-specific festival status: none/materials/submitted/replied/approved/rejected.',
      inputSchema: { gameId: z.string(), industryEventId: z.string(), status: pickStatus },
    },
    (a) => run(() => caller.festivals.setStatus(a)),
  )

  // ---------- influencers / creators ----------
  server.registerTool(
    'list_creators',
    {
      description:
        'List the global creator/influencer catalogue (shared across games), including costUsd participation/collaboration cost.',
    },
    () => run(async () => (await caller.creators.list()).map(presentCreator)),
  )
  server.registerTool(
    'get_creator',
    {
      description:
        'Get every stored catalogue field for one creator/outlet, including costUsd. JSON fields contain channel, topic and public-contact arrays.',
      inputSchema: { id: id('Creator') },
    },
    (a) =>
      run(async () => {
        const row = await caller.creators.get(a)
        return row ? presentCreator(row) : null
      }),
  )
  server.registerTool(
    'list_creator_picks',
    {
      description: 'List the creators a game picked, with pipeline status and the game keys sent for this project.',
      inputSchema: { gameId: z.string() },
    },
    ({ gameId }) =>
      run(async () =>
        (await caller.creators.picks({ gameId })).map((pick) => ({
          ...pick,
          keysSent: parseArray(pick.keysSentJson),
        })),
      ),
  )
  server.registerTool(
    'list_creator_touches',
    {
      description:
        'List correspondence journal entries for one creator in one game. direction/channel describe communication; these are never wishlist-chart events.',
      inputSchema: { gameId: id('Game'), creatorId: id('Creator') },
    },
    (a) => run(() => caller.creators.touches(a)),
  )
  server.registerTool(
    'create_creator',
    {
      description:
        'Add a creator/outlet to the shared catalogue. Identity is deduplicated by canonical channel URL. Supply structured channels/topics/playedGames/public business contacts; never encode JSON manually and never store private personal data.',
      inputSchema: creatorFields,
    },
    (a) => run(() => caller.creators.create(toCreatorInput(a) as Parameters<typeof caller.creators.create>[0])),
  )
  server.registerTool(
    'update_creator',
    {
      description:
        'Update any creator/outlet catalogue facts. Structured channels/topics/playedGames/contacts replace their whole stored arrays when supplied; omit a field to preserve it and use null to clear nullable scalar fields.',
      inputSchema: {
        id: id('Creator'),
        ...Object.fromEntries(Object.entries(creatorFields).map(([key, value]) => [key, value.optional()])),
      },
    },
    ({ id, ...fields }) =>
      run(() =>
        caller.creators.update({
          id,
          ...(toCreatorInput(fields) as Omit<Parameters<typeof caller.creators.update>[0], 'id'>),
        }),
      ),
  )
  server.registerTool(
    'pick_creator',
    {
      description: "Pick a catalogue creator into a game's outreach pipeline.",
      inputSchema: {
        gameId: z.string(),
        creatorId: z.string(),
        keysSent: z.array(z.string()).optional().describe('Game/product keys already sent for this project.'),
      },
    },
    ({ keysSent, ...a }) =>
      run(() =>
        caller.creators.pick({
          ...a,
          addedBy: 'ai',
          ...(keysSent !== undefined ? { keysSentJson: JSON.stringify(keysSent) } : {}),
        }),
      ),
  )
  server.registerTool(
    'update_creator_keys',
    {
      description: 'Replace the game/product keys recorded as sent to one creator for one project.',
      inputSchema: {
        gameId: id('Game'),
        creatorId: id('Creator'),
        keysSent: z.array(z.string()).describe('Complete replacement list; use an empty array to clear.'),
      },
    },
    ({ keysSent, ...a }) => run(() => caller.creators.updatePick({ ...a, keysSentJson: JSON.stringify(keysSent) })),
  )
  server.registerTool(
    'unpick_creator',
    {
      description: 'Remove a creator from one game outreach pipeline without deleting the shared catalogue entry.',
      inputSchema: { gameId: id('Game'), creatorId: id('Creator') },
    },
    (a) => run(() => caller.creators.unpick(a)),
  )
  server.registerTool(
    'set_creator_status',
    {
      description: "Set a creator's pipeline stage for a game: prospect/contacted/replied/agreed/published/closed.",
      inputSchema: {
        gameId: z.string(),
        creatorId: z.string(),
        pipelineStatus,
        closedReason: z.enum(['declined', 'no_response', 'done']).nullable().optional(),
        agreedCostUsd: z.number().int().nullable().optional(),
      },
    },
    (a) => run(() => caller.creators.setStatus(a)),
  )
  server.registerTool(
    'log_touch',
    {
      description:
        'Atomically log one creator correspondence touch and advance the pipeline. Returns the saved touch and verified resulting pick. Supply requestId so retries cannot duplicate it.',
      inputSchema: {
        gameId: id('Game'),
        ...creatorTouchFields,
        requestId: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Stable unique key for this real-world touch; reuse the same key when retrying.'),
      },
    },
    (a) => run(() => caller.creators.logTouch({ ...a, createdBy: 'ai' })),
  )
  server.registerTool(
    'log_touches_bulk',
    {
      description:
        'Atomically log 1-50 creator correspondence touches in one serialized batch. Every item requires a requestId, so retrying the whole batch is safe. Returns verified touches and resulting pipeline picks.',
      inputSchema: {
        gameId: id('Game'),
        items: z
          .array(
            z.object({
              ...creatorTouchFields,
              requestId: z
                .string()
                .min(1)
                .max(200)
                .describe('Stable unique key for this real-world touch; reuse it when retrying the batch.'),
            }),
          )
          .min(1)
          .max(50),
      },
    },
    ({ gameId, items }) =>
      run(() => caller.creators.logTouchesBulk({ gameId, items: items.map((item) => ({ ...item, createdBy: 'ai' })) })),
  )

  // ---------- GMass outreach automation ----------
  server.registerTool(
    'preview_gmass_campaign',
    {
      description:
        'Preview exact personalized GMass recipients/messages without creating drafts or sending. Always run this before create_gmass_campaign.',
      inputSchema: gmassCampaignInput,
    },
    (a) => run(() => caller.gmass.preview(a)),
  )
  server.registerTool(
    'create_gmass_campaign',
    {
      description:
        'Freeze a GMass outreach batch after preview. This does not dispatch it; approve_gmass_campaign is a separate explicit action.',
      inputSchema: {
        ...gmassCampaignInput,
        name: z.string().min(1).max(160),
        fromEmail: z.string().email().describe('Authenticated GMass/Gmail From address.'),
        messageType: z.enum(['plain', 'html']).optional(),
        sendMode: z.enum(['draft', 'send', 'schedule']),
        sendAt: z.string().nullable().optional().describe('Required for schedule mode.'),
        openTracking: z.boolean().optional(),
        clickTracking: z.boolean().optional(),
        emailsPerDay: z.number().int().positive().max(2000).nullable().optional(),
      },
    },
    (a) => run(() => caller.gmass.create({ ...a, requestedBy: 'mcp' })),
  )
  server.registerTool(
    'approve_gmass_campaign',
    {
      description:
        'Explicitly approve and queue a frozen GMass campaign. The desktop worker owns the encrypted API key and dispatches queued work when MarCat is running.',
      inputSchema: {
        id: id('GMass campaign'),
        confirm: z.literal(true).describe('Must be true after the exact recipient count and messages were reviewed.'),
        expectedRecipientCount: z.number().int().positive(),
        contentHash: z.string().min(16).describe('Hash returned by create_gmass_campaign.'),
      },
    },
    (a) => run(() => caller.gmass.approve(a)),
  )
  server.registerTool(
    'list_gmass_campaigns',
    {
      description: 'List GMass outreach batches with aggregate per-recipient delivery states.',
      inputSchema: { gameId: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    },
    (a) => run(() => caller.gmass.list(a)),
  )
  server.registerTool(
    'get_gmass_campaign',
    {
      description: 'Get one GMass batch with every frozen recipient, exact message and delivery state.',
      inputSchema: { id: id('GMass campaign') },
    },
    (a) => run(() => caller.gmass.get(a)),
  )
  server.registerTool(
    'sync_gmass_campaign',
    {
      description:
        'Request delivery/reply/bounce synchronization. The desktop worker performs it with the encrypted GMass key.',
      inputSchema: { id: id('GMass campaign') },
    },
    (a) => run(() => caller.gmass.requestSync(a)),
  )
  server.registerTool(
    'retry_gmass_campaign',
    {
      description: 'Retry failed recipients in a GMass batch. Already successful recipients are not recreated.',
      inputSchema: { id: id('GMass campaign') },
    },
    (a) => run(() => caller.gmass.retry(a)),
  )

  const shutdown = () => {
    void workspace.stop().finally(() => client.close())
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('beforeExit', shutdown)
  await server.connect(new StdioServerTransport())
  console.error(`[marcat-mcp] ready (db: ${path})`)
}

main().catch((e) => {
  console.error('[marcat-mcp] fatal:', e)
  process.exit(1)
})
