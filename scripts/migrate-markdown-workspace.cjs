/*
 * Production migration + verification for one MarCat project.
 *
 * Usage:
 *   node scripts/migrate-markdown-workspace.cjs \
 *     --db C:\path\to\marcat.db --game-key SAS \
 *     --root D:\path\to\repository --folder docs/marketing/MarCat
 *
 * The destination workspace must not already exist. A verified SQLite online
 * backup is created before migrations or workspace configuration are written.
 */
const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')
const {
  configureConnection,
  createDb,
  createVerifiedBackup,
  fileUrlFromPath,
  runMigrations,
  verifyDatabaseFile,
} = require('@marcat/db')
const {
  atomicWriteWorkspaceFile,
  DrizzleWorkspaceRepository,
  hashContent,
  listVisibleMarkdownFiles,
  MarkdownWorkspaceCoordinator,
  parseWorkspaceEntity,
  readWorkspaceFile,
} = require('@marcat/core')

const MANAGED_TABLES = ['project_cards', 'insights', 'tasks', 'tags', 'events']
const PRESERVED_TABLES = [
  'festival_picks',
  'creator_picks',
  'wishlist_points',
  'analytics_imports',
  'wishlist_imports',
  'utm_links',
  'sources',
]
const RELATED_COUNTS = {
  task_checklist_items:
    'SELECT count(*) AS n FROM task_checklist_items i JOIN tasks t ON t.id=i.task_id WHERE t.game_id=?',
  task_dependencies:
    'SELECT count(*) AS n FROM task_dependencies d JOIN tasks t ON t.id=d.blocker_task_id WHERE t.game_id=?',
  task_links: 'SELECT count(*) AS n FROM task_links l JOIN tasks t ON t.id=l.task_id WHERE t.game_id=?',
  task_tag_links: 'SELECT count(*) AS n FROM task_tag_links l JOIN tasks t ON t.id=l.task_id WHERE t.game_id=?',
  event_metrics: 'SELECT count(*) AS n FROM event_metrics m JOIN events e ON e.id=m.event_id WHERE e.game_id=?',
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key ?? '<end>'}`)
    values[key.slice(2)] = value
  }
  for (const required of ['db', 'game-key', 'root', 'folder']) {
    if (!values[required]) throw new Error(`Missing --${required}`)
  }
  return values
}

async function scalar(client, sql, args = []) {
  return Number((await client.execute({ sql, args })).rows[0]?.n ?? 0)
}

async function projectCounts(client, gameId) {
  const counts = {}
  for (const table of [...MANAGED_TABLES, ...PRESERVED_TABLES]) {
    counts[table] = await scalar(client, `SELECT count(*) AS n FROM ${table} WHERE game_id=?`, [gameId])
  }
  for (const [name, query] of Object.entries(RELATED_COUNTS)) {
    counts[name] = await scalar(client, query, [gameId])
  }
  return counts
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} changed\nBEFORE ${JSON.stringify(expected)}\nAFTER  ${JSON.stringify(actual)}`)
  }
}

