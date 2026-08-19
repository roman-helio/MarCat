import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * MarCat schema — Phase 0.
 *
 * Top-level entity is a GAME (each game is an independent workspace/space).
 * Marketing tasks, events, sources, wishlists, milestones, AI runs, etc. all
 * hang off a game and are introduced in later phases.
 */

const uuid = () => crypto.randomUUID()
const nowIso = () => new Date().toISOString()

/** Games = workspaces. Everything else FKs to game_id. */
export const games = sqliteTable(
  'games',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    steamAppId: integer('steam_app_id'),
    steamStoreUrl: text('steam_store_url'),
    /** ISO date (YYYY-MM-DD) of planned/actual release, if known. */
    releaseDate: text('release_date'),
    /** JSON array of target platforms with per-platform URLs: [{id,url}]. */
    platforms: text('platforms'),
    /** JSON array of official owned presences: [{type,url,label?}]. */
    officialLinks: text('official_links'),
    /** DevHub project key/id this game maps to (for task export via the cat). */
    devhubProject: text('devhub_project'),
    color: text('color').notNull().default('#27C281'),
    /** Short uppercase project key (e.g. "SALT"); task ids are `${key}-${seq}`. */
    key: text('key'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ keyUniq: uniqueIndex('games_key_unique').on(t.key) }),
)

/** Key/value app settings (theme, workspace prefs, etc.). Value is JSON text. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
})

/**
 * Project card = one-call briefing for agents. The game row keeps operational
 * identifiers; this row stores owner-maintained context that should not be
 * repeated in every task description.
 */
export const projectCards = sqliteTable('project_cards', {
  gameId: text('game_id')
    .primaryKey()
    .references(() => games.id, { onDelete: 'cascade' }),
  oneLiner: text('one_liner').notNull().default(''),
  description: text('description').notNull().default(''),
  audience: text('audience').notNull().default(''),
  positioning: text('positioning').notNull().default(''),
  repository: text('repository').notNull().default(''),
  branch: text('branch').notNull().default(''),
  devhubWikiUrl: text('devhub_wiki_url').notNull().default(''),
  agentNotes: text('agent_notes').notNull().default(''),
  /** JSON arrays: [{label,url}] and [{label,path?,url?}]. */
  linksJson: text('links_json').notNull().default('[]'),
  docsJson: text('docs_json').notNull().default('[]'),
  /** Last editor of the canonical project brief exposed as the required project-card insight. */
  updatedBy: text('updated_by', { enum: ['manual', 'mcp', 'ai'] })
    .notNull()
    .default('manual'),
  updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
})

/**
 * Durable project knowledge. Insights are intentionally separate from the dated
 * activity journal: they capture conclusions, audience learnings and validated
 * or rejected hypotheses that should inform future work.
 */
export const insights = sqliteTable(
  'insights',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdBy: text('created_by', { enum: ['manual', 'mcp', 'ai'] })
      .notNull()
      .default('manual'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ byGameUpdated: index('insights_game_updated').on(t.gameId, t.updatedAt) }),
)

/**
 * Append-only change feed. Lets the desktop app (and external MCP clients)
 * detect mutations made out-of-band and refresh, and gives the AI an audit trail.
 */
export const changeLog = sqliteTable('change_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  action: text('action', { enum: ['create', 'update', 'delete'] }).notNull(),
  at: text('at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
})

/* ---------------------- Open Markdown project workspace ---------------------- */

/**
 * Per-project opt-in filesystem workspace. Human-authored project data lives in
 * the visible `workspaceFolder` below `rootPath`; SQLite remains the query index
 * and stores enough sync state to reconcile safely after crashes/restarts.
 */
export const workspaceConfigs = sqliteTable('workspace_configs', {
  // Intentionally not an FK: a project deletion must leave its configured
  // workspace and durable quarantine outbox available long enough to archive
  // every human-authored file.
  gameId: text('game_id').primaryKey(),
  rootPath: text('root_path').notNull(),
  workspaceFolder: text('workspace_folder').notNull().default('MarCat'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  schemaVersion: integer('schema_version').notNull().default(1),
  lastScanAt: text('last_scan_at'),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
  updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
})

/** One row per Markdown document known to the synchronizer. */
export const workspaceFiles = sqliteTable(
  'workspace_files',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    relativePath: text('relative_path').notNull(),
    /** Hash on disk at the last successful observation. */
    contentHash: text('content_hash').notNull(),
    /** Common ancestor used to detect concurrent DB/file edits. */
    baseHash: text('base_hash').notNull(),
    baseContent: text('base_content').notNull(),
    revision: integer('revision').notNull().default(1),
    status: text('status', {
      enum: ['synced', 'dirty', 'conflict', 'missing', 'invalid', 'quarantined'],
    })
      .notNull()
      .default('synced'),
    missingSince: text('missing_since'),
    mtimeMs: integer('mtime_ms'),
    size: integer('size'),
    lastSyncedAt: text('last_synced_at').notNull().$defaultFn(nowIso),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    byPath: uniqueIndex('workspace_files_game_path_unique').on(t.gameId, t.relativePath),
    byEntity: uniqueIndex('workspace_files_game_entity_unique').on(t.gameId, t.entityType, t.entityId),
    byStatus: index('workspace_files_game_status').on(t.gameId, t.status),
  }),
)

/** Durable, user-visible diagnostics. Invalid/conflicting files are never dropped. */
export const workspaceSyncIssues = sqliteTable(
  'workspace_sync_issues',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id').notNull(),
    workspaceFileId: text('workspace_file_id').references(() => workspaceFiles.id, {
      onDelete: 'set null',
    }),
    kind: text('kind', {
      enum: ['invalid_yaml', 'invalid_document', 'conflict', 'duplicate_id', 'io', 'missing'],
    }).notNull(),
    severity: text('severity', { enum: ['warning', 'error'] })
      .notNull()
      .default('error'),
    relativePath: text('relative_path'),
    message: text('message').notNull(),
    detailsJson: text('details_json').notNull().default('{}'),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    byGameOpen: index('workspace_sync_issues_game_open').on(t.gameId, t.resolvedAt),
    byFile: index('workspace_sync_issues_file').on(t.workspaceFileId),
  }),
)

