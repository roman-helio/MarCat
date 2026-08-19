#!/usr/bin/env node
/**
 * MarCat MCP server (stdio or loopback Streamable HTTP). Wraps the same domain layer (tRPC caller over the
 * shared marcat.db) so an external agent — your own Claude Code / Codex — can
 * READ the plan and CHANGE it. Point it at the DB via the MARCAT_DB env var.
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse,
  type McpHttpHandler,
} from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
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
  MARCAT_MCP_HTTP_PORT,
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
const MCP_LOG_MAX_BYTES = 2 * 1024 * 1024
let mcpLogPath: string | undefined

function httpPort(): number {
  const flagIndex = process.argv.indexOf('--port')
  const raw = flagIndex >= 0 ? process.argv[flagIndex + 1] : process.env.MARCAT_MCP_PORT
  const port = raw === undefined ? MARCAT_MCP_HTTP_PORT : Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid MCP HTTP port: ${raw ?? ''}`)
  }
  return port
}

async function toWebRequest(request: IncomingMessage, fallbackHost: string): Promise<Request> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  const chunks: Buffer[] = []
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
  return new Request(`http://${request.headers.host ?? fallbackHost}${request.url ?? '/'}`, {
    method: request.method,
    headers,
    body,
  })
}

async function writeWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status
  target.statusMessage = response.statusText
  response.headers.forEach((value, name) => target.setHeader(name, value))
  if (!response.body) {
    target.end()
    return
  }
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      target.write(Buffer.from(chunk))
    }
    target.end()
  } catch (error) {
    target.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}

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

function appendMcpLog(message: string, error?: unknown): void {
  if (!mcpLogPath) return
  try {
    fs.mkdirSync(dirname(mcpLogPath), { recursive: true })
    if (fs.existsSync(mcpLogPath) && fs.statSync(mcpLogPath).size >= MCP_LOG_MAX_BYTES) {
      const previousPath = `${mcpLogPath}.1`
      try {
        fs.rmSync(previousPath, { force: true })
        fs.renameSync(mcpLogPath, previousPath)
      } catch {
        // Keep appending if another MCP process briefly owns the log on Windows.
      }
    }
    const detail = error === undefined ? '' : ` | ${formatToolError(error).replace(/[\r\n]+/g, ' ')}`
    fs.appendFileSync(mcpLogPath, `[${new Date().toISOString()}] pid=${process.pid} ${message}${detail}\n`, 'utf8')
  } catch {
    /* persistent logging is best-effort and must never affect stdio */
  }
}

