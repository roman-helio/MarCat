const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'marcat-workspace-test-'))
  const dbPath = path.join(temp, 'workspace.db')
  const vault = path.join(temp, 'vault')
  const migrations = path.resolve(__dirname, '../packages/db/migrations')
  const dbPackage = require('../packages/db/dist/index.cjs')
  const core = require('../packages/core/dist/index.cjs')
  const { db, client } = dbPackage.createDb(dbPackage.fileUrlFromPath(dbPath))
  await dbPackage.runMigrations(db, client, migrations)

  const gameId = '11111111-1111-4111-8111-111111111111'
  const insightId = '22222222-2222-4222-8222-222222222222'
  const tagId = '33333333-3333-4333-8333-333333333333'
  const blockerId = '44444444-4444-4444-8444-444444444444'
  const taskId = '55555555-5555-4555-8555-555555555555'
  const checklistId = '66666666-6666-4666-8666-666666666666'
  const activityId = '77777777-7777-4777-8777-777777777777'
  await db.insert(dbPackage.games).values({ id: gameId, name: 'Workspace Test', slug: 'workspace-test', key: 'WT' })
  await db.insert(dbPackage.projectCards).values({ gameId, oneLiner: 'A durable test project' })
  await db
    .insert(dbPackage.insights)
    .values({ id: insightId, gameId, title: 'Original insight', body: 'Original body' })
  await db.insert(dbPackage.tags).values({ id: tagId, gameId, name: 'Launch', targetDate: '2026-08-01' })
  await db.insert(dbPackage.tasks).values([
    { id: blockerId, gameId, seq: 1, title: 'Prepare assets' },
    { id: taskId, gameId, seq: 2, title: 'Publish post', description: 'Ship it', status: 'blocked' },
  ])
  await db.insert(dbPackage.taskChecklistItems).values({
    id: checklistId,
    taskId,
    text: 'Proofread',
  })
  await db.insert(dbPackage.taskDependencies).values({ blockerTaskId: blockerId, blockedTaskId: taskId })
  await db.insert(dbPackage.taskTagLinks).values({ taskId, tagId })
  await db.insert(dbPackage.events).values({
    id: activityId,
    gameId,
    occurredAt: '2026-07-20',
    type: 'post',
    platform: 'reddit',
    title: 'Launch announcement',
    description: 'Published to the community.',
    views: 1200,
    likes: 87,
    comments: 12,
    sourceId: 'source-1',
    externalId: 'reddit-post-1',
    creatorId: 'creator-1',
    templateId: 'template-1',
  })

  const repository = new core.DrizzleWorkspaceRepository(db)
  const coordinator = new core.MarkdownWorkspaceCoordinator(repository, {
    now: () => new Date('2026-07-22T12:00:00.000Z'),
  })
  await coordinator.configure({ gameId, rootPath: vault })
  const first = await coordinator.exportAll(gameId)
  assert.equal(first.exported, 6)
  const desktopCaller = core.appRouter.createCaller({ db, workspace: coordinator })

  const workspace = path.join(vault, 'MarCat')
  const projectPath = path.join(workspace, 'Project.md')
  const projectBeforeNoop = await fs.stat(projectPath)
  const noopExport = await coordinator.exportAll(gameId)
  const projectAfterNoop = await fs.stat(projectPath)
  assert.equal(noopExport.exported, 0)
  assert.equal(projectAfterNoop.mtimeMs, projectBeforeNoop.mtimeMs)
  const tasksBasePath = path.join(workspace, 'Views', 'Tasks.base')
  const tasksBase = await fs.readFile(tasksBasePath, 'utf8')
  assert.match(tasksBase, /note\["marcat-type"\] == "task"/)
  assert.match(tasksBase, /"marcat-status"/)
  assert.match(tasksBase, /"marcat-priority"/)
  assert.match(tasksBase, /"marcat-due"/)
  assert.match(tasksBase, /"marcat-tags"/)
  assert.deepEqual((await fs.readdir(path.join(workspace, 'Views'))).sort(), [
    'Activity.base',
    'Campaigns.base',
    'Insights.base',
    'Tasks.base',
  ])
  await fs.writeFile(tasksBasePath, `${tasksBase}# user customization\n`)
  await coordinator.exportAll(gameId)
  assert.match(await fs.readFile(tasksBasePath, 'utf8'), /# user customization/)
  const insightPath = path.join(workspace, 'Insights', 'original-insight--22222222.md')
  let markdown = await fs.readFile(insightPath, 'utf8')
  assert.match(markdown, /marcat-type: insight/)

  const taskPath = path.join(workspace, 'Tasks', 'WT-2.md')
  let taskMarkdown = await fs.readFile(taskPath, 'utf8')
  assert.match(taskMarkdown, /marcat-blocked-by:\n\s+- 44444444/)
  assert.match(taskMarkdown, /marcat-tags:\n\s+- Launch/)
  assert.match(taskMarkdown, /\[ \] Proofread <!-- marcat-checklist-id:66666666/)
  taskMarkdown = taskMarkdown
    .replace('marcat-status: blocked', 'marcat-status: doing')
    .replace('[ ] Proofread', '[x] Proofread')
    .replace('## Checklist', '## Research\n\nKeep this user-authored section.\n\n## Checklist')
  await fs.writeFile(taskPath, taskMarkdown)
  const taskEdited = await coordinator.reconcile(gameId)
  assert.equal(taskEdited.imported, 1)
  const taskAfter = (
    await db.select().from(dbPackage.tasks).where(require('drizzle-orm').eq(dbPackage.tasks.id, taskId))
  )[0]
  const checklistAfter = (
    await db
      .select()
      .from(dbPackage.taskChecklistItems)
      .where(require('drizzle-orm').eq(dbPackage.taskChecklistItems.taskId, taskId))
  )[0]
  assert.equal(taskAfter.status, 'doing')
  assert.equal(checklistAfter.done, true)
  assert.match(await fs.readFile(taskPath, 'utf8'), /## Research\n\nKeep this user-authored section\./)

  // Desktop-style tRPC writes are durably queued by triggers and drained by middleware.
  await desktopCaller.tasks.update({ id: taskId, patch: { description: 'Updated through desktop caller' } })
  const taskAfterCaller = await fs.readFile(taskPath, 'utf8')
  assert.match(taskAfterCaller, /Updated through desktop caller/)
  assert.match(taskAfterCaller, /## Research\n\nKeep this user-authored section\./)
  await desktopCaller.tasks.toggleChecklistItem({ id: checklistId, done: false })
  assert.match(await fs.readFile(taskPath, 'utf8'), /- \[ \] Proofread/)
  await desktopCaller.tasks.toggleChecklistItem({ id: checklistId, done: true })
  await desktopCaller.tags.update({ id: tagId, patch: { name: 'Release' } })
  assert.match(await fs.readFile(taskPath, 'utf8'), /marcat-tags:\n\s+- Release/)

  // Every user-relevant activity field round-trips through Markdown.
  const activityRegistry = (await repository.listFiles(gameId)).find((row) => row.entityId === activityId)
  const activityPath = path.join(workspace, ...activityRegistry.relativePath.split('/'))
  let activityMarkdown = await fs.readFile(activityPath, 'utf8')
  assert.match(activityMarkdown, /marcat-views: 1200/)
  assert.match(activityMarkdown, /marcat-source-id: source-1/)
  activityMarkdown = activityMarkdown.replace('marcat-likes: 87', 'marcat-likes: 99')
  await fs.writeFile(activityPath, activityMarkdown)
  await coordinator.reconcile(gameId)
  const activityAfter = (
    await db.select().from(dbPackage.events).where(require('drizzle-orm').eq(dbPackage.events.id, activityId))
  )[0]
  assert.equal(activityAfter.likes, 99)
  assert.equal(activityAfter.templateId, 'template-1')
  assert.equal(activityAfter.externalId, 'reddit-post-1')

  // External edit: custom frontmatter survives the import normalization round-trip.
  markdown = markdown.replace('marcat-type: insight', 'marcat-type: insight\nmy-private-property: keep-me')
  markdown = markdown.replace('# Original insight\n\nOriginal body', '# Edited in Obsidian\n\nExternal body')
  await fs.writeFile(insightPath, markdown)
  const edited = await coordinator.reconcile(gameId)
  assert.equal(edited.imported, 1)
  const insight = (
    await db.select().from(dbPackage.insights).where(require('drizzle-orm').eq(dbPackage.insights.id, insightId))
  )[0]
  assert.equal(insight.title, 'Edited in Obsidian')
  assert.equal(insight.body, 'External body')
  assert.match(await fs.readFile(insightPath, 'utf8'), /my-private-property: keep-me/)

  // Project/user H2 sections are not owned by MarCat and survive subsequent exports.
  let projectMarkdown = await fs.readFile(projectPath, 'utf8')
  projectMarkdown += '\n## Research\n\nOwner notes that MarCat must not erase.\n'
  await fs.writeFile(projectPath, projectMarkdown)
  await coordinator.reconcile(gameId)
  await desktopCaller.projectCards.update({ gameId, oneLiner: 'Updated card' })
  assert.match(await fs.readFile(projectPath, 'utf8'), /## Research\n\nOwner notes that MarCat must not erase\./)

  // External create without an id: importer assigns and persists one.
  const createdPath = path.join(workspace, 'Insights', 'new-from-obsidian.md')
  await fs.writeFile(createdPath, '---\nmarcat-type: insight\n---\n\n# New from Obsidian\n\nPortable knowledge.\n')
  const created = await coordinator.reconcile(gameId)
  assert.equal(created.imported, 1)
  const createdMarkdown = await fs.readFile(createdPath, 'utf8')
  assert.match(createdMarkdown, /marcat-id: [0-9a-f-]{36}/)
  const insightRows = await db.select().from(dbPackage.insights)
  assert.equal(insightRows.length, 2)

  // Imported dependencies use the same blocked-state and completion invariants as the UI.
  const importedTaskId = '99999999-9999-4999-8999-999999999999'
  const importedTaskPath = path.join(workspace, 'Tasks', 'imported-dependent.md')
  await fs.writeFile(
    importedTaskPath,
    `---\nmarcat-type: task\nmarcat-id: ${importedTaskId}\nmarcat-status: todo\nmarcat-blocked-by:\n  - ${blockerId}\n---\n\n# Imported dependent\n\n## Description\n\nWait for the blocker.\n`,
  )
  await coordinator.reconcile(gameId)
  const importedTask = (
    await db.select().from(dbPackage.tasks).where(require('drizzle-orm').eq(dbPackage.tasks.id, importedTaskId))
  )[0]
  assert.equal(importedTask.status, 'blocked')
  const invalidDoneId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  await fs.writeFile(
    path.join(workspace, 'Tasks', 'invalid-done.md'),
    `---\nmarcat-type: task\nmarcat-id: ${invalidDoneId}\nmarcat-status: done\n---\n\n# Invalid done\n\n## Checklist\n\n- [ ] Still open\n`,
  )
  const invalidDone = await coordinator.reconcile(gameId)
  assert.ok(invalidDone.invalid >= 1)
  assert.equal(
    (await db.select().from(dbPackage.tasks).where(require('drizzle-orm').eq(dbPackage.tasks.id, invalidDoneId)))
      .length,
    0,
  )
  const invalidStatusId = 'abababab-abab-4bab-8bab-abababababab'
  await fs.writeFile(
    path.join(workspace, 'Tasks', 'invalid-status.md'),
    `---\nmarcat-type: task\nmarcat-id: ${invalidStatusId}\nmarcat-status: doign\n---\n\n# Typo must not reset data\n`,
  )
  const invalidStatus = await coordinator.reconcile(gameId)
  assert.ok(invalidStatus.invalid >= 1)
  assert.equal(
    (await db.select().from(dbPackage.tasks).where(require('drizzle-orm').eq(dbPackage.tasks.id, invalidStatusId)))
      .length,
    0,
  )

  // Rename is identity based, not path based.
  const renamedPath = path.join(workspace, 'Insights', 'renamed-by-user.md')
  await fs.rename(insightPath, renamedPath)
  const renamed = await coordinator.reconcile(gameId)
  assert.equal(renamed.renamed, 1)
  const registryAfterRename = await repository.listFiles(gameId)
  assert.equal(
    registryAfterRename.find((row) => row.entityId === insightId).relativePath,
    'Insights/renamed-by-user.md',
  )

  // Missing files quarantine the record; they never hard-delete user data.
  await fs.unlink(renamedPath)
  const missing = await coordinator.reconcile(gameId)
  assert.equal(missing.missing, 1)
  assert.equal((await db.select().from(dbPackage.insights)).length, 2)
  assert.equal((await repository.listFiles(gameId)).find((row) => row.entityId === insightId).status, 'missing')
  await desktopCaller.insights.update({ id: insightId, body: 'DB edit while its file is missing' })
  await assert.rejects(() => fs.readFile(renamedPath, 'utf8'), /ENOENT/)
  assert.equal((await repository.listFiles(gameId)).find((row) => row.entityId === insightId).status, 'missing')
  await coordinator.decideMissing(gameId, 'insight', insightId, 'restore')
  assert.match(await fs.readFile(renamedPath, 'utf8'), /DB edit while its file is missing/)

  // Accepting an external deletion archives the snapshot. A later DB edit
  // deliberately resurrects a fresh live file instead of writing invisibly in Quarantine.
  await fs.unlink(renamedPath)
  await coordinator.reconcile(gameId)
  await coordinator.decideMissing(gameId, 'insight', insightId, 'quarantine')
  const archived = (await repository.listFiles(gameId)).find((row) => row.entityId === insightId)
  assert.equal(archived.status, 'quarantined')
  const archivedPath = path.join(workspace, ...archived.relativePath.split('/'))
  assert.match(await fs.readFile(archivedPath, 'utf8'), /DB edit while its file is missing/)
  await desktopCaller.insights.update({ id: insightId, body: 'Resurrected from MarCat' })
  const resurrected = (await repository.listFiles(gameId)).find((row) => row.entityId === insightId)
  assert.equal(resurrected.status, 'synced')
  assert.match(resurrected.relativePath, /^Insights\//)
  assert.match(await fs.readFile(path.join(workspace, ...resurrected.relativePath.split('/')), 'utf8'), /Resurrected/)
  assert.match(await fs.readFile(archivedPath, 'utf8'), /DB edit while its file is missing/)

  // Invalid YAML is isolated and surfaced as a durable issue.
  await fs.writeFile(path.join(workspace, 'Insights', 'invalid.md'), '---\nmarcat-type: [broken\n---\n# Broken\n')
  const invalid = await coordinator.reconcile(gameId)
  assert.ok(invalid.invalid >= 1)

  // Concurrent external + DB edits preserve both versions and mark a conflict.
  const newEntity = insightRows.find((row) => row.id !== insightId)
  const newRegistry = (await repository.listFiles(gameId)).find((row) => row.entityId === newEntity.id)
  const newPath = path.join(workspace, ...newRegistry.relativePath.split('/'))
  const beforeConflict = await fs.readFile(newPath, 'utf8')
  await fs.writeFile(newPath, beforeConflict.replace('Portable knowledge.', 'External concurrent edit.'))
  await db
    .update(dbPackage.insights)
    .set({ body: 'MarCat concurrent edit', updatedAt: '2026-07-22T12:01:00.000Z' })
    .where(require('drizzle-orm').eq(dbPackage.insights.id, newEntity.id))
  await coordinator.enqueueEntityChange(gameId, 'insight', newEntity.id)
  await coordinator.drainOutbox(gameId)
  assert.match(await fs.readFile(newPath, 'utf8'), /External concurrent edit/)
  assert.equal((await repository.listFiles(gameId)).find((row) => row.entityId === newEntity.id).status, 'conflict')
  assert.ok((await fs.readdir(path.join(workspace, 'Conflicts'))).length >= 1)

  // A generated-name collision never overwrites an unregistered user file.
  const collisionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const occupiedPath = path.join(workspace, 'Insights', 'collision--dddddddd.md')
  const occupiedContent = '# This file belongs to the user, not MarCat.\n'
  await fs.writeFile(occupiedPath, occupiedContent)
  await db.insert(dbPackage.insights).values({ id: collisionId, gameId, title: 'Collision', body: 'Safe export.' })
  await coordinator.drainOutbox(gameId)
  assert.equal(await fs.readFile(occupiedPath, 'utf8'), occupiedContent)
  const collisionRegistry = (await repository.listFiles(gameId)).find((row) => row.entityId === collisionId)
  assert.notEqual(collisionRegistry.relativePath, 'Insights/collision--dddddddd.md')
  assert.match(
    await fs.readFile(path.join(workspace, ...collisionRegistry.relativePath.split('/')), 'utf8'),
    /Safe export\./,
  )

  // An import guard suppresses only its own entity, not a concurrent process write.
  const guardOwner = 'cross-process-regression'
  await db.insert(dbPackage.workspaceImportGuard).values({
    gameId,
    entityType: 'insight',
    entityId: insightId,
    owner: guardOwner,
  })
  await db
    .update(dbPackage.insights)
    .set({ body: 'Concurrent entity survives the guard' })
    .where(require('drizzle-orm').eq(dbPackage.insights.id, collisionId))
  assert.equal(await repository.hasPendingOutbox(gameId, 'insight', collisionId), true)
  await db
    .delete(dbPackage.workspaceImportGuard)
    .where(require('drizzle-orm').eq(dbPackage.workspaceImportGuard.owner, guardOwner))
  await coordinator.drainOutbox(gameId)

  // MCP-style callers use the same context/middleware contract and delete to quarantine.
  const mcpCoordinator = new core.MarkdownWorkspaceCoordinator(new core.DrizzleWorkspaceRepository(db))
  await mcpCoordinator.start()
  const mcpCaller = core.appRouter.createCaller({ db, workspace: mcpCoordinator })
  const deletedInsight = await mcpCaller.insights.create({
    gameId,
    title: 'Delete safely',
    body: 'This content must survive deletion.',
    createdBy: 'mcp',
  })
  const deletedRegistry = (await repository.listFiles(gameId)).find((row) => row.entityId === deletedInsight.id)
  assert.ok(deletedRegistry)
  const liveDeletedPath = path.join(workspace, ...deletedRegistry.relativePath.split('/'))
  assert.match(await fs.readFile(liveDeletedPath, 'utf8'), /This content must survive deletion/)
  await fs.writeFile(
    liveDeletedPath,
    (await fs.readFile(liveDeletedPath, 'utf8')).replace(
      'This content must survive deletion.',
      'Edited externally before the next MCP read.',
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(
    (await mcpCaller.insights.get({ id: deletedInsight.id })).body,
    'Edited externally before the next MCP read.',
  )
  await mcpCaller.insights.remove({ id: deletedInsight.id })
  await assert.rejects(() => fs.readFile(liveDeletedPath, 'utf8'), /ENOENT/)
  const quarantined = (await repository.listFiles(gameId)).find((row) => row.entityId === deletedInsight.id)
  assert.equal(quarantined.status, 'quarantined')
  assert.match(quarantined.relativePath, /^Quarantine\/Deleted\//)
  assert.match(
    await fs.readFile(path.join(workspace, ...quarantined.relativePath.split('/')), 'utf8'),
    /Edited externally before the next MCP read/,
  )
  await mcpCoordinator.stop()

  // Traversal is rejected before any filesystem operation.
  assert.throws(() => core.resolveContained(workspace, '../escape.md'), /escapes its root/)

  // Durable outbox is picked up by a fresh coordinator after a simulated restart.
  await db
    .update(dbPackage.projectCards)
    .set({ oneLiner: 'Written after restart' })
    .where(require('drizzle-orm').eq(dbPackage.projectCards.gameId, gameId))
  await coordinator.enqueueEntityChange(gameId, 'project', gameId)
  const restarted = new core.MarkdownWorkspaceCoordinator(new core.DrizzleWorkspaceRepository(db))
  assert.equal(await restarted.drainOutbox(gameId), 1)
  assert.match(await fs.readFile(path.join(workspace, 'Project.md'), 'utf8'), /Written after restart/)

  // Competing desktop/MCP drainers claim a durable outbox row exactly once.
  await db
    .update(dbPackage.projectCards)
    .set({ oneLiner: 'One writer wins' })
    .where(require('drizzle-orm').eq(dbPackage.projectCards.gameId, gameId))
  const racing = new core.MarkdownWorkspaceCoordinator(new core.DrizzleWorkspaceRepository(db))
  const raceResults = await Promise.all([restarted.drainOutbox(gameId), racing.drainOutbox(gameId)])
  assert.equal(raceResults[0] + raceResults[1], 1)
  assert.match(await fs.readFile(path.join(workspace, 'Project.md'), 'utf8'), /One writer wins/)

  const status = await restarted.status(gameId)
  assert.ok(status.openIssues >= 2)
  assert.equal(status.pendingWrites, 0)

  // No config means no outbox, filesystem or request-time sync overhead/behaviour.
  const plainGameId = '88888888-8888-4888-8888-888888888888'
  await db.insert(dbPackage.games).values({ id: plainGameId, name: 'Plain DB Project', slug: 'plain-db', key: 'PLAIN' })
  const plainCaller = core.appRouter.createCaller({ db, workspace: restarted })
  await plainCaller.insights.create({ gameId: plainGameId, title: 'SQLite only', body: 'No workspace configured.' })
  const plainOutbox = await db
    .select()
    .from(dbPackage.workspaceOutbox)
    .where(require('drizzle-orm').eq(dbPackage.workspaceOutbox.gameId, plainGameId))
  assert.equal(plainOutbox.length, 0)

  // Changing a configured root leaves the old user-owned files untouched and
  // exports a complete fresh registry instead of getting stuck as "missing".
  const movedGameId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const movedInsightId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const firstVault = path.join(temp, 'first project ü')
  const secondVault = path.join(temp, 'second project ü')
  await db.insert(dbPackage.games).values({ id: movedGameId, name: 'Moved project', slug: 'moved', key: 'MOVE' })
  await db
    .insert(dbPackage.insights)
    .values({ id: movedInsightId, gameId: movedGameId, title: 'Moves safely', body: 'Still here.' })
  await restarted.configure({ gameId: movedGameId, rootPath: firstVault, workspaceFolder: 'Docs/MarCat Notes' })
  await restarted.exportAll(movedGameId)
  const oldProjectFile = path.join(firstVault, 'Docs', 'MarCat Notes', 'Project.md')
  assert.match(await fs.readFile(oldProjectFile, 'utf8'), /Moved project/)
  await restarted.configure({ gameId: movedGameId, rootPath: secondVault, workspaceFolder: 'Docs/MarCat Notes' })
  const movedExport = await restarted.enable(movedGameId)
  assert.equal(movedExport.exported, 2)
  assert.match(await fs.readFile(path.join(secondVault, 'Docs', 'MarCat Notes', 'Project.md'), 'utf8'), /Moved project/)
  assert.match(await fs.readFile(oldProjectFile, 'utf8'), /Moved project/)

  // Project deletion archives every exported document before disabling its watcher/config.
  const doomedGameId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const doomedInsightId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const doomedVault = path.join(temp, 'doomed-vault')
  await db.insert(dbPackage.games).values({ id: doomedGameId, name: 'Doomed Project', slug: 'doomed', key: 'DOOM' })
  await db
    .insert(dbPackage.insights)
    .values({ id: doomedInsightId, gameId: doomedGameId, title: 'Preserve me', body: 'Even with the project.' })
  await restarted.configure({ gameId: doomedGameId, rootPath: doomedVault })
  await restarted.exportAll(doomedGameId)
  const doomedCaller = core.appRouter.createCaller({ db, workspace: restarted })
  await doomedCaller.games.remove({ id: doomedGameId })
  const doomedFiles = await new core.DrizzleWorkspaceRepository(db).listFiles(doomedGameId)
  assert.ok(doomedFiles.length >= 2)
  assert.ok(doomedFiles.every((file) => file.status === 'quarantined'))
  assert.equal((await restarted.status(doomedGameId)).config.enabled, false)

  await restarted.stop()
  await client.close()
  try {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch (error) {
    if (error.code !== 'EBUSY') throw error
  }
  console.log('workspace engine tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