/**
 * Transactional hand-off from domain mutations to filesystem writes. A row is
 * removed from the active queue only by setting `processedAt`, so a crash cannot
 * silently lose an intended export.
 */
export const workspaceOutbox = sqliteTable(
  'workspace_outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    operation: text('operation', { enum: ['upsert', 'quarantine'] })
      .notNull()
      .default('upsert'),
    payloadJson: text('payload_json').notNull().default('{}'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    claimedAt: text('claimed_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    processedAt: text('processed_at'),
  },
  (t) => ({
    pending: index('workspace_outbox_pending').on(t.processedAt, t.nextAttemptAt, t.id),
    byEntity: index('workspace_outbox_entity').on(t.gameId, t.entityType, t.entityId),
  }),
)

/** Transaction-scoped marker used by import writes to suppress export triggers. */
export const workspaceImportGuard = sqliteTable(
  'workspace_import_guard',
  {
    gameId: text('game_id').notNull(),
    /** The exact entity being imported. Keeping the guard entity-scoped avoids
     * suppressing unrelated desktop/MCP writes in another process. */
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    owner: text('owner').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ identity: uniqueIndex('workspace_import_guard_identity').on(t.gameId, t.owner) }),
)

/* ----------------------------- Phase 1: planner ----------------------------- */

/** Important dated events (release, Steam Next Fest, sale) — drive countdowns/alarms. */
export const milestones = sqliteTable(
  'milestones',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: ['release', 'festival', 'sale', 'update', 'other'] })
      .notNull()
      .default('other'),
    /** ISO date YYYY-MM-DD. */
    date: text('date').notNull(),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(true),
    notes: text('notes'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ byGameDate: index('milestones_game_date').on(t.gameId, t.date) }),
)

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    milestoneId: text('milestone_id').references(() => milestones.id, { onDelete: 'set null' }),
    /** Per-game sequence number; the display id is `${game.key}-${seq}` (Jira-style). */
    seq: integer('seq'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: ['todo', 'doing', 'blocked', 'done', 'cancelled'] })
      .notNull()
      .default('todo'),
    priority: text('priority', { enum: ['low', 'med', 'high', 'urgent'] })
      .notNull()
      .default('med'),
    startDate: text('start_date'),
    dueDate: text('due_date'),
    reminderAt: text('reminder_at'),
    completedAt: text('completed_at'),
    /** Recurring tasks reopen after completion and advance to the next future due date. */
    recurrenceInterval: integer('recurrence_interval'),
    recurrenceUnit: text('recurrence_unit', { enum: ['day', 'week', 'month', 'year'] }),
    lastCompletedAt: text('last_completed_at'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    gameSeq: uniqueIndex('tasks_game_seq_unique').on(t.gameId, t.seq),
    byGameOrder: index('tasks_game_order').on(t.gameId, t.sortOrder, t.createdAt),
    byGameStatus: index('tasks_game_status').on(t.gameId, t.status),
    byMilestone: index('tasks_milestone').on(t.milestoneId),
  }),
)

/** Atomic per-game allocator. `lastSeq` is incremented in one UPSERT statement. */
export const taskCounters = sqliteTable('task_counters', {
  gameId: text('game_id')
    .primaryKey()
    .references(() => games.id, { onDelete: 'cascade' }),
  lastSeq: integer('last_seq').notNull().default(0),
})

export const taskChecklistItems = sqliteTable(
  'task_checklist_items',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    done: integer('done', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({ byTaskOrder: index('task_checklist_task_order').on(t.taskId, t.sortOrder) }),
)

/** blocker must finish before blocked can proceed. */
export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    blockerTaskId: text('blocker_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    blockedTaskId: text('blocked_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    pair: uniqueIndex('task_dependencies_pair_unique').on(t.blockerTaskId, t.blockedTaskId),
    byBlocked: index('task_dependencies_blocked').on(t.blockedTaskId),
    byBlocker: index('task_dependencies_blocker').on(t.blockerTaskId),
  }),
)

export const taskLinks = sqliteTable(
  'task_links',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    relatedTaskId: text('related_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    relation: text('relation').notNull().default('related'),
  },
  (t) => ({
    pair: uniqueIndex('task_links_pair_unique').on(t.taskId, t.relatedTaskId, t.relation),
    byRelated: index('task_links_related').on(t.relatedTaskId),
  }),
)

/**
 * Tags = the single grouping/scheduling entity. A plain tag is an undated track
 * label; a tag with a `targetDate` is a deadline (countdown + at-risk alarm +
 * date-shift cascade) — this absorbed the former `milestones` concept.
 */
export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#888888'),
    /** Coloured labels are opt-in; neutral labels keep dense task views calm. */
    colorEnabled: integer('color_enabled', { mode: 'boolean' }).notNull().default(false),
    /** ISO date YYYY-MM-DD — set makes this tag a dated deadline. */
    targetDate: text('target_date'),
    type: text('type', { enum: ['release', 'festival', 'sale', 'update', 'track', 'other'] })
      .notNull()
      .default('track'),
  },
  (t) => ({ byGameName: index('tags_game_name').on(t.gameId, t.name) }),
)

export const taskTagLinks = sqliteTable(
  'task_tag_links',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pair: uniqueIndex('task_tag_links_pair_unique').on(t.taskId, t.tagId),
    byTag: index('task_tag_links_tag').on(t.tagId),
  }),
)

/* --------------------- Phase 2: events + wishlists --------------------- */