function memorySummary(): string {
  const memory = process.memoryUsage()
  const mib = (bytes: number) => Math.round(bytes / (1024 * 1024))
  return `rss=${mib(memory.rss)}MiB heap=${mib(memory.heapUsed)}MiB external=${mib(memory.external)}MiB`
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
  mcpLogPath = join(dirname(path), 'mcp.log')
  appendMcpLog(`starting version=${__MARCAT_VERSION__} ${memorySummary()}`)
  process.once('uncaughtException', (error) => {
    appendMcpLog('uncaught exception', error)
    console.error('[marcat-mcp] uncaught exception:', formatToolError(error))
    process.exit(1)
  })
  process.on('unhandledRejection', (error) => {
    appendMcpLog('unhandled rejection', error)
    console.error('[marcat-mcp] unhandled rejection:', formatToolError(error))
  })
  process.once('exit', (code) => appendMcpLog(`exit code=${code} ${memorySummary()}`))
  const { db, client } = createDb(fileUrlFromPath(path))
  const workspace = new MarkdownWorkspaceCoordinator(new DrizzleWorkspaceRepository(db), {
    onError: (error) => {
      appendMcpLog('workspace sync failed', error)
      console.error('[marcat-mcp] workspace sync failed:', error)
    },
  })
  let databaseInitializationError: unknown
  const databaseReady = (async () => {
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
      appendMcpLog(`database ready ${memorySummary()}`)
      console.error(`[marcat-mcp] database ready (db: ${path})`)
    } catch (error) {
      databaseInitializationError = error
      console.error('[marcat-mcp] database preparation failed:', formatToolError(error))
    }
  })()
  const ensureDatabaseReady = async () => {
    await databaseReady
    if (databaseInitializationError) throw databaseInitializationError
  }

  // Filesystem reconciliation must not delay the MCP handshake or take the
  // transport down. The durable outbox lets a later retry/desktop session pick
  // up any workspace work if startup reconciliation is temporarily blocked.
  const workspaceStartup = ensureDatabaseReady()
    .then(() => workspace.start())
    .catch((error) => console.error('[marcat-mcp] workspace startup failed:', formatToolError(error)))
  const wakeCreatorDiscovery = () => {
    try {
      fs.writeFileSync(`${path}.discovery-wakeup`, String(Date.now()), 'utf8')
    } catch (error) {
      appendMcpLog('creator discovery wake signal failed', error)
    }
  }
  let promotionChild: ReturnType<typeof spawn> | undefined
  let promotionWakePending = false
  const launchCreatorPromotionWorker = () => {
    if (promotionChild) {
      promotionWakePending = true
      return
    }
    const workerPath = join(dirname(resolve(process.argv[1])), 'promotion-worker.cjs')
    const child = spawn(process.execPath, [workerPath, path], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    promotionChild = child
    child.unref()
    child.once('error', (error) => appendMcpLog('creator promotion worker failed to start', error))
    child.once('close', () => {
      if (promotionChild === child) promotionChild = undefined
      if (promotionWakePending) {
        promotionWakePending = false
        launchCreatorPromotionWorker()
      }
    })
  }
  const wakeCreatorPromotion = () => {
    try {
      fs.writeFileSync(`${path}.creator-promotion-wakeup`, String(Date.now()), 'utf8')
    } catch (error) {
      appendMcpLog('creator promotion wake signal failed', error)
    }
    launchCreatorPromotionWorker()
  }
  const caller = appRouter.createCaller({ db, workspace, wakeCreatorDiscovery, wakeCreatorPromotion })

  const run = async (fn: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      await ensureDatabaseReady()
      const text = JSON.stringify(await fn(), null, 2)
      const responseBytes = Buffer.byteLength(text, 'utf8')
      if (responseBytes > 256 * 1024) {
        console.error(`[marcat-mcp] refusing oversized tool response (${responseBytes} bytes)`)
        return {
          content: [
            {
              type: 'text',
              text: 'Error: MCP response is too large. Request a smaller page or narrow the filters, then continue with the next offset.',
            },
          ],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text }] }
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: ${formatToolError(e)}` }],
        isError: true,
      }
    }
  }

  // Protocol negotiation can discard a modern probe and request a legacy
  // instance next, so capture definitions once and replay them onto a fresh server.
  const toolRegistrations: Array<(server: McpServer) => void> = []
  const registerTool = ((...args: unknown[]) => {
    const toolName = String(args[0] ?? 'unknown')
    const handlerIndex = args.length - 1
    const handler = args[handlerIndex]
    const replayArgs = [...args]
    if (typeof handler === 'function') {
      replayArgs[handlerIndex] = async (...handlerArgs: unknown[]) => {
        const startedAt = Date.now()
        appendMcpLog(`tool start name=${toolName} ${memorySummary()}`)
        try {
          const result = await Reflect.apply(handler, undefined, handlerArgs)
          appendMcpLog(`tool complete name=${toolName} durationMs=${Date.now() - startedAt} ${memorySummary()}`)
          return result
        } catch (error) {
          appendMcpLog(`tool failed name=${toolName} durationMs=${Date.now() - startedAt} ${memorySummary()}`, error)
          throw error
        }
      }
    }
    toolRegistrations.push((server) => {
      Reflect.apply(server.registerTool, server, replayArgs)
    })
  }) as unknown as McpServer['registerTool']
  const id = (what: string) =>
    z.string().min(1).describe(`${what} UUID returned by MarCat; do not use its display key.`)
  const day = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Calendar date in ISO YYYY-MM-DD format.')
  const nullableDay = day.nullable().describe('ISO date YYYY-MM-DD, or null to clear it.')
  const marketingCampaignTouchpoint = z.object({
    source: z.string().max(200).describe('UTM source exactly as shown by get_analytics_overview.'),
    campaign: z.string().max(300).describe('UTM campaign exactly as shown by get_analytics_overview.'),
    medium: z.string().max(200).describe('UTM medium exactly as shown by get_analytics_overview.'),
    content: z.string().max(500).describe('UTM content exactly as shown by get_analytics_overview.'),
    term: z.string().max(300).optional().describe('Optional UTM term/keyword.'),
    eventId: id('Activity').nullable().optional().describe('Linked project activity when known.'),
  })
  const marketingCampaignFields = {
    id: id('Managed marketing campaign').optional().describe('Omit to create; provide to update in place.'),
    gameId: id('Game'),
    name: z.string().trim().min(1).max(200),
    objective: z.enum(['wishlist_growth', 'traffic', 'sales', 'awareness']),
    status: z.enum(['planned', 'active', 'completed', 'archived']),
    plannedStart: nullableDay,
    plannedEnd: nullableDay,
    evaluationWindowDays: z.number().int().min(1).max(60),
    budgetCents: z.number().int().nonnegative().nullable().describe('Whole-campaign budget in minor currency units.'),
    spendCents: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Whole-campaign actual spend in minor currency units.'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .describe('ISO 4217 currency code, e.g. USD or EUR.'),
    notes: z.string().max(4000).nullable(),
    touchpoints: z
      .array(marketingCampaignTouchpoint)
      .min(1)
      .max(100)
      .describe('One or more UTM tuples owned by this campaign; each tuple can belong to only one campaign.'),
  }
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
  const discoveryReference = z.object({
    label: z.string().min(1).max(160).describe('Reference game title or a topic facet such as Military history.'),
    aliases: z.array(z.string().min(1)).max(100).optional().describe('Alternate names matched locally in video text.'),
    queryTerms: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe('Queries used to seed search across connected creator platforms; defaults to the label.'),
    weight: z.number().min(0.1).max(10).optional().describe('Relative importance in deterministic fit scoring.'),
  })
  const discoveryProfileFields = {
    gameId: id('Game'),
    name: z.string().min(1).max(160).describe('Reusable, project-scoped search profile name.'),
    mode: z
      .enum(['games', 'topic'])
      .optional()
      .describe('games matches reference titles; topic matches several facets of an expertise area.'),
    languages: z.array(z.string().min(2).max(12)).max(10).optional(),
    includeTerms: z.array(z.string().min(1)).max(100).optional(),
    excludeTerms: z.array(z.string().min(1)).max(100).optional(),
    seedChannels: z.array(z.string().min(1)).max(200).optional(),
    maxSearchRequests: z.number().int().min(1).max(100).optional(),
    maxChannels: z.number().int().min(10).max(5_000).optional(),
    recentVideoLimit: z.number().int().min(10).max(100).optional(),
    discoverContacts: z.boolean().optional(),
    references: z.array(discoveryReference).min(1).max(100),
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
  ) => {
    const { topicsJson, playedGamesJson, contactsJson, channelsJson, ...fields } = row
    return {
      ...fields,
      topics: parseArray(topicsJson),
      playedGames: parseArray(playedGamesJson),
      contacts: parseArray(contactsJson),
      channels: parseArray(channelsJson),
    }
  }
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
  registerTool('list_games', { description: 'List all games (workspaces).' }, () => run(() => caller.games.list()))
  registerTool(
    'get_readonly_database_access',
    {
      description:
        'Get the active local SQLite path for read-heavy analysis when the client also has local filesystem access. Open only with mode=ro and PRAGMA query_only=ON; all writes must still use MarCat tools.',
    },
    () =>
      run(async () => ({
        databasePath: resolve(path),
        sqliteUri: `${pathToFileURL(resolve(path)).href}?mode=ro`,
        mode: 'read-only',
        observeWal: true,
        rules: [
          'Open the URI with mode=ro and immediately execute PRAGMA query_only=ON.',
          'Do not add immutable=1: the active database may have committed rows in its WAL file.',
          'Use direct SQL only for large read-only joins, aggregates, counts and diagnostics.',
          'Use MCP/tRPC tools for every insert, update or delete so validation, idempotency and workspace sync remain intact.',
          'Aggregate locally and return only the small result needed for reasoning; never dump whole tables into model context.',
        ],
        semanticTables: {
          games: 'games',
          tasks: 'tasks',
          activities: 'events',
          festivals: 'industry_events',
          creators: 'creators',
          creatorProjectPipeline: 'creator_picks',
          discoveryRuns: 'creator_discovery_runs',
          discoveryCandidates: 'creator_discovery_run_candidates',
          discoveryContacts: 'creator_discovery_contacts',
          discoveryEvidence: 'creator_discovery_evidence',
        },
      })),
  )
  registerTool(
    'get_game',
    {
      description:
        'Get the canonical game/workspace fields, including project key, release date, store platforms/URLs, archive state and derived Steam identifiers.',
      inputSchema: z.object({ id: id('Game') }),
    },
    ({ id }) => run(() => caller.games.get({ id })),
  )
  registerTool(
    'get_project_card',
    {
      description:
        'Get the one-call project card for an agent: stable project facts, owner notes, an insight title catalogue, useful links/docs, deadlines, current tasks, festivals, recent activity, chart events and wishlist state. Use get_insight to load the full text of a relevant insight. Pass key like "SAS" when known; gameId also works.',
      inputSchema: z.object(projectCardLookup),
    },
    (a) => run(() => caller.projectCards.get(a)),
  )
  registerTool(
    'get_workspace_status',
    {
      description:
        'Get Markdown workspace availability, pending writes, conflicts, missing files and synchronization health for a project.',
      inputSchema: z.object({ gameId: id('Game') }),
    },
    (a) => run(() => caller.workspace.status(a)),
  )
  registerTool(
    'rescan_workspace',
    {
      description:
        'Reconcile a configured Markdown workspace now. External edits are imported; missing files are reported and never delete database records.',
      inputSchema: z.object({ gameId: id('Game') }),
    },
    (a) => run(() => caller.workspace.reconcile(a)),
  )
  registerTool(
    'list_workspace_issues',
    {
      description: 'List unresolved Markdown workspace conflicts, invalid documents and missing-file decisions.',
      inputSchema: z.object({ gameId: id('Game') }),
    },
    (a) => run(() => caller.workspace.issues(a)),
  )
  registerTool(
    'get_workspace_paths',
    {
      description: 'Get the validated absolute workspace root and registered Markdown document paths.',
      inputSchema: z.object({ gameId: id('Game') }),
    },
    (a) => run(() => caller.workspace.paths(a)),
  )
  registerTool(
    'list_insights',
    {
      description:
        "List a game's insight catalogue. The mandatory «Карточка проекта» entry is always first; use its id with update_insight to fill it. Use other ids to fetch only relevant full notes with get_insight before planning or analysis.",
      inputSchema: z.object({
        gameId: id('Game'),
        search: z.string().optional().describe('Optional title search; full note bodies are not searched or returned.'),
      }),
    },
    (a) => run(() => caller.insights.catalog(a)),
  )
  registerTool(
    'get_insight',
    {
      description: 'Get one project insight with its full Markdown body and provenance.',
      inputSchema: z.object({ id: id('Insight') }),
    },
    (a) => run(() => caller.insights.get(a)),
  )
  registerTool(
    'list_tasks',
    {
      description:
        'List tasks. A legacy call with only gameId returns the original full project list. For fast compact results, pass search/filters/detail/limit, or prefer search_tasks when looking for a specific task. Omit gameId to list across all games.',
      inputSchema: z.object({
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
      }),
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

  registerTool(
    'search_tasks',
    {
      description:
        'Search tasks in SQLite before returning data. Use this instead of list_tasks for finding work by title, description or Jira-style key; results are compact and paginated by default, then get_task can load the selected full record.',
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        gameId: z.string().optional(),
        statuses: z.array(status).min(1).max(5).optional(),
        priorities: z.array(priority).min(1).max(4).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Defaults to 20.'),
        offset: z.number().int().min(0).optional().describe('Defaults to 0.'),
        detail: z.enum(['short', 'full']).optional().describe('Defaults to short; use get_task for full details.'),
      }),
    },
    ({ query, gameId, statuses, priorities, limit, offset, detail }) =>
      run(() => caller.tasks.search({ query, gameId, statuses, priorities, limit, offset, detail })),
  )

  registerTool(
    'get_next_actions',
    {
      description:
        'Get a deterministic, checklist-aware focus queue for one game. Use this for “what should I do now?” instead of freely summarizing list_tasks. It favors important in-progress work that is close to done, overdue actionable tasks, and blockers that unlock downstream work.',
      inputSchema: z.object({
        gameId: id('Game'),
        limit: z.number().int().min(1).max(10).optional().describe('Number of focus items; defaults to 5.'),
      }),
    },
    ({ gameId, limit }) => run(() => caller.tasks.focus({ gameId, limit })),
  )
  registerTool(
    'get_task',
    {
      description: 'Get one task with its checklist, blockers, blocked-tasks and tags.',
      inputSchema: z.object({ id: z.string() }),
    },
    ({ id }) => run(() => caller.tasks.get({ id })),
  )
  registerTool(
    'list_dependencies',
    {
      description: "List dependency edges (blocker -> blocked) among a game's tasks.",
      inputSchema: z.object({ gameId: z.string() }),
    },
    ({ gameId }) => run(() => caller.tasks.listDependencies({ gameId })),
  )
  registerTool(
    'list_tags',
    {
      description:
        "List a game's tags with linked-task progress. A tag with targetDate is a rescheduling deadline; moving it shifts dated tagged tasks and their blocker chain.",
      inputSchema: z.object({ gameId: z.string() }),
    },
    ({ gameId }) => run(() => caller.tags.withStatus({ gameId })),
  )
  registerTool(
    'list_events',
    {
      description:
        "List a compact page of a game's wishlist-chart marketing events. Use get_activity for the full body.",
      inputSchema: z.object({
        gameId: z.string(),
        search: z.string().min(1).max(200).optional(),
        from: day.optional(),
        to: day.optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Defaults to 20.'),
        offset: z.number().int().min(0).optional().describe('Use nextOffset from the previous page.'),
      }),
    },
    (a) => run(() => caller.activities.search({ ...a, wishlistOnly: true })),
  )
  registerTool(
    'list_activities',
    {
      description:
        'List a compact page of the dated project activity journal. Filters run in SQLite before transport; use nextOffset to continue and get_activity for the full body.',
      inputSchema: z.object({
        gameId: z.string(),
        subjectType: activitySubject.optional(),
        subjectId: z.string().nullable().optional(),
        wishlistOnly: z.boolean().optional(),
        search: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Defaults to 20.'),
        offset: z.number().int().min(0).optional().describe('Use nextOffset from the previous page.'),
      }),
    },
    (a) => run(() => caller.activities.search(a)),
  )
  registerTool(
    'search_activities',
    {
      description:
        'Search activity titles and bodies in SQLite and return compact paginated matches. Use get_activity only for selected full records.',
      inputSchema: z.object({
        gameId: z.string(),
        query: z.string().min(1).max(200),
        subjectType: activitySubject.optional(),
        subjectId: z.string().nullable().optional(),
        wishlistOnly: z.boolean().optional(),
        from: day.optional(),
        to: day.optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Defaults to 20.'),
        offset: z.number().int().min(0).optional().describe('Use nextOffset from the previous page.'),
      }),
    },
    ({ query, ...a }) => run(() => caller.activities.search({ ...a, search: query })),
  )
  registerTool(
    'get_activity',
    {
      description: 'Get one activity with its full body and linked subject.',
      inputSchema: z.object({ id: z.string() }),
    },
    (a) => run(() => caller.activities.get(a)),
  )
  registerTool(
    'get_wishlist_series',
    {
      description:
        'Wishlist time series. adds/deletes/gifts/net are period changes; balance is the running total; null means unknown, not zero. source/importBatchId preserve provenance.',
      inputSchema: z.object({ gameId: id('Game') }),
    },
    ({ gameId }) => run(() => caller.wishlists.series({ gameId })),
  )
  registerTool(
    'get_wishlist_impact',
    {
      description:
        'Correlate chart-visible activities with wishlist adds over a trailing baseline and post-event window. This is heuristic correlation, not causal attribution.',
      inputSchema: z.object({
        gameId: id('Game'),
        windowDays: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Days after each event; defaults to Steam UTM’s 72-hour window (3 days).'),
      }),
    },
    (a) => run(() => caller.analytics.impact(a)),
  )
  registerTool(
    'get_analytics_overview',
    {
      description:
        'Read the complete source-backed analytics workspace for a game: UTM totals and raw tuples, managed campaigns and economics, decision highlights, Steam traffic, imports and data-quality diagnostics. Omit dates for all-time campaign economics; date ranges use the daily UTM export and intentionally leave whole-campaign cost per wishlist unavailable.',
      inputSchema: z.object({
        gameId: id('Game'),
        dateFrom: day.optional(),
        dateTo: day.optional(),
      }),
    },
    (a) => run(() => caller.analytics.overview(a)),
  )
  registerTool(
    'list_utm_links',
    {
      description:
        'List generated UTM links. source identifies the traffic origin, medium the channel class, campaign the initiative, content the creative/placement variant, and term the optional targeting keyword.',
      inputSchema: z.object({ gameId: id('Game') }),
    },
    (a) => run(() => caller.utm.list(a)),
  )
  registerTool(
    'list_sources',
    {
      description:
        'List configured import sources for a game, including platform, handle/folder, enabled state and last sync result. API keys are intentionally never returned.',
      inputSchema: z.object({ gameId: id('Game') }),
    },
    (a) => run(() => caller.sources.list(a)),
  )
  registerTool(
    'list_source_platforms',
    {
      description:
        'List supported source connector platforms with provider, key requirement and estimated per-request cost.',
    },
    () => run(() => caller.sources.platforms()),
  )
  registerTool(
    'list_comments',
    {
      description:
        'List normalized player reviews/comments imported into a game inbox. Filter by configured source or workflow status when useful.',
      inputSchema: z.object({
        gameId: id('Game'),
        sourceId: id('Source').optional(),
        status: z.enum(['unread', 'open', 'replied', 'ignored']).optional(),
      }),
    },
    (a) => run(() => caller.comments.list(a)),
  )
  registerTool(
    'get_source_history',
    {
      description: 'Get the latest sync runs for one source: status, imported row count, cost and errors.',
      inputSchema: z.object({ sourceId: id('Source') }),
    },
    (a) => run(() => caller.sources.history(a)),
  )
  registerTool(
    'get_source_spend',
    {
      description:
        "Get today's paid-provider request count, spend and configured daily budget. API keys are never exposed.",
    },
    () => run(() => caller.sources.spend()),
  )
  registerTool(
    'list_festivals',
    {
      description:
        'List a compact, paginated page of the shared industry-event catalogue. Search and date filters run in SQLite; use get_festival for full notes and description.',
      inputSchema: z.object({
        search: z.string().min(1).max(200).optional(),
        from: day.optional().describe('Only events whose date range ends on or after this day.'),
        to: day.optional().describe('Only events whose date range starts on or before this day.'),
        limit: z.number().int().min(1).max(100).optional().describe('Defaults to 20.'),
        offset: z.number().int().min(0).optional().describe('Use nextOffset from the previous page.'),
      }),
    },
    ({ search, ...a }) => run(() => caller.festivals.search({ ...a, query: search })),
  )
  registerTool(
    'get_festival',
    {
      description: 'Get every stored field for one festival, showcase, conference or sale.',
      inputSchema: z.object({ id: id('Festival') }),
    },
    (a) => run(() => caller.festivals.get(a)),
  )
  registerTool(
    'list_festival_picks',
    {
      description: 'List the festivals a game has picked, with prep/submission status.',
      inputSchema: z.object({ gameId: z.string() }),
    },
    ({ gameId }) => run(() => caller.festivals.picks({ gameId })),
  )
  registerTool(
    'list_festival_participation',
    { description: 'List all game participation/status rows for the shared festival catalogue.' },
    () => run(() => caller.festivals.participation()),
  )

  // ---------- write ----------
  registerTool(
    'create_game',
    {
      description:
        'Create a game/workspace. The project key is the shared prefix for MarCat task keys and DevHub lookup; release platforms are store/build targets, not social publishing platforms.',
      inputSchema: z.object({
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
      }),
    },
    (a) => run(() => caller.games.create(a)),
  )
  registerTool(
    'update_game',
    {
      description:
        'Update canonical game/workspace fields. Replacing platforms replaces the whole platform list; changing key relabels task display keys. archived hides the workspace without deleting it.',
      inputSchema: z.object({
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
      }),
    },
    ({ id, ...patch }) => run(() => caller.games.update({ id, patch })),
  )
  registerTool(
    'create_task',
    {
      description:
        'Create a task in a game. Description accepts Markdown; paragraphs and lists are preserved. Use recurrence for routine checks that should reopen after each completion.',
      inputSchema: z.object({
        gameId: id('Game'),
        title: z.string().min(1).max(200).describe('One concrete outcome/action, not a campaign heading.'),
        description: z.string().optional().describe('Task details in Markdown or plain text.'),
        priority: priority.optional(),
        dueDate: nullableDay.optional().describe('Completion deadline; null/omitted means unscheduled.'),
        recurrence: recurrence.optional(),
      }),
    },
    (a) => run(() => caller.tasks.create(a)),
  )
  registerTool(
    'update_project_card',
    {
      description:
        'Create or update the owner-maintained project card fields. Use this for durable common project context, not per-task notes.',
      inputSchema: z.object({
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
      }),
    },
    (a) => run(() => caller.projectCards.update({ ...a, updatedBy: 'mcp' })),
  )
  registerTool(
    'create_insight',
    {
      description:
        'Create durable project knowledge such as an audience finding, experiment conclusion or validated/rejected hypothesis. Use an activity instead for a dated event or correspondence.',
      inputSchema: z.object({
        gameId: id('Game'),
        title: z.string().min(1).max(240).describe('Specific, scannable conclusion or question.'),
        body: z.string().min(1).describe('Full evidence, reasoning and implications in Markdown or plain text.'),
      }),
    },
    (a) => run(() => caller.insights.create({ ...a, createdBy: 'mcp' })),
  )
  registerTool(
    'update_insight',
    {
      description:
        'Update an existing insight after new evidence or a hypothesis check. Fetch it first with get_insight. The required «Карточка проекта» insight is filled through this tool too; its title is fixed.',
      inputSchema: z.object({
        id: id('Insight'),
        title: z.string().min(1).max(240).optional(),
        body: z.string().min(1).optional(),
      }),
    },
    (a) => run(() => caller.insights.update({ ...a, updatedBy: 'mcp' })),
  )
  registerTool(
    'delete_insight',
    {
      description: 'Delete one ordinary project insight. The required «Карточка проекта» insight cannot be deleted.',
      inputSchema: z.object({ id: id('Insight') }),
    },
    (a) => run(() => caller.insights.remove(a)),
  )
  registerTool(
    'update_task',
    {
      description:
        'Update a task (priority, dates, title, description, recurrence, or non-final status). Set recurrence to an interval to enable repetition, or null to disable it. Markdown descriptions are supported. When finishing work, prefer complete_task so checklist items and the parent status are reconciled atomically.',
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional(),
        status: status.optional(),
        priority: priority.optional(),
        startDate: nullableDay.optional(),
        dueDate: nullableDay.optional(),
        reminderAt: z.string().nullable().optional().describe('Optional reminder timestamp/date; null clears it.'),
        recurrence: recurrence.nullable().optional(),
        description: z.string().optional().describe('Task details in Markdown or plain text.'),
      }),
    },
    ({ id, ...patch }) =>
      run(() => {
        if (patch.status === 'done') {
          throw new Error('Use complete_task to reconcile checklist items and blockers before closing a task')
        }
        return caller.tasks.update({ id, patch })
      }),
  )
  registerTool(
    'add_dependency',
    {
      description: 'Link two tasks: blocker must finish before blocked. Rejected if it would create a cycle.',
      inputSchema: z.object({ blockerTaskId: z.string(), blockedTaskId: z.string() }),
    },
    (a) => run(() => caller.tasks.addDependency(a)),
  )
  registerTool(
    'remove_dependency',
    { description: 'Remove a dependency edge by its id.', inputSchema: z.object({ id: z.string() }) },
    (a) => run(() => caller.tasks.removeDependency(a)),
  )
  registerTool(
    'add_checklist_item',
    {
      description:
        'Add a small sub-step inside a task. Use a separate task instead when it needs its own owner/status/dependencies.',
      inputSchema: z.object({ taskId: id('Task'), text: z.string().min(1) }),
    },
    (a) => run(() => caller.tasks.addChecklistItem(a)),
  )
  registerTool(
    'set_checklist_item',
    {
      description:
        'Set one checklist item complete/incomplete after verifying the work. This does not complete the parent task automatically; use complete_task for the final reconciliation pass.',
      inputSchema: z.object({ id: id('Checklist item'), done: z.boolean() }),
    },
    (a) => run(() => caller.tasks.toggleChecklistItem(a)),
  )

  registerTool(
    'complete_task',
    {
      description:
        'Finish a task safely. Pass the checklist item UUIDs whose work was actually verified in this session. MarCat marks those items done and closes the parent atomically only when no checklist items or blockers remain. A recurring task instead reopens as todo, clears its checklist and returns nextDueDate. Re-read the result before reporting completion.',
      inputSchema: z.object({
        id: id('Task'),
        completedChecklistItemIds: z
          .array(id('Checklist item'))
          .optional()
          .describe('Only items whose underlying work was verified; omit for a task with no checklist.'),
      }),
    },
    (a) => run(() => caller.tasks.complete(a)),
  )
  registerTool(
    'delete_checklist_item',
    {
      description: 'Delete one checklist item, not its parent task.',
      inputSchema: z.object({ id: id('Checklist item') }),
    },
    (a) => run(() => caller.tasks.removeChecklistItem(a)),
  )
  registerTool(
    'create_tag',
    {
      description: 'Create a tag. Set targetDate (YYYY-MM-DD) to make it a dated deadline (countdown + cascade).',
      inputSchema: z.object({
        gameId: id('Game'),
        name: z.string(),
        color: z.string().optional(),
        colorEnabled: z.boolean().optional(),
        targetDate: nullableDay.optional(),
        type: tagType.optional(),
      }),
    },
    (a) => run(() => caller.tags.create(a)),
  )
  registerTool(
    'update_tag',
    {
      description:
        'Update a tag (name, color, colour highlighting, deadline date). Moving the date shifts tagged tasks + their blockers.',
      inputSchema: z.object({
        id: z.string(),
        name: z.string().optional(),
        color: z.string().optional(),
        colorEnabled: z.boolean().optional(),
        targetDate: nullableDay.optional(),
        type: tagType.optional(),
      }),
    },
    ({ id, ...patch }) => run(() => caller.tags.update({ id, patch })),
  )
  registerTool(
    'assign_tag',
    { description: 'Attach a tag to a task.', inputSchema: z.object({ taskId: z.string(), tagId: z.string() }) },
    (a) => run(() => caller.tasks.assignTag(a)),
  )
  registerTool(
    'unassign_tag',
    { description: 'Remove a tag from a task.', inputSchema: z.object({ taskId: z.string(), tagId: z.string() }) },
    (a) => run(() => caller.tasks.unassignTag(a)),
  )
  registerTool(
    'add_wishlist_point',
    {
      description:
        'Upsert one manual wishlist data point by game+date. Use null for unknown values and 0 only for a known zero. adds/deletes/gifts/net are changes; balance is the running total.',
      inputSchema: z.object({
        gameId: id('Game'),
        date: day,
        adds: z.number().int().nonnegative().nullable().optional(),
        deletes: z.number().int().nonnegative().nullable().optional(),
        gifts: z.number().int().nonnegative().nullable().optional(),
        balance: z.number().int().nonnegative().nullable().optional(),
        net: z.number().int().nullable().optional().describe('Net change; may be negative.'),
      }),
    },
    (a) => run(() => caller.wishlists.addPoint(a)),
  )
  registerTool(
    'import_steam_analytics_csv',
    {
      description:
        'Import the text of one Steam CSV into analytics. MarCat auto-detects wishlist history, UTM daily/country and Store & Steam Platform Traffic exports, reports parser warnings, and ignores an exact duplicate. This tool accepts CSV content, not a local file path.',
      inputSchema: z.object({
        gameId: id('Game'),
        csv: z.string().min(1).describe('Complete UTF-8 CSV text including its header.'),
        filename: z
          .string()
          .max(260)
          .optional()
          .describe('Original filename; improves Steam export type/date detection.'),
      }),
    },
    (a) => run(() => caller.analytics.importCsv(a)),
  )
  registerTool(
    'upsert_marketing_campaign',
    {
      description:
        'Create or update one managed marketing campaign and assign its UTM touchpoints. Read get_analytics_overview first and copy its UTM source/campaign/medium/content/term tuple exactly. Budget and spend belong to the whole campaign; cost per wishlist is therefore comparable only in the all-time overview.',
      inputSchema: z.object(marketingCampaignFields),
    },
    (a) => run(() => caller.analytics.upsertCampaign(a)),
  )
  registerTool(
    'build_utm_link',
    {
      description:
        'Build and save a traceable campaign URL. Use stable normalized naming: source=origin/service, medium=channel class, campaign=initiative, content=creative or placement variant, term=optional keyword/audience.',
      inputSchema: z.object({
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
      }),
    },
    (a) => run(() => caller.utm.build(a)),
  )
  registerTool(
    'create_source',
    {
      description:
        'Configure an import source. handle is a Steam CSV folder, social handle, public feedback page, package name or app id depending on platform. This never stores API keys.',
      inputSchema: z.object({
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
      }),
    },
    (a) => run(() => caller.sources.create(a)),
  )
  registerTool(
    'set_comment_status',
    {
      description:
        'Update the human workflow state of one imported player comment. Never mark replied unless a human has actually replied.',
      inputSchema: z.object({
        id: id('Comment'),
        status: z.enum(['unread', 'open', 'replied', 'ignored']),
      }),
    },
    (a) => run(() => caller.comments.setStatus(a)),
  )
  registerTool(
    'update_source',
    {
      description:
        'Update a source handle/folder, display label or enabled state. API keys and provider budgets belong to Settings and are intentionally outside this tool.',
      inputSchema: z.object({
        id: id('Source'),
        handle: z.string().optional(),
        displayName: z.string().nullable().optional(),
        enabled: z.boolean().optional(),
      }),
    },
    ({ id, ...patch }) => run(() => caller.sources.update({ id, patch })),
  )
  registerTool(
    'create_event',
    {
      description:
        'DEPRECATED compatibility alias for a project-level, wishlist-chart-visible activity. Prefer create_activity so subject, full text, placement, ownership and metrics are explicit. Do not use for prep/drafts/notes.',
      inputSchema: z.object({
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
      }),
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
  registerTool(
    'create_activity',
    {
      description:
        'Create one journal activity. Preserve all known facts in their semantic fields. Social/public content uses type+platform+placement+body+url and has no direction/channel. Correspondence uses direction+channel and normally showOnWishlist=false. statusAfter is only an atomic festival/creator pipeline transition. MCP entries are recorded as createdBy=ai.',
      inputSchema: z.object({
        gameId: id('Game'),
        ...activityFields,
      }),
    },
    (a) =>
      run(() => {
        validateActivity(a)
        return caller.activities.create({ ...a, subjectType: a.subjectType ?? 'project', createdBy: 'ai' })
      }),
  )
  registerTool(
    'update_activity',
    {
      description: 'Edit an existing activity, including its text, date, subject, or wishlist-chart flag.',
      inputSchema: z.object({
        id: id('Activity'),
        ...activityFields,
      }),
    },
    ({ id, ...patch }) =>
      run(async () => {
        const current = await caller.activities.get({ id })
        if (!current) throw new Error('Activity not found')
        validateActivity({ ...current, ...patch })
        return caller.activities.update({ id, patch })
      }),
  )
  registerTool(
    'delete_activity',
    { description: 'Delete one activity by id.', inputSchema: z.object({ id: z.string() }) },
    (a) => run(() => caller.activities.remove(a)),
  )
  registerTool(
    'create_festival',
    {
      description:
        'Create one shared festival/showcase/sale. Dates must be ISO YYYY-MM-DD; use endDate for ranges and applyDeadline for submission deadline.',
      inputSchema: z.object(festivalInput),
    },
    (a) => run(() => caller.festivals.create(a)),
  )
  registerTool(
    'update_festival',
    {
      description: 'Update one shared festival by id. Use null to clear optional fields. Dates must be ISO YYYY-MM-DD.',
      inputSchema: z.object(festivalPatch),
    },
    ({ id, ...patch }) => run(() => caller.festivals.update({ id, ...patch })),
  )
  registerTool(
    'import_festivals',
    {
      description:
        'Bulk upsert shared festivals from a structured source. Upserts by normalized name + startDate, so repeated imports update instead of duplicating.',
      inputSchema: z.object({ items: z.array(z.object(festivalInput)).min(1) }),
    },
    ({ items }) => run(() => caller.festivals.importMany({ items })),
  )
  registerTool(
    'pick_festival',
    {
      description: 'Mark a shared festival as relevant for a game.',
      inputSchema: z.object({ gameId: z.string(), industryEventId: z.string() }),
    },
    (a) => run(() => caller.festivals.pick(a)),
  )
  registerTool(
    'unpick_festival',
    {
      description: 'Remove a shared festival from a game.',
      inputSchema: z.object({ gameId: z.string(), industryEventId: z.string() }),
    },
    (a) => run(() => caller.festivals.unpick(a)),
  )
  registerTool(
    'set_festival_status',
    {
      description: 'Set a game-specific festival status: none/materials/submitted/replied/approved/rejected.',
      inputSchema: z.object({ gameId: z.string(), industryEventId: z.string(), status: pickStatus }),
    },
    (a) => run(() => caller.festivals.setStatus(a)),
  )

  // ---------- influencers / creators ----------
  const creatorCatalogueSearch = z.object({
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Search names, handles, channels, topics, played games, public contacts, descriptions and notes.'),
    gameId: id('Game').optional().describe('Adds this project’s pipeline state to each result.'),
    pickedOnly: z.boolean().optional().describe('Requires gameId; return only creators picked for that project.'),
    statuses: z
      .array(z.enum(['prospect', 'contacted', 'replied', 'agreed', 'published', 'closed']))
      .min(1)
      .max(6)
      .optional()
      .describe('Requires gameId; filter the project outreach pipeline.'),
    platforms: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
    languages: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
    hasContact: z.boolean().optional(),
    hasBusinessEmail: z.boolean().optional(),
    doNotContact: z.boolean().optional(),
    sort: z.enum(['name', 'audience', 'avgViews', 'lastActiveAt', 'costUsd', 'updatedAt']).optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(25).optional().describe('Defaults to 20; maximum 25 keeps payloads bounded.'),
    offset: z.number().int().min(0).optional().describe('Use nextOffset from the previous page.'),
  })
  registerTool(
    'list_creators',
    {
      description:
        'List a compact page of the global creator/contact catalogue. Filters and sorting run in SQLite; use nextOffset to continue and get_creator for complete evidence and notes.',
      inputSchema: creatorCatalogueSearch,
    },
    (a) => run(() => caller.creators.search(a)),
  )
  registerTool(
    'search_creators',
    {
      description:
        'Search the global creator/contact catalogue in SQLite before returning data. Results include compact channel/contact summaries and optional project pipeline state; load only selected full cards with get_creator.',
      inputSchema: creatorCatalogueSearch,
    },
    (a) => run(() => caller.creators.search(a)),
  )
  registerTool(
    'get_creator',
    {
      description:
        'Get every stored catalogue field for one creator/outlet, including structured channel, topic, played-game and public-contact arrays.',
      inputSchema: z.object({ id: id('Creator') }),
    },
    (a) =>
      run(async () => {
        const row = await caller.creators.get(a)
        return row ? presentCreator(row) : null
      }),
  )
  registerTool(
    'list_creator_picks',
    {
      description:
        'List a compact page of creators picked for a game, including pipeline state, collaboration cost and sent game keys. Follow nextOffset and use get_creator for full catalogue evidence.',
      inputSchema: z.object({
        gameId: id('Game'),
        statuses: z
          .array(z.enum(['prospect', 'contacted', 'replied', 'agreed', 'published', 'closed']))
          .min(1)
          .max(6)
          .optional(),
        limit: z.number().int().min(1).max(25).optional().describe('Defaults to 20.'),
        offset: z.number().int().min(0).optional().describe('Use nextOffset from the previous page.'),
      }),
    },
    (a) => run(() => caller.creators.search({ ...a, pickedOnly: true })),
  )
  registerTool(
    'list_creator_touches',
    {
      description:
        'List a compact page of correspondence journal entries for one creator in one game. Follow nextOffset and use get_activity for the full message body.',
      inputSchema: z.object({
        gameId: id('Game'),
        creatorId: id('Creator'),
        search: z.string().min(1).max(200).optional(),
        from: day.optional(),
        to: day.optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Defaults to 20.'),
        offset: z.number().int().min(0).optional().describe('Use nextOffset from the previous page.'),
      }),
    },
    ({ creatorId, ...a }) =>
      run(() => caller.activities.search({ ...a, subjectType: 'creator', subjectId: creatorId })),
  )
  registerTool(
    'create_creator',
    {
      description:
        'Add a creator/outlet to the shared catalogue. Identity is deduplicated by canonical channel URL. Supply structured channels/topics/playedGames/public business contacts; never encode JSON manually and never store private personal data.',
      inputSchema: z.object(creatorFields),
    },
    (a) => run(() => caller.creators.create(toCreatorInput(a) as Parameters<typeof caller.creators.create>[0])),
  )
  registerTool(
    'update_creator',
    {
      description:
        'Update any creator/outlet catalogue facts. Structured channels/topics/playedGames/contacts replace their whole stored arrays when supplied; omit a field to preserve it and use null to clear nullable scalar fields.',
      inputSchema: z.object({
        id: id('Creator'),
        ...Object.fromEntries(Object.entries(creatorFields).map(([key, value]) => [key, value.optional()])),
      }),
    },
    ({ id, ...fields }) =>
      run(() =>
        caller.creators.update({
          id,
          ...(toCreatorInput(fields) as Omit<Parameters<typeof caller.creators.update>[0], 'id'>),
        }),
      ),
  )
  registerTool(
    'pick_creator',
    {
      description: "Pick a catalogue creator into a game's outreach pipeline.",
      inputSchema: z.object({
        gameId: z.string(),
        creatorId: z.string(),
        keysSent: z.array(z.string()).optional().describe('Game/product keys already sent for this project.'),
      }),
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
  registerTool(
    'update_creator_keys',
    {
      description: 'Replace the game/product keys recorded as sent to one creator for one project.',
      inputSchema: z.object({
        gameId: id('Game'),
        creatorId: id('Creator'),
        keysSent: z.array(z.string()).describe('Complete replacement list; use an empty array to clear.'),
      }),
    },
    ({ keysSent, ...a }) => run(() => caller.creators.updatePick({ ...a, keysSentJson: JSON.stringify(keysSent) })),
  )
  registerTool(
    'unpick_creator',
    {
      description: 'Remove a creator from one game outreach pipeline without deleting the shared catalogue entry.',
      inputSchema: z.object({ gameId: id('Game'), creatorId: id('Creator') }),
    },
    (a) => run(() => caller.creators.unpick(a)),
  )
  registerTool(
    'set_creator_status',
    {
      description: "Set a creator's pipeline stage for a game: prospect/contacted/replied/agreed/published/closed.",
      inputSchema: z.object({
        gameId: z.string(),
        creatorId: z.string(),
        pipelineStatus,
        closedReason: z.enum(['declined', 'no_response', 'done']).nullable().optional(),
        agreedCostUsd: z.number().int().nullable().optional(),
      }),
    },
    (a) => run(() => caller.creators.setStatus(a)),
  )
  registerTool(
    'log_touch',
    {
      description:
        'Atomically log one creator correspondence touch and advance the pipeline. Returns the saved touch and verified resulting pick. Supply requestId so retries cannot duplicate it.',
      inputSchema: z.object({
        gameId: id('Game'),
        ...creatorTouchFields,
        requestId: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Stable unique key for this real-world touch; reuse the same key when retrying.'),
      }),
    },
    (a) => run(() => caller.creators.logTouch({ ...a, createdBy: 'ai' })),
  )
  registerTool(
    'log_touches_bulk',
    {
      description:
        'Atomically log 1-50 creator correspondence touches in one serialized batch. Every item requires a requestId, so retrying the whole batch is safe. Returns verified touches and resulting pipeline picks.',
      inputSchema: z.object({
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
      }),
    },
    ({ gameId, items }) =>
      run(() => caller.creators.logTouchesBulk({ gameId, items: items.map((item) => ({ ...item, createdBy: 'ai' })) })),
  )

  // ---------- Multi-platform creator discovery ----------
  registerTool(
    'list_creator_discovery_profiles',
    {
      description: 'List reusable multi-platform discovery profiles and reference games/topic facets for one project.',
      inputSchema: z.object({ gameId: id('Game') }),
    },
    (a) => run(() => caller.creatorDiscovery.profiles(a)),
  )
  registerTool(
    'create_creator_discovery_profile',
    {
      description:
        'Create a project-scoped deterministic creator search profile. Platforms are temporary run settings: start_creator_discovery can select them, or omit them to use every connected source. This does not start a run and never accepts an API key.',
      inputSchema: z.object(discoveryProfileFields),
    },
    (a) =>
      run(() =>
        caller.creatorDiscovery.createProfile(a as Parameters<typeof caller.creatorDiscovery.createProfile>[0]),
      ),
  )
  registerTool(
    'start_creator_discovery',
    {
      description:
        'Queue one background creator search. Select the useful platforms for this run, or omit platforms to use every connected source. First show the exact profile inputs and platforms and get one user confirmation. Active or fresh duplicates with the same platform selection are reused automatically. The desktop app owns protected keys and executes the queue.',
      inputSchema: z.object({
        profileId: id('Creator discovery profile'),
        platforms: z
          .array(z.enum(['youtube', 'instagram', 'tiktok', 'x']))
          .min(1)
          .max(4)
          .optional()
          .describe(
            'Temporary platform selection for this run. Recommended for email outreach: youtube + instagram; add tiktok for a broader second wave. Omit to use every connected source.',
          ),
        forceNew: z
          .boolean()
          .optional()
          .describe(
            'Normally false. True bypasses only reuse of a fresh completed run, never active-run deduplication.',
          ),
      }),
    },
    (a) =>
      run(() =>
        caller.creatorDiscovery.start({
          profileId: a.profileId,
          forceNew: a.forceNew ?? false,
          platforms: a.platforms?.map((platform) => (platform === 'x' ? 'twitter' : platform)),
        }),
      ),
  )
  registerTool(
    'list_creator_discovery_runs',
    {
      description:
        'List a compact page of durable multi-platform search history, progress, result-state counts and stable issue/recovery metadata for one project or profile. Follow nextOffset to reach older waves. Explain issue.code in the user’s language instead of repeating the raw technical error.',
      inputSchema: z.object({
        gameId: id('Game'),
        profileId: id('Creator discovery profile').optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Defaults to 50.'),
        offset: z.number().int().min(0).optional().describe('Use nextOffset from the previous page.'),
      }),
    },
    (a) =>
      run(async () => {
        const limit = a.limit ?? 50
        const offset = a.offset ?? 0
        const rows = await caller.creatorDiscovery.runs({ ...a, limit: limit + 1, offset })
        const hasMore = rows.length > limit
        return {
          offset,
          limit,
          returned: Math.min(rows.length, limit),
          nextOffset: hasMore ? offset + limit : null,
          items: rows.slice(0, limit),
        }
      }),
  )
  registerTool(
    'get_creator_discovery_run',
    {
      description:
        'Get one discovery run artifact, including its snapshotted search inputs, progress and stable issue/recovery metadata. Explain issue.code in the user’s language instead of repeating the raw technical error.',
      inputSchema: z.object({ id: id('Creator discovery run') }),
    },
    (a) => run(() => caller.creatorDiscovery.getRun(a)),
  )
  registerTool(
    'control_creator_discovery_run',
    {
      description:
        'Pause, resume or cancel a queued/background creator discovery run. Resume safely continues partial provider responses; saved creators, evidence and contacts stay deduplicated.',
      inputSchema: z.object({
        id: id('Creator discovery run'),
        action: z.enum(['pause', 'resume', 'cancel']),
      }),
    },
    ({ id, action }) =>
      run(() =>
        action === 'pause'
          ? caller.creatorDiscovery.pause({ id })
          : action === 'resume'
            ? caller.creatorDiscovery.resume({ id })
            : caller.creatorDiscovery.cancel({ id }),
      ),
  )
  registerTool(
    'list_creator_discovery_candidates',
    {
      description:
        'Inspect a compact page of durable saved results for any historical run: platform, deterministic fit, matched-reference count, representative post/video evidence and deduplicated public contacts. Follow nextOffset while it is non-null. Lower filters for later outreach waves. Nothing is added to project Contacts until promoted.',
      inputSchema: z.object({
        runId: id('Creator discovery run'),
        status: z.enum(['staged', 'promoted', 'dismissed']).optional(),
        minFit: z.number().int().min(0).max(100).optional(),
        minReferenceMatches: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Minimum number of distinct reference games/topic facets matched across public content.'),
        requireBusinessEmail: z
          .boolean()
          .optional()
          .describe('When true, return only creators with a public business email found by the run.'),
        offset: z.number().int().min(0).optional().describe('Zero-based page offset; use nextOffset to continue.'),
        limit: z.number().int().min(1).max(20).optional().describe('Defaults to 10.'),
        evidenceLimit: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe('Representative highest-view evidence rows per candidate; defaults to 2.'),
      }),
    },
    (a) =>
      run(async () => {
        const limit = a.limit ?? 10
        const offset = a.offset ?? 0
        const candidates = await caller.creatorDiscovery.candidates({
          ...a,
          minFit: a.minFit ?? 0,
          minReferenceMatches: a.minReferenceMatches ?? 1,
          requireBusinessEmail: a.requireBusinessEmail ?? false,
          offset,
          limit: limit + 1,
        })
        const evidenceLimit = a.evidenceLimit ?? 2
        const hasMore = candidates.length > limit
        const items = candidates.slice(0, limit).map(({ result, candidate, contacts, evidence }) => {
          const deduplicatedContacts = new Map<string, (typeof contacts)[number] & { sourceCount: number }>()
          for (const contact of contacts) {
            const key = `${contact.type}\u0000${contact.normalizedValue || contact.value}`
            const existing = deduplicatedContacts.get(key)
            if (!existing) {
              deduplicatedContacts.set(key, { ...contact, sourceCount: 1 })
              continue
            }
            existing.sourceCount += 1
            if ((contact.confidence ?? 0) > (existing.confidence ?? 0)) {
              deduplicatedContacts.set(key, { ...contact, sourceCount: existing.sourceCount })
            }
          }
          const compactContacts = [...deduplicatedContacts.values()]
            .sort(
              (left, right) =>
                Number(right.type === 'business_email') - Number(left.type === 'business_email') ||
                (right.confidence ?? 0) - (left.confidence ?? 0),
            )
            .slice(0, 5)
            .map(({ normalizedValue: _normalizedValue, ...contact }) => contact)
          const compactEvidence = [...evidence]
            .sort(
              (left, right) =>
                (right.viewCount ?? 0) - (left.viewCount ?? 0) ||
                (right.publishedAt ?? '').localeCompare(left.publishedAt ?? ''),
            )
            .slice(0, evidenceLimit)
            .map(({ matchedTermsJson, ...item }) => ({ ...item, matchedTerms: parseArray(matchedTermsJson) }))
          const { matchedReferencesJson, fitReasonsJson, ...resultFields } = result
          const { description, uploadsPlaylistId: _uploadsPlaylistId, ...candidateFields } = candidate
          return {
            result: {
              ...resultFields,
              matchedReferences: parseArray(matchedReferencesJson),
              fitReasons: parseArray(fitReasonsJson),
            },
            candidate: {
              ...candidateFields,
              descriptionExcerpt: description
                ? `${description.slice(0, 300)}${description.length > 300 ? '…' : ''}`
                : '',
            },
            contactEvidenceCount: contacts.length,
            uniqueContactCount: deduplicatedContacts.size,
            contacts: compactContacts,
            evidenceCount: evidence.length,
            evidence: compactEvidence,
          }
        })
        return {
          offset,
          limit,
          returned: items.length,
          nextOffset: hasMore ? offset + limit : null,
          items,
        }
      }),
  )
  registerTool(
    'review_creator_discovery_candidate',
    {
      description:
        'Add one staged candidate to project Contacts, hide it, or return a previously hidden historical result to the new-results pool. Promotion is idempotent: existing cards are enriched without overwriting manual fields, per-project status or correspondence.',
      inputSchema: z.object({
        runId: id('Creator discovery run'),
        candidateId: id('Creator discovery candidate'),
        decision: z.enum(['promote', 'dismiss', 'restore']),
      }),
    },
    ({ decision, ...a }) =>
      run(() =>
        decision === 'promote'
          ? caller.creatorDiscovery.promote(a)
          : decision === 'dismiss'
            ? caller.creatorDiscovery.dismiss(a)
            : caller.creatorDiscovery.restore(a),
      ),
  )
  registerTool(
    'preview_creator_discovery_candidate_batch',
    {
      description:
        'Return exact counts for a staged-channel fit/reference/email selection, including how many cards the next batch will create versus safely enrich. Use this before a bulk decision; it does not mutate results or expose the whole candidate list to context.',
      inputSchema: z.object({
        runId: id('Creator discovery run'),
        minFit: z.number().int().min(0).max(100),
        minReferenceMatches: z.number().int().min(1).max(100).optional(),
        requireBusinessEmail: z.boolean().optional(),
        batchLimit: z.number().int().min(1).max(1_000).optional(),
      }),
    },
    (a) =>
      run(() =>
        caller.creatorDiscovery.reviewPreview({
          ...a,
          minReferenceMatches: a.minReferenceMatches ?? 1,
          requireBusinessEmail: a.requireBusinessEmail ?? false,
          batchLimit: a.batchLimit ?? 500,
        }),
      ),
  )
  registerTool(
    'review_creator_discovery_candidates_bulk',
    {
      description:
        'Process a confirmed group without reviewing channels one by one: promote or hide staged results, or restore hidden historical results for a later wave. First preview a promotion with the same fit/reference/email filter so the user sees exact create/enrich counts. Existing cards keep manual fields, project status and correspondence; contacts/evidence are merged without duplicates. Promotion is accepted as a durable background operation and returns its operation id immediately; use get_creator_promotion_operation to follow it. Promotion requires exact candidateIds or an explicit minFit threshold.',
      inputSchema: z.object({
        runId: id('Creator discovery run'),
        decision: z.enum(['promote', 'dismiss', 'restore']),
        candidateIds: z
          .array(id('Creator discovery candidate'))
          .min(1)
          .max(1_000)
          .optional()
          .describe('Exact candidates from list_creator_discovery_candidates; preferred for a frozen selection.'),
        minFit: z.number().int().min(0).max(100).optional(),
        minReferenceMatches: z.number().int().min(1).max(100).optional(),
        requireBusinessEmail: z.boolean().optional(),
        limit: z.number().int().min(1).max(1_000).optional(),
        confirm: z
          .literal(true)
          .describe('Must be true after the user has seen and approved the exact selection count.'),
      }),
    },
    ({ confirm: _confirm, ...a }) => {
      if (a.decision === 'promote' && !a.candidateIds?.length && a.minFit === undefined) {
        return run(() =>
          Promise.reject(new Error('Bulk promotion requires candidateIds or an explicit minFit threshold')),
        )
      }
      return run(() =>
        caller.creatorDiscovery.reviewBulk({
          ...a,
          minFit: a.minFit ?? 0,
          minReferenceMatches: a.minReferenceMatches ?? 1,
          requireBusinessEmail: a.requireBusinessEmail ?? false,
          limit: a.limit ?? 500,
        }),
      )
    },
  )
  registerTool(
    'get_creator_promotion_operation',
    {
      description:
        'Get durable bulk-promotion progress and up to 20 failed candidate errors. Terminal states are completed, partial, failed or cancelled.',
      inputSchema: z.object({ id: id('Creator promotion operation') }),
    },
    (a) => run(() => caller.creatorDiscovery.promotionOperation(a)),
  )
  registerTool(
    'control_creator_promotion_operation',
    {
      description:
        'Cancel the remaining candidates in an active bulk promotion, or retry only failed candidates in a partial/failed operation. Completed candidates are never repeated.',
      inputSchema: z.object({
        id: id('Creator promotion operation'),
        action: z.enum(['cancel', 'retry']),
        confirm: z.literal(true),
      }),
    },
    ({ id: operationId, action, confirm: _confirm }) =>
      run(() =>
        action === 'cancel'
          ? caller.creatorDiscovery.cancelPromotion({ id: operationId })
          : caller.creatorDiscovery.retryPromotion({ id: operationId }),
      ),
  )

  // ---------- GMass outreach automation ----------
  registerTool(
    'preview_gmass_campaign',
    {
      description:
        'Preview exact personalized GMass recipients/messages without creating drafts or sending. Always run this before create_gmass_campaign.',
      inputSchema: z.object(gmassCampaignInput),
    },
    (a) => run(() => caller.gmass.preview(a)),
  )
  registerTool(
    'create_gmass_campaign',
    {
      description:
        'Freeze a GMass outreach batch after preview. This does not dispatch it; approve_gmass_campaign is a separate explicit action.',
      inputSchema: z.object({
        ...gmassCampaignInput,
        name: z.string().min(1).max(160),
        fromEmail: z.string().email().describe('Authenticated GMass/Gmail From address.'),
        messageType: z.enum(['plain', 'html']).optional(),
        sendMode: z.enum(['draft', 'send', 'schedule']),
        sendAt: z.string().nullable().optional().describe('Required for schedule mode.'),
        openTracking: z.boolean().optional(),
        clickTracking: z.boolean().optional(),
        emailsPerDay: z.number().int().positive().max(2000).nullable().optional(),
      }),
    },
    (a) => run(() => caller.gmass.create({ ...a, requestedBy: 'mcp' })),
  )
  registerTool(
    'approve_gmass_campaign',
    {
      description:
        'Explicitly approve and queue a frozen GMass campaign. The desktop worker owns the encrypted API key and dispatches queued work when MarCat is running.',
      inputSchema: z.object({
        id: id('GMass campaign'),
        confirm: z.literal(true).describe('Must be true after the exact recipient count and messages were reviewed.'),
        expectedRecipientCount: z.number().int().positive(),
        contentHash: z.string().min(16).describe('Hash returned by create_gmass_campaign.'),
      }),
    },
    (a) => run(() => caller.gmass.approve(a)),
  )
  registerTool(
    'list_gmass_campaigns',
    {
      description: 'List GMass outreach batches with aggregate per-recipient delivery states.',
      inputSchema: z.object({ gameId: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
    },
    (a) => run(() => caller.gmass.list(a)),
  )
  registerTool(
    'get_gmass_campaign',
    {
      description: 'Get one GMass batch with every frozen recipient, exact message and delivery state.',
      inputSchema: z.object({ id: id('GMass campaign') }),
    },
    (a) => run(() => caller.gmass.get(a)),
  )
  registerTool(
    'sync_gmass_campaign',
    {
      description:
        'Request delivery/reply/bounce synchronization. The desktop worker performs it with the encrypted GMass key.',
      inputSchema: z.object({ id: id('GMass campaign') }),
    },
    (a) => run(() => caller.gmass.requestSync(a)),
  )
  registerTool(
    'retry_gmass_campaign',
    {
      description: 'Retry failed recipients in a GMass batch. Already successful recipients are not recreated.',
      inputSchema: z.object({ id: id('GMass campaign') }),
    },
    (a) => run(() => caller.gmass.retry(a)),
  )

  const createServer = () => {
    const server = new McpServer({ name: 'marcat', version: __MARCAT_VERSION__ })
    for (const register of toolRegistrations) register(server)
    return server
  }

  const stdioHandle: { current?: ReturnType<typeof serveStdio> } = {}
  const httpHandle: { server?: ReturnType<typeof createHttpServer>; handler?: McpHttpHandler } = {}
  let shutdownPromise: Promise<void> | undefined
  const shutdown = (reason: string, exitAfterCleanup = false): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    appendMcpLog(`shutdown reason=${reason} ${memorySummary()}`)
    console.error(`[marcat-mcp] shutting down (${reason})`)
    shutdownPromise = (async () => {
      // If startup is currently reconciling a workspace, give it a short window
      // to finish before closing its watchers and the shared database handle.
      await Promise.race([
        workspaceStartup,
        new Promise<void>((resolvePromise) => {
          const timer = setTimeout(resolvePromise, 2_000)
          timer.unref()
        }),
      ])
      await stdioHandle.current?.close()
      const httpClose = httpHandle.server
        ? new Promise<void>((resolvePromise) => {
            httpHandle.server?.close(() => resolvePromise())
            httpHandle.server?.closeAllConnections()
          })
        : Promise.resolve()
      await Promise.all([httpHandle.handler?.close(), httpClose])
      await workspace.stop()
      client.close()
    })()
      .catch((error) => console.error('[marcat-mcp] shutdown failed:', formatToolError(error)))
      .finally(() => {
        if (exitAfterCleanup) process.exit(0)
      })
    return shutdownPromise
  }
  process.once('SIGINT', () => void shutdown('SIGINT', true))
  process.once('SIGTERM', () => void shutdown('SIGTERM', true))
  process.once('beforeExit', () => void shutdown('beforeExit'))

  if (process.argv.includes('--http')) {
    const host = '127.0.0.1'
    const port = httpPort()
    const fallbackHost = `${host}:${port}`
    const handler = createMcpHandler(() => createServer(), {
      legacy: 'stateless',
      responseMode: 'auto',
      keepAliveMs: 15_000,
      onerror: (error) => {
        appendMcpLog('HTTP transport failed', error)
        console.error('[marcat-mcp] HTTP transport failed:', formatToolError(error))
      },
    })
    httpHandle.handler = handler
    const httpServer = createHttpServer((request, response) => {
      void (async () => {
        const pathname = new URL(request.url ?? '/', `http://${fallbackHost}`).pathname
        if (pathname === '/health') {
          response.setHeader('content-type', 'application/json; charset=utf-8')
          response.end(JSON.stringify({ name: 'marcat', version: __MARCAT_VERSION__, dbPath: path, pid: process.pid }))
          return
        }
        if (pathname !== '/mcp') {
          response.statusCode = 404
          response.end('Not found')
          return
        }
        const webRequest = await toWebRequest(request, fallbackHost)
        const rejected =
          hostHeaderValidationResponse(webRequest, localhostAllowedHostnames()) ??
          originValidationResponse(webRequest, localhostAllowedOrigins())
        await writeWebResponse(rejected ?? (await handler.fetch(webRequest)), response)
      })().catch((error) => {
        appendMcpLog('HTTP request failed', error)
        if (!response.headersSent) response.statusCode = 500
        if (!response.writableEnded) response.end('Internal server error')
      })
    })
    httpHandle.server = httpServer
    httpServer.on('clientError', (error, socket) => {
      appendMcpLog('HTTP client error', error)
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onStartupError = (error: Error) => rejectPromise(error)
      httpServer.once('error', onStartupError)
      httpServer.listen(port, host, () => {
        httpServer.off('error', onStartupError)
        httpServer.on('error', (error) => {
          appendMcpLog('HTTP listener failed', error)
          void shutdown('HTTP listener failed', true)
        })
        resolvePromise()
      })
    })
    appendMcpLog(`HTTP transport ready url=http://${fallbackHost}/mcp ${memorySummary()}`)
    console.error(`[marcat-mcp] HTTP transport ready (http://${fallbackHost}/mcp, db: ${path})`)
  } else {
    process.stdin.once('end', () => void shutdown('stdin ended', true))
    process.stdin.once('close', () => void shutdown('stdin closed', true))
    process.stdout.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') void shutdown('stdout closed', true)
      else {
        appendMcpLog('stdout failed', error)
        console.error('[marcat-mcp] stdout failed:', formatToolError(error))
      }
    })
    // v2's stdio entry negotiates both the legacy initialize flow and the
    // stateless MCP 2026-07-28 wire protocol for the single pinned connection.
    const wireTransport = new StdioServerTransport()
    const closeWireTransport = wireTransport.close.bind(wireTransport)
    wireTransport.close = async () => {
      await closeWireTransport()
      // A logical transport failure does not necessarily end stdin. Stop the
      // workspace watchers explicitly so a disconnected MCP process cannot linger.
      if (!shutdownPromise) void shutdown('transport closed', true)
    }
    stdioHandle.current = serveStdio(() => createServer(), {
      transport: wireTransport,
      onerror: (error) => {
        appendMcpLog('transport failed', error)
        console.error('[marcat-mcp] transport failed:', formatToolError(error))
      },
    })
    appendMcpLog(`transport ready ${memorySummary()}`)
    console.error(`[marcat-mcp] transport ready (MCP 2026-07-28 + legacy, db: ${path})`)
  }
}

main().catch((e) => {
  appendMcpLog('fatal startup failure', e)
  console.error('[marcat-mcp] fatal:', e)
  process.exit(1)
})