async function verifyWorkspace({ client, coordinator, repository, gameId, workspaceRoot, expectedCounts }) {
  const markdownPaths = await listVisibleMarkdownFiles(workspaceRoot)
  const ids = new Set()
  const typeCounts = { project: 0, insight: 0, task: 0, tag: 0, activity: 0 }
  const parsedByPath = new Map()
  for (const relativePath of markdownPaths) {
    const disk = await readWorkspaceFile(workspaceRoot, relativePath)
    const parsed = parseWorkspaceEntity(disk.content, {
      gameId,
      filename: relativePath,
      now: new Date().toISOString(),
    })
    const key = `${parsed.type}:${parsed.id}`
    if (ids.has(key)) throw new Error(`Duplicate managed id ${key}`)
    ids.add(key)
    typeCounts[parsed.type] += 1
    parsedByPath.set(relativePath, parsed)
  }

  const expectedTypeCounts = {
    project: expectedCounts.project_cards,
    insight: expectedCounts.insights,
    task: expectedCounts.tasks,
    tag: expectedCounts.tags,
    activity: expectedCounts.events,
  }
  assertEqual(typeCounts, expectedTypeCounts, 'workspace entity counts')

  const registry = await repository.listFiles(gameId)
  if (registry.length !== markdownPaths.length) {
    throw new Error(`Registry has ${registry.length} rows for ${markdownPaths.length} Markdown files`)
  }
  const pathSet = new Set(markdownPaths)
  for (const file of registry) {
    if (!pathSet.has(file.relativePath)) throw new Error(`Registry path missing on disk: ${file.relativePath}`)
    if (file.status !== 'synced') throw new Error(`Registry status ${file.status}: ${file.relativePath}`)
    const entity = parsedByPath.get(file.relativePath)
    if (!entity || entity.type !== file.entityType || entity.id !== file.entityId) {
      throw new Error(`Registry identity mismatch: ${file.relativePath}`)
    }
  }

  const bases = ['Tasks.base', 'Insights.base', 'Activity.base', 'Campaigns.base']
  for (const filename of bases) {
    const basePath = path.join(workspaceRoot, 'Views', filename)
    if (!fs.existsSync(basePath)) throw new Error(`Missing Obsidian base ${basePath}`)
    const text = fs.readFileSync(basePath, 'utf8')
    const parsed = YAML.parse(text)
    if (!parsed?.filters || !parsed?.properties || !Array.isArray(parsed?.views)) {
      throw new Error(`Invalid Obsidian base structure: ${basePath}`)
    }
    if (Object.keys(parsed).some((key) => key.startsWith('+'))) {
      throw new Error(`Diff marker leaked into Obsidian base: ${basePath}`)
    }
  }

  const status = await coordinator.status(gameId)
  const pending = await scalar(
    client,
    'SELECT count(*) AS n FROM workspace_outbox WHERE game_id=? AND processed_at IS NULL',
    [gameId],
  )
  const issues = await scalar(
    client,
    'SELECT count(*) AS n FROM workspace_sync_issues WHERE game_id=? AND resolved_at IS NULL',
    [gameId],
  )
  if (pending !== 0 || issues !== 0 || status.pendingWrites !== 0 || status.openIssues !== 0) {
    throw new Error(`Workspace is not clean: pending=${pending}, issues=${issues}, status=${JSON.stringify(status)}`)
  }
  return { markdownFiles: markdownPaths.length, typeCounts, bases: bases.length, registryRows: registry.length }
}