/**
 * Project activity journal. A wishlist event is not a separate entity: it is an
 * activity with `showOnWishlist=true`. The physical table keeps its historical
 * `events` name so existing metrics/UTM/source foreign keys remain stable.
 */
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    /** ISO date YYYY-MM-DD when the event happened. */
    occurredAt: text('occurred_at').notNull(),
    /** One clear parent within the project; future subject kinds need no DB migration. */
    subjectType: text('subject_type', { enum: ['project', 'task', 'festival', 'creator'] })
      .notNull()
      .default('project'),
    subjectId: text('subject_id'),
    /** Durable display fallback if the linked object is later removed or renamed. */
    subjectLabel: text('subject_label'),
    /** Only these activities are rendered and analysed as wishlist-chart events. */
    showOnWishlist: integer('show_on_wishlist', { mode: 'boolean' }).notNull().default(true),
    direction: text('direction', { enum: ['outbound', 'inbound'] }),
    /** email | dm | form | call | meeting | other */
    channel: text('channel'),
    /** Optional domain status applied atomically with the activity (e.g. replied). */
    statusAfter: text('status_after'),
    /** Preserved when legacy creator correspondence used an outreach template. */
    templateId: text('template_id'),
    /** Content/beat shape: post | video | stream | press | festival | update | other. */
    type: text('type').notNull().default('other'),
    /** Normalized service: youtube | twitter | tiktok | instagram | reddit | telegram | steam | press | other. */
    platform: text('platform'),
    /** Placement within a platform: subreddit, account/handle, Steam News hub, publication, community, etc. */
    placement: text('placement'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    url: text('url'),
    /** Latest known reach metrics (history arrives with source connectors in Phase 5). */
    views: integer('views'),
    likes: integer('likes'),
    comments: integer('comments'),
    isOwn: integer('is_own', { mode: 'boolean' }).notNull().default(true),
    sourceId: text('source_id'),
    externalId: text('external_id'),
    /** Stable caller key used to make retryable writes create at most one activity. */
    idempotencyKey: text('idempotency_key'),
    /** Creator this event (a published video/article = a marketing beat) is attributed to. */
    creatorId: text('creator_id'),
    createdBy: text('created_by', { enum: ['manual', 'source', 'ai'] })
      .notNull()
      .default('manual'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    byGameDate: index('events_game_date').on(t.gameId, t.occurredAt, t.createdAt),
    bySubject: index('events_game_subject').on(t.gameId, t.subjectType, t.subjectId, t.occurredAt),
    byWishlist: index('events_game_wishlist').on(t.gameId, t.showOnWishlist, t.occurredAt),
    idempotencyKeyUniq: uniqueIndex('events_idempotency_key_unique').on(t.idempotencyKey),
  }),
)

/** Daily Steam wishlist data (imported from CSV or entered manually). */
export const wishlistPoints = sqliteTable(
  'wishlist_points',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    adds: integer('adds'),
    deletes: integer('deletes'),
    /** Steam removes converted wishlists from the outstanding balance. */
    purchasesAndActivations: integer('purchases_and_activations'),
    gifts: integer('gifts'),
    balance: integer('balance'),
    net: integer('net'),
    source: text('source', { enum: ['csv', 'manual', 'api'] })
      .notNull()
      .default('manual'),
    importBatchId: text('import_batch_id'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ gameDate: uniqueIndex('wishlist_points_game_date').on(t.gameId, t.date) }),
)

export const wishlistImports = sqliteTable('wishlist_imports', {
  id: text('id').primaryKey().$defaultFn(uuid),
  gameId: text('game_id')
    .notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  filename: text('filename'),
  /** SHA-256 of the raw CSV, used to recognise exact repeat imports. */
  checksum: text('checksum'),
  importedAt: text('imported_at').notNull().$defaultFn(nowIso),
  rows: integer('rows').notNull().default(0),
  columnMapping: text('column_mapping'),
  warningsJson: text('warnings_json').notNull().default('[]'),
})

/**
 * Raw Steam traffic exports used by Analytics. We keep each import intact as
 * JSON because Steam changes the dimensional columns between the daily,
 * country and store-traffic reports. Calculations always use the newest import
 * of each kind, so re-importing an overlapping report never double-counts it.
 */
export const analyticsImports = sqliteTable(
  'analytics_imports',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['utm_daily', 'utm_country', 'steam_traffic'] }).notNull(),
    filename: text('filename'),
    /** SHA-256 of the raw CSV, used to recognise exact repeat imports. */
    checksum: text('checksum'),
    dateFrom: text('date_from'),
    dateTo: text('date_to'),
    rows: integer('rows').notNull().default(0),
    rowsJson: text('rows_json').notNull().default('[]'),
    warningsJson: text('warnings_json').notNull().default('[]'),
    parserVersion: integer('parser_version').notNull().default(1),
    importedAt: text('imported_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ byGameKind: index('analytics_imports_game_kind').on(t.gameId, t.kind, t.importedAt) }),
)

/** A durable marketing campaign plan layered over one or more imported UTM tuples. */
export const marketingCampaigns = sqliteTable(
  'marketing_campaigns',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    objective: text('objective', { enum: ['wishlist_growth', 'traffic', 'sales', 'awareness'] })
      .notNull()
      .default('wishlist_growth'),
    status: text('status', { enum: ['planned', 'active', 'completed', 'archived'] })
      .notNull()
      .default('planned'),
    plannedStart: text('planned_start'),
    plannedEnd: text('planned_end'),
    evaluationWindowDays: integer('evaluation_window_days').notNull().default(3),
    budgetCents: integer('budget_cents'),
    spendCents: integer('spend_cents'),
    currency: text('currency').notNull().default('USD'),
    notes: text('notes'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ byGameStatus: index('marketing_campaigns_game_status').on(t.gameId, t.status, t.updatedAt) }),
)

/** One imported UTM tuple assigned to a durable marketing campaign. */
export const campaignTouchpoints = sqliteTable(
  'campaign_touchpoints',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => marketingCampaigns.id, { onDelete: 'cascade' }),
    canonicalKey: text('canonical_key').notNull(),
    source: text('source').notNull().default(''),
    campaign: text('campaign').notNull().default(''),
    medium: text('medium').notNull().default(''),
    content: text('content').notNull().default(''),
    term: text('term').notNull().default(''),
    eventId: text('event_id').references(() => events.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    byCampaign: index('campaign_touchpoints_campaign').on(t.campaignId, t.createdAt),
    uniqueTuple: uniqueIndex('campaign_touchpoints_game_tuple').on(t.gameId, t.canonicalKey),
  }),
)

/** UTM-tagged Steam links for attributing traffic to marketing activities. */
export const utmLinks = sqliteTable('utm_links', {
  id: text('id').primaryKey().$defaultFn(uuid),
  gameId: text('game_id')
    .notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  baseUrl: text('base_url').notNull(),
  utmSource: text('utm_source').notNull(),
  utmMedium: text('utm_medium').notNull(),
  utmCampaign: text('utm_campaign').notNull(),
  utmContent: text('utm_content'),
  utmTerm: text('utm_term'),
  fullUrl: text('full_url').notNull(),
  eventId: text('event_id'),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
})

