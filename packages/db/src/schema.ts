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
  importedAt: text('imported_at').notNull().$defaultFn(nowIso),
  rows: integer('rows').notNull().default(0),
  columnMapping: text('column_mapping'),
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
    dateFrom: text('date_from'),
    dateTo: text('date_to'),
    rows: integer('rows').notNull().default(0),
    rowsJson: text('rows_json').notNull().default('[]'),
    importedAt: text('imported_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ byGameKind: index('analytics_imports_game_kind').on(t.gameId, t.kind, t.importedAt) }),
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
export const industryEvents = sqliteTable('industry_events', {
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
})

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
    handle: text('handle'),
    kind: text('kind').notNull().default('youtuber'), // youtuber|streamer|tiktoker|journalist|podcaster|steam_curator|other
    primaryPlatform: text('primary_platform'),
    /** Canonical normalized URL of the primary channel — dedup key (UNIQUE). */
    channelKey: text('channel_key'),
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
    source: text('source', { enum: ['manual', 'ai', 'import', 'scrape'] })
      .notNull()
      .default('manual'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ channelKeyUniq: uniqueIndex('creators_channel_key').on(t.channelKey) }),
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
    addedBy: text('added_by', { enum: ['manual', 'ai'] })
      .notNull()
      .default('manual'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (t) => ({ uniq: uniqueIndex('creator_picks_game_creator').on(t.gameId, t.creatorId) }),
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
export type IndustryEvent = typeof industryEvents.$inferSelect
export type Creator = typeof creators.$inferSelect
export type NewCreator = typeof creators.$inferInsert
export type CreatorPick = typeof creatorPicks.$inferSelect
export type CreatorTouch = typeof creatorTouches.$inferSelect
export type OutreachTemplate = typeof outreachTemplates.$inferSelect
export type GmassCampaign = typeof gmassCampaigns.$inferSelect
export type GmassRecipient = typeof gmassRecipients.$inferSelect
export type Source = typeof sources.$inferSelect
export type SyncRun = typeof syncRuns.$inferSelect
export type EventMetric = typeof eventMetrics.$inferSelect
export type ApiSpend = typeof apiSpend.$inferSelect