async function smokeRoundTrip({ coordinator, repository, gameId, workspaceRoot }) {
  const registry = (await repository.listFiles(gameId)).find((file) => file.entityType === 'tag')
  if (!registry) throw new Error('No tag file available for non-destructive round-trip smoke')
  const original = await readWorkspaceFile(workspaceRoot, registry.relativePath)
  const originalEntity = parseWorkspaceEntity(original.content, {
    gameId,
    filename: registry.relativePath,
    now: new Date().toISOString(),
  })
  const dbEntityBefore = await repository.getEntity(gameId, 'tag', registry.entityId)
  const marker = `marcat-roundtrip-${Date.now()}`
  const edited =
    original.content.replace(/^---\r?\n/, `---\nqa-marcat-roundtrip: ${marker}\n`) +
    `\n\n## QA Roundtrip\n\n${marker}\n`
  await atomicWriteWorkspaceFile(workspaceRoot, registry.relativePath, edited)

  const importStart = performance.now()
  const imported = await coordinator.reconcile(gameId)
  const importMs = performance.now() - importStart
  const afterImport = await readWorkspaceFile(workspaceRoot, registry.relativePath)
  if (!afterImport.content.includes(`qa-marcat-roundtrip: ${marker}`) || !afterImport.content.includes(marker)) {
    throw new Error('Unknown frontmatter/section was not preserved during Markdown import')
  }
  const dbEntityAfter = await repository.getEntity(gameId, 'tag', registry.entityId)
  assertEqual(dbEntityAfter, dbEntityBefore, 'tag database row during unknown-property import')

  const exportStart = performance.now()
  await coordinator.enqueueEntityChange(gameId, 'tag', registry.entityId)
  const exported = await coordinator.drainOutbox(gameId)
  const exportMs = performance.now() - exportStart
  const afterExport = await readWorkspaceFile(workspaceRoot, registry.relativePath)
  if (!afterExport.content.includes(`qa-marcat-roundtrip: ${marker}`) || !afterExport.content.includes(marker)) {
    throw new Error('MarCat-side export did not preserve unknown frontmatter/section')
  }

  // Restore exact user-owned bytes and the matching registry base, then prove a
  // normal reconciliation is a no-op. Only sync metadata from this smoke remains.
  const restoredDisk = await atomicWriteWorkspaceFile(workspaceRoot, registry.relativePath, original.content)
  await repository.upsertFile({
    ...registry,
    contentHash: restoredDisk.hash,
    baseHash: restoredDisk.hash,
    baseContent: original.content,
    mtimeMs: restoredDisk.mtimeMs,
    size: restoredDisk.size,
  })
  const cleanup = await coordinator.reconcile(gameId)
  const finalDisk = await readWorkspaceFile(workspaceRoot, registry.relativePath)
  if (finalDisk.content !== original.content || finalDisk.hash !== hashContent(original.content)) {
    throw new Error('Round-trip cleanup did not restore exact original bytes')
  }
  const finalEntity = parseWorkspaceEntity(finalDisk.content, {
    gameId,
    filename: registry.relativePath,
    now: new Date().toISOString(),
  })
  assertEqual(finalEntity, originalEntity, 'round-trip final parsed entity')
  assertEqual(
    await repository.getEntity(gameId, 'tag', registry.entityId),
    dbEntityBefore,
    'round-trip final DB entity',
  )
  return {
    file: registry.relativePath,
    entityId: registry.entityId,
    imported: imported.imported,
    exported,
    importMs: Number(importMs.toFixed(1)),
    exportMs: Number(exportMs.toFixed(1)),
    cleanup,
    exactBytesRestored: true,
    unknownFieldsPreserved: true,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = path.resolve(args.db)
  const rootPath = path.resolve(args.root)
  const workspaceFolder = args.folder.replace(/\\/g, '/')
  const workspaceRoot = path.resolve(rootPath, workspaceFolder)
  if (!fs.existsSync(dbPath)) throw new Error(`Database does not exist: ${dbPath}`)
  if (!fs.statSync(rootPath).isDirectory()) throw new Error(`Root is not a directory: ${rootPath}`)
  if (fs.existsSync(workspaceRoot)) throw new Error(`Workspace destination already exists: ${workspaceRoot}`)

  const { db, client } = createDb(fileUrlFromPath(dbPath))
  const game = (
    await client.execute({
      sql: 'SELECT id,name,key FROM games WHERE key=? LIMIT 1',
      args: [args['game-key']],
    })
  ).rows[0]
  if (!game) throw new Error(`Project not found: ${args['game-key']}`)
  const gameId = String(game.id)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(path.dirname(dbPath), 'backups', `marcat-pre-workspace-0.2.0-${stamp}.db`)
  await createVerifiedBackup(db, backupPath)
  await verifyDatabaseFile(backupPath)
  await configureConnection(client)
  const backupIntegrity = String((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check ?? '')
  if (backupIntegrity !== 'ok') throw new Error(`Active database integrity_check failed: ${backupIntegrity}`)

  const before = await projectCounts(client, gameId)
  const migrationsStart = performance.now()
  await runMigrations(db, client, path.join(__dirname, '..', 'packages', 'db', 'migrations'))
  const migrationsMs = performance.now() - migrationsStart
  const afterMigrations = await projectCounts(client, gameId)
  assertEqual(afterMigrations, before, 'project counts after migrations')

  const repository = new DrizzleWorkspaceRepository(db)
  const errors = []
  const coordinator = new MarkdownWorkspaceCoordinator(repository, { onError: (error) => errors.push(String(error)) })

  const configureStart = performance.now()
  await coordinator.configure({ gameId, rootPath, workspaceFolder, enabled: true })
  const configureMs = performance.now() - configureStart
  const exportStart = performance.now()
  const exported = await coordinator.exportAll(gameId)
  const exportMs = performance.now() - exportStart
  const reconcileStart = performance.now()
  const reconciled = await coordinator.reconcile(gameId)
  const reconcileMs = performance.now() - reconcileStart
  if (errors.length) throw new Error(`Workspace coordinator errors: ${errors.join('; ')}`)

  const firstVerification = await verifyWorkspace({
    client,
    coordinator,
    repository,
    gameId,
    workspaceRoot,
    expectedCounts: before,
  })
  const smoke = await smokeRoundTrip({ coordinator, repository, gameId, workspaceRoot })
  const finalCounts = await projectCounts(client, gameId)
  assertEqual(finalCounts, before, 'project counts after export and round-trip')
  const finalVerification = await verifyWorkspace({
    client,
    coordinator,
    repository,
    gameId,
    workspaceRoot,
    expectedCounts: before,
  })
  const finalIntegrity = String((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check ?? '')
  if (finalIntegrity !== 'ok') throw new Error(`Final database integrity_check failed: ${finalIntegrity}`)
  await coordinator.stop()
  client.close()

  console.log(
    JSON.stringify(
      {
        result: 'MARKDOWN WORKSPACE MIGRATION OK',
        project: { id: gameId, name: String(game.name), key: String(game.key) },
        dbPath,
        backupPath,
        workspaceRoot,
        counts: { before, after: finalCounts },
        export: exported,
        reconcile: reconciled,
        verification: { initial: firstVerification, final: finalVerification },
        smoke,
        timingsMs: {
          migrations: Number(migrationsMs.toFixed(1)),
          configure: Number(configureMs.toFixed(1)),
          export: Number(exportMs.toFixed(1)),
          reconcile: Number(reconcileMs.toFixed(1)),
        },
        integrity: finalIntegrity,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error('MARKDOWN WORKSPACE MIGRATION FAIL')
  console.error(error)
  process.exit(1)
})