/* --------------------- Phase 5: sources / connectors --------------------- */

/** A configured content source for a game (one social account or a Steam CSV folder). */
export const sources = sqliteTable('sources', {
  id: text('id').primaryKey().$defaultFn(uuid),
  gameId: text('game_id')
    .notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  /** steam | twitter | instagram | tiktok (youtube/reddit/telegram later). */
  platform: text('platform').notNull(),
  /** Account handle, or a folder path for steam. */
  handle: text('handle').notNull(),
  displayName: text('display_name'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastSyncedAt: text('last_synced_at'),
  lastStatus: text('last_status'),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
})

/**
 * One public review or comment imported from a configured feedback source.
 * The source cursor lives in `sources`; this table keeps the normalized inbox
 * state independently from marketing events and their aggregate metrics.
 */
export const inboxComments = sqliteTable(
  'inbox_comments',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    externalId: text('external_id').notNull(),
    kind: text('kind', { enum: ['review', 'comment'] })
      .notNull()
      .default('comment'),
    authorName: text('author_name'),
    authorUrl: text('author_url'),
    body: text('body').notNull(),
    rating: integer('rating'),
    language: text('language'),
    url: text('url').notNull(),
    publishedAt: text('published_at').notNull(),
    remoteUpdatedAt: text('remote_updated_at'),
    developerReply: text('developer_reply'),
    developerRepliedAt: text('developer_replied_at'),
    status: text('status', { enum: ['unread', 'open', 'replied', 'ignored'] })
      .notNull()
      .default('unread'),
    firstSeenAt: text('first_seen_at').notNull().$defaultFn(nowIso),
    lastSeenAt: text('last_seen_at').notNull().$defaultFn(nowIso),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    byExternalId: uniqueIndex('inbox_comments_source_external_unique').on(t.sourceId, t.externalId),
    byGameStatus: index('inbox_comments_game_status').on(t.gameId, t.status, t.publishedAt),
    bySourceDate: index('inbox_comments_source_date').on(t.sourceId, t.publishedAt),
  }),
)

/** History of sync attempts for a source (status, rows imported, cost). */
export const syncRuns = sqliteTable('sync_runs', {
  id: text('id').primaryKey().$defaultFn(uuid),
  sourceId: text('source_id')
    .notNull()
    .references(() => sources.id, { onDelete: 'cascade' }),
  startedAt: text('started_at').notNull().$defaultFn(nowIso),
  finishedAt: text('finished_at'),
  status: text('status', { enum: ['running', 'ok', 'error'] })
    .notNull()
    .default('running'),
  imported: integer('imported').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  error: text('error'),
})

/** Time series of an event's reach metrics (each sync appends a point). */
export const eventMetrics = sqliteTable('event_metrics', {
  id: text('id').primaryKey().$defaultFn(uuid),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  capturedAt: text('captured_at').notNull().$defaultFn(nowIso),
  views: integer('views'),
  likes: integer('likes'),
  comments: integer('comments'),
  shares: integer('shares'),
})

/** Daily API spend per provider (for budget tracking). */
export const apiSpend = sqliteTable(
  'api_spend',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    provider: text('provider').notNull(),
    date: text('date').notNull(),
    requests: integer('requests').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
  },
  (t) => ({ providerDate: uniqueIndex('api_spend_provider_date').on(t.provider, t.date) }),
)

/** Per-provider budget caps (paid connectors). */
export const providerSettings = sqliteTable('provider_settings', {
  provider: text('provider').primaryKey(),
  dailyBudgetUsd: real('daily_budget_usd'),
})

/* ----------- Industry events (global festivals catalog + per-game picks) ----------- */

/** Shared events of interest to ANY project (Steam festivals, conferences, sales). Global. */
export const industryEvents = sqliteTable(
  'industry_events',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    name: text('name').notNull(),
    type: text('type').notNull().default('festival'),
    /** ISO date the festival runs. */
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    /** ISO date of the nearest application/submission deadline. */
    applyDeadline: text('apply_deadline'),
    url: text('url'), // festival website
    applyUrl: text('apply_url'), // application form / contact
    organizer: text('organizer'),
    description: text('description'), // full details the cat uses
    notes: text('notes'),
    /** Festival attributes (the cat uses these to judge fit). */
    steamEvent: text('steam_event'), // yes | maybe | no
    steamFeature: text('steam_feature'), // yes | maybe | no
    media: integer('media', { mode: 'boolean' }),
    offline: integer('offline', { mode: 'boolean' }),
    /** Catalogue participation cost in USD. The legacy SQLite column name is preserved for existing databases. */
    costUsd: integer('fee_usd'),
    source: text('source', { enum: ['manual', 'ai', 'import'] })
      .notNull()
      .default('manual'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ byDate: index('industry_events_date').on(t.startDate, t.name) }),
)

/** A game "picks" the industry events it cares about. */
export const festivalPicks = sqliteTable(
  'festival_picks',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    industryEventId: text('industry_event_id')
      .notNull()
      .references(() => industryEvents.id, { onDelete: 'cascade' }),
    /** Prep progress: none | materials | submitted | replied | approved | rejected. */
    status: text('status').notNull().default('none'),
  },
  (t) => ({ uniq: uniqueIndex('festival_picks_game_event').on(t.gameId, t.industryEventId) }),
)

/* ------------- Phase 11: influencers/creators (global) + per-game outreach CRM ------------- */

/**
 * Global catalogue of creators/press/streamers/curators — shared by ALL games (like
 * industry_events). A game "picks" the ones it wants to reach out to (creator_picks).
 */
export const creators = sqliteTable(
  'creators',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    name: text('name').notNull(),
    /** Whether the contact represents an individual person or a media outlet/team. */
    entityType: text('entity_type', { enum: ['person', 'media'] })
      .notNull()
      .default('person'),
    handle: text('handle'),
    kind: text('kind').notNull().default('youtuber'), // youtuber|streamer|tiktoker|journalist|podcaster|steam_curator|other
    primaryPlatform: text('primary_platform'),
    /** Stable YouTube channel id (UC...), independent from handle/vanity URL changes. */
    youtubeChannelId: text('youtube_channel_id'),
    /** Canonical normalized URL of the primary channel — dedup key (UNIQUE). */
    channelKey: text('channel_key'),
    thumbnailUrl: text('thumbnail_url'),
    /** [{platform,url,handle,subscribers,avgViews,lastPostAt,postsPerMonth}] — source of truth for metrics. */
    channelsJson: text('channels_json'),
    /** Top-level aggregates DERIVED from channels_json (recomputed on refresh). */
    audience: integer('audience'),
    avgViews: integer('avg_views'),
    engagementRate: real('engagement_rate'),
    lastActiveAt: text('last_active_at'),
    cadencePerMonth: real('cadence_per_month'),
    /** JSON array of topics/genres the creator covers (for the fit score). */
    topicsJson: text('topics_json'),
    /** JSON array of game titles the creator plays or covers (catalogue-level fit evidence). */
    playedGamesJson: text('played_games_json'),
    language: text('language'),
    region: text('region'),
    /** [{type[business_email|form|dm|manager],value,source[manual|api|scrape|ai],sourceUrl,confidence,verified,gated}]. */
    contactsJson: text('contacts_json'),
    /** Catalogue participation cost in USD. The legacy SQLite column name is preserved for existing databases. */
    costUsd: integer('rate_usd'),
    acceptsKeysOnly: integer('accepts_keys_only', { mode: 'boolean' }),
    currency: text('currency'),
    rateNote: text('rate_note'),
    doNotContact: integer('do_not_contact', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes'),
    description: text('description'),
    /** YouTube API-derived fields must be refreshed or removed within the policy window. */
    dataRefreshedAt: text('data_refreshed_at'),
    dataExpiresAt: text('data_expires_at'),
    source: text('source', { enum: ['manual', 'ai', 'import', 'scrape'] })
      .notNull()
      .default('manual'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    channelKeyUniq: uniqueIndex('creators_channel_key').on(t.channelKey),
    youtubeChannelUniq: uniqueIndex('creators_youtube_channel_id').on(t.youtubeChannelId),
    byName: index('creators_name').on(t.name, t.id),
  }),
)

/** A game "picks" a creator into its outreach pipeline. */
export const creatorPicks = sqliteTable(
  'creator_picks',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    creatorId: text('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'cascade' }),
    /** prospect | contacted | replied | agreed | published | closed. */
    pipelineStatus: text('pipeline_status').notNull().default('prospect'),
    /** When closed: declined | no_response | done. */
    closedReason: text('closed_reason'),
    /** Actual agreed price for THIS deal (per-game), for cost-per-wishlist. */
    agreedCostUsd: integer('agreed_cost_usd'),
    /** JSON array of game/product keys sent for THIS game's outreach. */
    keysSentJson: text('keys_sent_json'),
    addedBy: text('added_by', { enum: ['manual', 'ai', 'scrape'] })
      .notNull()
      .default('manual'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    uniq: uniqueIndex('creator_picks_game_creator').on(t.gameId, t.creatorId),
    byGameStatus: index('creator_picks_game_status').on(t.gameId, t.pipelineStatus, t.creatorId),
  }),
)

/* ----------------------- YouTube creator discovery staging ----------------------- */

/** Reusable, project-scoped search configuration. References are normalized below. */
export const creatorDiscoveryProfiles = sqliteTable(
  'creator_discovery_profiles',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mode: text('mode', { enum: ['games', 'topic'] })
      .notNull()
      .default('games'),
    languagesJson: text('languages_json').notNull().default('[]'),
    includeTermsJson: text('include_terms_json').notNull().default('[]'),
    excludeTermsJson: text('exclude_terms_json').notNull().default('[]'),
    seedChannelsJson: text('seed_channels_json').notNull().default('[]'),
    maxSearchRequests: integer('max_search_requests').notNull().default(10),
    maxChannels: integer('max_channels').notNull().default(500),
    recentVideoLimit: integer('recent_video_limit').notNull().default(50),
    discoverContacts: integer('discover_contacts', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ byGame: index('creator_discovery_profiles_game').on(t.gameId, t.updatedAt) }),
)

/** A competitor/reference game or a topic facet with aliases used by the local matcher. */
export const creatorDiscoveryReferences = sqliteTable(
  'creator_discovery_references',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    profileId: text('profile_id')
      .notNull()
      .references(() => creatorDiscoveryProfiles.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    aliasesJson: text('aliases_json').notNull().default('[]'),
    queryTermsJson: text('query_terms_json').notNull().default('[]'),
    weight: real('weight').notNull().default(1),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ byProfile: index('creator_discovery_references_profile').on(t.profileId) }),
)

/** Immutable execution artifact. Profile inputs are snapshotted so old results remain explainable. */
export const creatorDiscoveryRuns = sqliteTable(
  'creator_discovery_runs',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    profileId: text('profile_id')
      .notNull()
      .references(() => creatorDiscoveryProfiles.id, { onDelete: 'cascade' }),
    profileHash: text('profile_hash').notNull(),
    profileSnapshotJson: text('profile_snapshot_json').notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'paused', 'waiting_for_quota', 'partial', 'completed', 'failed', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    phase: text('phase').notNull().default('queued'),
    searchRequestsUsed: integer('search_requests_used').notNull().default(0),
    dataUnitsUsed: integer('data_units_used').notNull().default(0),
    channelsFound: integer('channels_found').notNull().default(0),
    channelsScanned: integer('channels_scanned').notNull().default(0),
    videosScanned: integer('videos_scanned').notNull().default(0),
    candidatesStaged: integer('candidates_staged').notNull().default(0),
    contactsFound: integer('contacts_found').notNull().default(0),
    youtubeCompletedAt: text('youtube_completed_at'),
    error: text('error'),
    heartbeatAt: text('heartbeat_at'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    byGame: index('creator_discovery_runs_game').on(t.gameId, t.createdAt),
    byProfileHash: index('creator_discovery_runs_profile_hash').on(t.profileId, t.profileHash, t.createdAt),
    byStatus: index('creator_discovery_runs_status').on(t.status, t.createdAt),
  }),
)

/**
 * Normalized, resumable YouTube search pages for an active discovery run.
 * Rows contain only request cursors and are deleted after the YouTube phase finishes.
 */
export const creatorDiscoveryRunSearches = sqliteTable(
  'creator_discovery_run_searches',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    runId: text('run_id')
      .notNull()
      .references(() => creatorDiscoveryRuns.id, { onDelete: 'cascade' }),
    taskKey: text('task_key').notNull(),
    query: text('query').notNull(),
    pageToken: text('page_token'),
    relevanceLanguage: text('relevance_language'),
    priority: integer('priority').notNull().default(0),
    status: text('status', { enum: ['queued', 'completed'] })
      .notNull()
      .default('queued'),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    uniq: uniqueIndex('creator_discovery_run_searches_unique').on(t.runId, t.taskKey),
    byQueue: index('creator_discovery_run_searches_queue').on(t.runId, t.status, t.priority, t.createdAt),
  }),
)

/** Parsed channel ids awaiting analysis; raw YouTube responses never enter SQLite. */
export const creatorDiscoveryRunChannels = sqliteTable(
  'creator_discovery_run_channels',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    runId: text('run_id')
      .notNull()
      .references(() => creatorDiscoveryRuns.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    status: text('status', { enum: ['queued', 'scanned', 'skipped'] })
      .notNull()
      .default('queued'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    uniq: uniqueIndex('creator_discovery_run_channels_unique').on(t.runId, t.channelId),
    byQueue: index('creator_discovery_run_channels_queue').on(t.runId, t.status, t.createdAt),
  }),
)

/** Global discovered YouTube channel facts, separate from project-specific fit. */
export const creatorDiscoveryCandidates = sqliteTable(
  'creator_discovery_candidates',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    platform: text('platform').notNull().default('youtube'),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    handle: text('handle'),
    channelUrl: text('channel_url').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    description: text('description'),
    country: text('country'),
    defaultLanguage: text('default_language'),
    subscriberCount: integer('subscriber_count'),
    totalViewCount: integer('total_view_count'),
    videoCount: integer('video_count'),
    avgViews: integer('avg_views'),
    cadencePerMonth: real('cadence_per_month'),
    latestVideoAt: text('latest_video_at'),
    uploadsPlaylistId: text('uploads_playlist_id'),
    fetchedAt: text('fetched_at').notNull().$defaultFn(nowIso),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({
    externalUniq: uniqueIndex('creator_discovery_candidates_platform_external').on(t.platform, t.externalId),
    byExpiry: index('creator_discovery_candidates_expiry').on(t.expiresAt),
  }),
)

/** Per-run fit/result state. Promotion to the production CRM is always explicit. */
export const creatorDiscoveryRunCandidates = sqliteTable(
  'creator_discovery_run_candidates',
  {
    runId: text('run_id')
      .notNull()
      .references(() => creatorDiscoveryRuns.id, { onDelete: 'cascade' }),
    candidateId: text('candidate_id')
      .notNull()
      .references(() => creatorDiscoveryCandidates.id, { onDelete: 'cascade' }),
    fitScore: integer('fit_score').notNull(),
    matchedReferenceCount: integer('matched_reference_count').notNull().default(0),
    matchedReferencesJson: text('matched_references_json').notNull().default('[]'),
    matchedVideoCount: integer('matched_video_count').notNull().default(0),
    fitReasonsJson: text('fit_reasons_json').notNull().default('[]'),
    status: text('status', { enum: ['staged', 'promoted', 'dismissed'] })
      .notNull()
      .default('staged'),
    creatorId: text('creator_id').references(() => creators.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    uniq: uniqueIndex('creator_discovery_run_candidates_unique').on(t.runId, t.candidateId),
    byRunScore: index('creator_discovery_run_candidates_score').on(t.runId, t.fitScore),
  }),
)

/** Video-level explanation for every matched reference. */
export const creatorDiscoveryEvidence = sqliteTable(
  'creator_discovery_evidence',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    runId: text('run_id')
      .notNull()
      .references(() => creatorDiscoveryRuns.id, { onDelete: 'cascade' }),
    candidateId: text('candidate_id')
      .notNull()
      .references(() => creatorDiscoveryCandidates.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id')
      .notNull()
      .references(() => creatorDiscoveryReferences.id, { onDelete: 'cascade' }),
    videoId: text('video_id').notNull(),
    videoTitle: text('video_title').notNull(),
    videoUrl: text('video_url').notNull(),
    publishedAt: text('published_at'),
    viewCount: integer('view_count'),
    matchedTermsJson: text('matched_terms_json').notNull().default('[]'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    uniq: uniqueIndex('creator_discovery_evidence_unique').on(t.runId, t.candidateId, t.referenceId, t.videoId),
    byRunCandidate: index('creator_discovery_evidence_run_candidate').on(t.runId, t.candidateId),
  }),
)

/** Public contact evidence only; every value retains provenance and confidence. */
export const creatorDiscoveryContacts = sqliteTable(
  'creator_discovery_contacts',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    runId: text('run_id')
      .notNull()
      .references(() => creatorDiscoveryRuns.id, { onDelete: 'cascade' }),
    candidateId: text('candidate_id')
      .notNull()
      .references(() => creatorDiscoveryCandidates.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['business_email', 'website', 'form'] }).notNull(),
    value: text('value').notNull(),
    normalizedValue: text('normalized_value').notNull(),
    sourceUrl: text('source_url').notNull(),
    confidence: real('confidence').notNull().default(0.8),
    gated: integer('gated', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    uniq: uniqueIndex('creator_discovery_contacts_unique').on(t.runId, t.candidateId, t.type, t.normalizedValue),
    byCandidate: index('creator_discovery_contacts_candidate').on(t.candidateId),
  }),
)

/** Durable user-visible work accepted by MarCat and completed by a background worker. */
export const backgroundOperations = sqliteTable(
  'background_operations',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['creator_promotion'] }).notNull(),
    /** Feature-specific durable scope; creator promotion uses the discovery run id. */
    scopeId: text('scope_id').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status', { enum: ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'] })
      .notNull()
      .default('queued'),
    selected: integer('selected').notNull(),
    processed: integer('processed').notNull().default(0),
    succeeded: integer('succeeded').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    error: text('error'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    heartbeatAt: text('heartbeat_at'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    byQueue: index('background_operations_queue').on(t.kind, t.status, t.createdAt),
    byScope: index('background_operations_scope').on(t.kind, t.scopeId, t.createdAt),
    byDedupe: index('background_operations_dedupe').on(t.dedupeKey, t.status),
  }),
)

/** Per-entity progress keeps bulk operations resumable and retry-safe after process failure. */
export const backgroundOperationItems = sqliteTable(
  'background_operation_items',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    operationId: text('operation_id')
      .notNull()
      .references(() => backgroundOperations.id, { onDelete: 'cascade' }),
    entityId: text('entity_id').notNull(),
    status: text('status', { enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] })
      .notNull()
      .default('queued'),
    outcome: text('outcome', { enum: ['created', 'updated'] }),
    resultEntityId: text('result_entity_id'),
    error: text('error'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    uniq: uniqueIndex('background_operation_items_entity').on(t.operationId, t.entityId),
    byQueue: index('background_operation_items_queue').on(t.operationId, t.status, t.createdAt),
  }),
)

/** Short-lived quota/idempotency ledger. It never stores API keys or provider responses. */
export const youtubeApiRequests = sqliteTable(
  'youtube_api_requests',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    lastRunId: text('last_run_id').references(() => creatorDiscoveryRuns.id, { onDelete: 'set null' }),
    keyFingerprint: text('key_fingerprint').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: ['planned', 'running', 'succeeded', 'failed', 'uncertain'] })
      .notNull()
      .default('planned'),
    quotaBucket: text('quota_bucket', { enum: ['search', 'data'] }).notNull(),
    quotaCost: integer('quota_cost').notNull(),
    quotaDate: text('quota_date').notNull(),
    error: text('error'),
    reservedAt: text('reserved_at'),
    requestedAt: text('requested_at'),
    completedAt: text('completed_at'),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    uniq: uniqueIndex('youtube_api_requests_key_hash').on(t.keyFingerprint, t.requestHash),
    byRun: index('youtube_api_requests_run').on(t.lastRunId, t.createdAt),
    byStatus: index('youtube_api_requests_status').on(t.status, t.updatedAt),
  }),
)

/** Local quota reservation ledger by key fingerprint and YouTube quota day (Pacific Time). */
export const youtubeQuotaUsage = sqliteTable(
  'youtube_quota_usage',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    keyFingerprint: text('key_fingerprint').notNull(),
    quotaDate: text('quota_date').notNull(),
    bucket: text('bucket', { enum: ['search', 'data'] }).notNull(),
    used: integer('used').notNull().default(0),
    limit: integer('limit').notNull(),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ uniq: uniqueIndex('youtube_quota_usage_unique').on(t.keyFingerprint, t.quotaDate, t.bucket) }),
)

/**
 * Durable, provider-agnostic request cache for paid creator discovery APIs.
 * Keys are fingerprinted and responses are reused, so restarting or repeating
 * an identical search does not silently spend credits twice.
 */
export const creatorDiscoveryApiRequests = sqliteTable(
  'creator_discovery_api_requests',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    lastRunId: text('last_run_id').references(() => creatorDiscoveryRuns.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    keyFingerprint: text('key_fingerprint').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'uncertain'] })
      .notNull()
      .default('running'),
    responseJson: text('response_json'),
    creditsCharged: integer('credits_charged').notNull().default(0),
    creditsRemaining: integer('credits_remaining'),
    cacheExpiresAt: text('cache_expires_at'),
    error: text('error'),
    requestedAt: text('requested_at'),
    completedAt: text('completed_at'),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    uniq: uniqueIndex('creator_discovery_api_requests_unique').on(t.provider, t.keyFingerprint, t.requestHash),
    byRun: index('creator_discovery_api_requests_run').on(t.lastRunId, t.createdAt),
    byStatus: index('creator_discovery_api_requests_status').on(t.provider, t.status, t.updatedAt),
  }),
)

/** A logged touch in the correspondence with a creator (the CRM thread). */
export const creatorTouches = sqliteTable(
  'creator_touches',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    creatorId: text('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'cascade' }),
    occurredAt: text('occurred_at').notNull(),
    direction: text('direction', { enum: ['outbound', 'inbound'] }).notNull(),
    channel: text('channel', { enum: ['email', 'dm', 'form', 'call'] })
      .notNull()
      .default('email'),
    summary: text('summary').notNull().default(''),
    body: text('body'),
    templateId: text('template_id'),
    statusAfter: text('status_after'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ byGameCreator: index('creator_touches_game_creator').on(t.gameId, t.creatorId) }),
)

/** Global reusable pitch templates (v1: global-only). */
export const outreachTemplates = sqliteTable('outreach_templates', {
  id: text('id').primaryKey().$defaultFn(uuid),
  name: text('name').notNull(),
  subject: text('subject').notNull().default(''),
  body: text('body').notNull().default(''),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
})

/** One user-approved GMass outreach batch for a game. */
export const gmassCampaigns = sqliteTable(
  'gmass_campaigns',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull().default('prepared'),
    sendMode: text('send_mode').notNull().default('draft'),
    sendAt: text('send_at'),
    fromEmail: text('from_email').notNull(),
    subjectTemplate: text('subject_template').notNull(),
    bodyTemplate: text('body_template').notNull(),
    messageType: text('message_type').notNull().default('plain'),
    addressCategoriesJson: text('address_categories_json').notNull().default('[]'),
    openTracking: integer('open_tracking', { mode: 'boolean' }).notNull().default(true),
    clickTracking: integer('click_tracking', { mode: 'boolean' }).notNull().default(true),
    emailsPerDay: integer('emails_per_day'),
    requestedBy: text('requested_by', { enum: ['manual', 'mcp', 'ai'] })
      .notNull()
      .default('manual'),
    recipientCount: integer('recipient_count').notNull().default(0),
    contentHash: text('content_hash').notNull(),
    approvedAt: text('approved_at'),
    syncRequestedAt: text('sync_requested_at'),
    lastSyncedAt: text('last_synced_at'),
    error: text('error'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ byGameCreated: index('gmass_campaigns_game_created').on(t.gameId, t.createdAt) }),
)

/** Frozen recipient/message snapshot plus GMass delivery state. */
export const gmassRecipients = sqliteTable(
  'gmass_recipients',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => gmassCampaigns.id, { onDelete: 'cascade' }),
    creatorId: text('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    addressCategory: text('address_category').notNull(),
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
    keysJson: text('keys_json').notNull().default('[]'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('prepared'),
    gmassDraftId: text('gmass_draft_id'),
    gmassCampaignId: integer('gmass_campaign_id'),
    remoteStatus: text('remote_status'),
    sentAt: text('sent_at'),
    openedAt: text('opened_at'),
    clickedAt: text('clicked_at'),
    repliedAt: text('replied_at'),
    bouncedAt: text('bounced_at'),
    unsubscribedAt: text('unsubscribed_at'),
    error: text('error'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({
    campaignEmail: uniqueIndex('gmass_recipients_campaign_email').on(t.campaignId, t.email),
    byRemoteCampaign: index('gmass_recipients_remote_campaign').on(t.gmassCampaignId),
  }),
)

/* ----------------------- Phase 4: embedded AI agent ----------------------- */

/** One AI run. The agent proposes a changeset; nothing is applied until reviewed. */
export const aiRuns = sqliteTable('ai_runs', {
  id: text('id').primaryKey().$defaultFn(uuid),
  gameId: text('game_id')
    .notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull().default('freeform'),
  prompt: text('prompt').notNull(),
  status: text('status', { enum: ['running', 'proposed', 'applied', 'rejected', 'error'] })
    .notNull()
    .default('proposed'),
  summary: text('summary').notNull().default(''),
  /** Raw model output — kept for debugging the pipeline. */
  rawOutput: text('raw_output').notNull().default(''),
  model: text('model'),
  error: text('error'),
  /** Claude session id, for resuming this run as a chat (follow-up replies). */
  sessionId: text('session_id'),
  /** Archived chats are hidden from the runs list. */
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
  finishedAt: text('finished_at'),
})

/** A turn in a run's conversation (the chat thread shown in the AI den). */
export const aiMessages = sqliteTable('ai_messages', {
  id: text('id').primaryKey().$defaultFn(uuid),
  runId: text('run_id')
    .notNull()
    .references(() => aiRuns.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull().default(''),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
})

/** A single staged change inside a run's proposal. */
export const aiProposalChanges = sqliteTable('ai_proposal_changes', {
  id: text('id').primaryKey().$defaultFn(uuid),
  runId: text('run_id')
    .notNull()
    .references(() => aiRuns.id, { onDelete: 'cascade' }),
  op: text('op', { enum: ['create', 'update', 'delete'] }).notNull(),
  entity: text('entity').notNull(),
  afterJson: text('after_json').notNull().default('{}'),
  status: text('status', { enum: ['pending', 'applied', 'rejected'] })
    .notNull()
    .default('pending'),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
})

export type Game = typeof games.$inferSelect
export type NewGame = typeof games.$inferInsert
export type Setting = typeof settings.$inferSelect
export type ProjectCard = typeof projectCards.$inferSelect
export type Insight = typeof insights.$inferSelect
export type UtmLink = typeof utmLinks.$inferSelect
export type AiRun = typeof aiRuns.$inferSelect
export type AiMessage = typeof aiMessages.$inferSelect
export type AiProposalChange = typeof aiProposalChanges.$inferSelect
export type ChangeLogEntry = typeof changeLog.$inferSelect
export type WorkspaceConfig = typeof workspaceConfigs.$inferSelect
export type WorkspaceFile = typeof workspaceFiles.$inferSelect
export type WorkspaceSyncIssue = typeof workspaceSyncIssues.$inferSelect
export type WorkspaceOutboxEntry = typeof workspaceOutbox.$inferSelect
export type Milestone = typeof milestones.$inferSelect
export type Tag = typeof tags.$inferSelect
export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
export type ChecklistItem = typeof taskChecklistItems.$inferSelect
export type TaskDependency = typeof taskDependencies.$inferSelect
export type EventRow = typeof events.$inferSelect
export type ActivityRow = typeof events.$inferSelect
export type WishlistPoint = typeof wishlistPoints.$inferSelect
export type MarketingCampaign = typeof marketingCampaigns.$inferSelect
export type CampaignTouchpoint = typeof campaignTouchpoints.$inferSelect
export type IndustryEvent = typeof industryEvents.$inferSelect
export type Creator = typeof creators.$inferSelect
export type NewCreator = typeof creators.$inferInsert
export type CreatorPick = typeof creatorPicks.$inferSelect
export type CreatorDiscoveryProfile = typeof creatorDiscoveryProfiles.$inferSelect
export type CreatorDiscoveryReference = typeof creatorDiscoveryReferences.$inferSelect
export type CreatorDiscoveryRun = typeof creatorDiscoveryRuns.$inferSelect
export type CreatorDiscoveryCandidate = typeof creatorDiscoveryCandidates.$inferSelect
export type CreatorDiscoveryRunCandidate = typeof creatorDiscoveryRunCandidates.$inferSelect
export type CreatorDiscoveryEvidence = typeof creatorDiscoveryEvidence.$inferSelect
export type CreatorDiscoveryContact = typeof creatorDiscoveryContacts.$inferSelect
export type BackgroundOperation = typeof backgroundOperations.$inferSelect
export type BackgroundOperationItem = typeof backgroundOperationItems.$inferSelect
export type CreatorDiscoveryApiRequest = typeof creatorDiscoveryApiRequests.$inferSelect
export type YoutubeApiRequest = typeof youtubeApiRequests.$inferSelect
export type YoutubeQuotaUsage = typeof youtubeQuotaUsage.$inferSelect
export type CreatorTouch = typeof creatorTouches.$inferSelect
export type OutreachTemplate = typeof outreachTemplates.$inferSelect
export type GmassCampaign = typeof gmassCampaigns.$inferSelect
export type GmassRecipient = typeof gmassRecipients.$inferSelect
export type Source = typeof sources.$inferSelect
export type SyncRun = typeof syncRuns.$inferSelect
export type EventMetric = typeof eventMetrics.$inferSelect
export type ApiSpend = typeof apiSpend.$inferSelect
