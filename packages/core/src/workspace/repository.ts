import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import {
  changeLog,
  events,
  games,
  insights,
  nextTaskSeq,
  projectCards,
  tags,
  taskChecklistItems,
  taskDependencies,
  taskTagLinks,
  tasks,
  workspaceConfigs,
  workspaceFiles,
  workspaceImportGuard,
  workspaceOutbox,
  workspaceSyncIssues,
  type DB,
} from '@marcat/db'
import type {
  WorkspaceConfigInput,
  WorkspaceConfigRecord,
  WorkspaceEntity,
  WorkspaceEntityType,
  WorkspaceFileRecord,
  WorkspaceIssueInput,
  WorkspaceIssueRecord,
  WorkspaceStatus,
} from './types'

const nowIso = () => new Date().toISOString()
const parseJsonArray = (value: string | null): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function syncImportedBlockedStatus(db: DB, gameId: string): Promise<void> {
  const taskRows = await db.select().from(tasks).where(eq(tasks.gameId, gameId))
  const ids = taskRows.map((task) => task.id)
  const dependencies = ids.length
    ? await db
        .select()
        .from(taskDependencies)
        .where(and(inArray(taskDependencies.blockerTaskId, ids), inArray(taskDependencies.blockedTaskId, ids)))
    : []
  const statusById = new Map(taskRows.map((task) => [task.id, task.status]))
  const blockers = new Map<string, string[]>()
  for (const dependency of dependencies) {
    blockers.set(dependency.blockedTaskId, [
      ...(blockers.get(dependency.blockedTaskId) ?? []),
      dependency.blockerTaskId,
    ])
  }
  const updatedAt = nowIso()
  for (const task of taskRows) {
    const taskBlockers = blockers.get(task.id)
    if (!taskBlockers?.length) continue
    const hasOpen = taskBlockers.some((id) => !['done', 'cancelled'].includes(statusById.get(id) ?? 'todo'))
    if (hasOpen && task.status === 'todo') {
      await db.update(tasks).set({ status: 'blocked', updatedAt }).where(eq(tasks.id, task.id))
    } else if (!hasOpen && task.status === 'blocked') {
      await db.update(tasks).set({ status: 'todo', updatedAt }).where(eq(tasks.id, task.id))
    }
  }
}

export interface WorkspaceFileUpsert {
  id?: string
  gameId: string
  entityType: WorkspaceEntityType
  entityId: string
  relativePath: string
  contentHash: string
  baseHash: string
  baseContent: string
  revision: number
  status?: WorkspaceFileRecord['status']
  missingSince?: string | null
  mtimeMs?: number | null
  size?: number | null
}

export interface WorkspaceRepository {
  listConfigs(enabledOnly?: boolean): Promise<WorkspaceConfigRecord[]>
  gameExists(gameId: string): Promise<boolean>
  getConfig(gameId: string): Promise<WorkspaceConfigRecord | null>
  saveConfig(input: WorkspaceConfigInput): Promise<WorkspaceConfigRecord>
  resetRegistry(gameId: string): Promise<void>
  disableConfig(gameId: string): Promise<void>
  releaseStaleImportGuards(before: string): Promise<void>
  markScanned(gameId: string, at: string): Promise<void>
  listEntities(gameId: string): Promise<WorkspaceEntity[]>
  getEntity(gameId: string, type: WorkspaceEntityType, id: string): Promise<WorkspaceEntity | null>
  ingestEntity(entity: WorkspaceEntity): Promise<WorkspaceEntity>
  listFiles(gameId: string): Promise<WorkspaceFileRecord[]>
  upsertFile(input: WorkspaceFileUpsert): Promise<WorkspaceFileRecord>
  patchFile(id: string, patch: Partial<WorkspaceFileRecord>): Promise<void>
  recordIssue(input: WorkspaceIssueInput): Promise<void>
  resolveIssues(gameId: string, relativePath?: string): Promise<void>
  listIssues(gameId: string, includeResolved?: boolean): Promise<WorkspaceIssueRecord[]>
  resolveIssue(id: string): Promise<void>
  pendingGameIds(): Promise<string[]>
  hasPendingOutbox(gameId: string, entityType: string, entityId: string): Promise<boolean>
  enqueue(
    gameId: string,
    entityType: WorkspaceEntityType,
    entityId: string,
    operation?: 'upsert' | 'quarantine',
    payloadJson?: string,
  ): Promise<void>
  pendingOutbox(
    gameId: string,
    limit?: number,
  ): Promise<
    Array<{
      id: number
      entityType: string
      entityId: string
      operation: 'upsert' | 'quarantine'
      payloadJson: string
      attempts: number
    }>
  >
  completeOutbox(id: number): Promise<void>
  failOutbox(id: number, error: string, attempts: number): Promise<void>
  getStatus(gameId: string): Promise<WorkspaceStatus>
}

export class DrizzleWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: DB) {}

  async listConfigs(enabledOnly = false): Promise<WorkspaceConfigRecord[]> {
    return enabledOnly
      ? this.db.select().from(workspaceConfigs).where(eq(workspaceConfigs.enabled, true))
      : this.db.select().from(workspaceConfigs)
  }

  async gameExists(gameId: string): Promise<boolean> {
    return Boolean((await this.db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1))[0])
  }

  async getConfig(gameId: string): Promise<WorkspaceConfigRecord | null> {
    const row = (await this.db.select().from(workspaceConfigs).where(eq(workspaceConfigs.gameId, gameId)).limit(1))[0]
    return row ?? null
  }

  async saveConfig(input: WorkspaceConfigInput): Promise<WorkspaceConfigRecord> {
    const now = nowIso()
    const row = (
      await this.db
        .insert(workspaceConfigs)
        .values({
          gameId: input.gameId,
          rootPath: input.rootPath,
          workspaceFolder: input.workspaceFolder ?? 'MarCat',
          enabled: input.enabled ?? true,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: workspaceConfigs.gameId,
          set: {
            rootPath: input.rootPath,
            workspaceFolder: input.workspaceFolder ?? 'MarCat',
            enabled: input.enabled ?? true,
            updatedAt: now,
          },
        })
        .returning()
    )[0]!
    return row
  }

  async disableConfig(gameId: string): Promise<void> {
    await this.db
      .update(workspaceConfigs)
      .set({ enabled: false, updatedAt: nowIso() })
      .where(eq(workspaceConfigs.gameId, gameId))
  }

  async resetRegistry(gameId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(workspaceSyncIssues).where(eq(workspaceSyncIssues.gameId, gameId))
      await tx.delete(workspaceFiles).where(eq(workspaceFiles.gameId, gameId))
    })
  }

  async releaseStaleImportGuards(before: string): Promise<void> {
    await this.db.delete(workspaceImportGuard).where(lt(workspaceImportGuard.createdAt, before))
  }

  async markScanned(gameId: string, at: string): Promise<void> {
    await this.db
      .update(workspaceConfigs)
      .set({ lastScanAt: at, updatedAt: at })
      .where(eq(workspaceConfigs.gameId, gameId))
  }

  async listEntities(gameId: string): Promise<WorkspaceEntity[]> {
    const game = (await this.db.select().from(games).where(eq(games.id, gameId)).limit(1))[0]
    if (!game) return []
    const card = (await this.db.select().from(projectCards).where(eq(projectCards.gameId, gameId)).limit(1))[0]
    const insightRows = await this.db.select().from(insights).where(eq(insights.gameId, gameId))
    const tagRows = await this.db.select().from(tags).where(eq(tags.gameId, gameId))
    const taskRows = await this.db.select().from(tasks).where(eq(tasks.gameId, gameId)).orderBy(asc(tasks.sortOrder))
    const taskIds = taskRows.map((task) => task.id)
    const checklistRows = taskIds.length
      ? await this.db
          .select()
          .from(taskChecklistItems)
          .where(inArray(taskChecklistItems.taskId, taskIds))
          .orderBy(asc(taskChecklistItems.sortOrder))
      : []
    const dependencyRows = taskIds.length
      ? await this.db.select().from(taskDependencies).where(inArray(taskDependencies.blockedTaskId, taskIds))
      : []
    const tagLinks = taskIds.length
      ? await this.db.select().from(taskTagLinks).where(inArray(taskTagLinks.taskId, taskIds))
      : []
    const activityRows = await this.db.select().from(events).where(eq(events.gameId, gameId))
    const tagName = new Map(tagRows.map((tag) => [tag.id, tag.name]))

    return [
      {
        type: 'project',
        id: game.id,
        gameId,
        name: game.name,
        key: game.key,
        steamAppId: game.steamAppId,
        steamStoreUrl: game.steamStoreUrl,
        releaseDate: game.releaseDate,
        color: game.color,
        oneLiner: card?.oneLiner ?? '',
        description: card?.description ?? '',
        audience: card?.audience ?? '',
        positioning: card?.positioning ?? '',
        repository: card?.repository ?? '',
        branch: card?.branch ?? '',
        devhubWikiUrl: card?.devhubWikiUrl ?? '',
        agentNotes: card?.agentNotes ?? '',
        links: parseJsonArray(card?.linksJson ?? null),
        docs: parseJsonArray(card?.docsJson ?? null),
        createdAt: game.createdAt,
        updatedAt: card?.updatedAt ?? game.updatedAt,
      },
      ...insightRows.map(
        (row): WorkspaceEntity => ({
          type: 'insight',
          id: row.id,
          gameId,
          title: row.title,
          body: row.body,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }),
      ),
      ...taskRows.map(
        (row): WorkspaceEntity => ({
          type: 'task',
          id: row.id,
          gameId,
          seq: row.seq,
          projectKey: game.key,
          title: row.title,
          description: row.description,
          status: row.status,
          priority: row.priority,
          startDate: row.startDate,
          dueDate: row.dueDate,
          reminderAt: row.reminderAt,
          completedAt: row.completedAt,
          recurrenceInterval: row.recurrenceInterval,
          recurrenceUnit: row.recurrenceUnit,
          lastCompletedAt: row.lastCompletedAt,
          sortOrder: row.sortOrder,
          checklist: checklistRows
            .filter((item) => item.taskId === row.id)
            .map((item) => ({ id: item.id, text: item.text, done: item.done })),
          blockedBy: dependencyRows.filter((link) => link.blockedTaskId === row.id).map((link) => link.blockerTaskId),
          tags: tagLinks
            .filter((link) => link.taskId === row.id)
            .map((link) => tagName.get(link.tagId))
            .filter((name): name is string => Boolean(name)),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }),
      ),
      ...tagRows.map(
        (row): WorkspaceEntity => ({
          type: 'tag',
          id: row.id,
          gameId,
          name: row.name,
          color: row.color,
          colorEnabled: row.colorEnabled,
          targetDate: row.targetDate,
          tagType: row.type,
        }),
      ),
      ...activityRows.map(
        (row): WorkspaceEntity => ({
          type: 'activity',
          id: row.id,
          gameId,
          occurredAt: row.occurredAt,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          subjectLabel: row.subjectLabel,
          showOnWishlist: row.showOnWishlist,
          direction: row.direction,
          channel: row.channel,
          statusAfter: row.statusAfter,
          templateId: row.templateId,
          activityType: row.type,
          platform: row.platform,
          placement: row.placement,
          title: row.title,
          description: row.description,
          url: row.url,
          views: row.views,
          likes: row.likes,
          comments: row.comments,
          isOwn: row.isOwn,
          sourceId: row.sourceId,
          externalId: row.externalId,
          creatorId: row.creatorId,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }),
      ),
    ]
  }

  async getEntity(gameId: string, type: WorkspaceEntityType, id: string): Promise<WorkspaceEntity | null> {
    return (await this.listEntities(gameId)).find((entity) => entity.type === type && entity.id === id) ?? null
  }

  async ingestEntity(entity: WorkspaceEntity): Promise<WorkspaceEntity> {
    const now = nowIso()
    const guardOwner = crypto.randomUUID()
    await this.db.insert(workspaceImportGuard).values({
      gameId: entity.gameId,
      entityType: entity.type,
      entityId: entity.id,
      owner: guardOwner,
    })
    try {
      if (entity.type === 'project') {
        await this.db.transaction(async (tx) => {
          await tx
            .update(games)
            .set({
              name: entity.name,
              key: entity.key,
              steamAppId: entity.steamAppId,
              steamStoreUrl: entity.steamStoreUrl,
              releaseDate: entity.releaseDate,
              color: entity.color,
              updatedAt: now,
            })
            .where(eq(games.id, entity.gameId))
          await tx
            .insert(projectCards)
            .values({
              gameId: entity.gameId,
              oneLiner: entity.oneLiner,
              description: entity.description,
              audience: entity.audience,
              positioning: entity.positioning,
              repository: entity.repository,
              branch: entity.branch,
              devhubWikiUrl: entity.devhubWikiUrl,
              agentNotes: entity.agentNotes,
              linksJson: JSON.stringify(entity.links),
              docsJson: JSON.stringify(entity.docs),
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: projectCards.gameId,
              set: {
                oneLiner: entity.oneLiner,
                description: entity.description,
                audience: entity.audience,
                positioning: entity.positioning,
                repository: entity.repository,
                branch: entity.branch,
                devhubWikiUrl: entity.devhubWikiUrl,
                agentNotes: entity.agentNotes,
                linksJson: JSON.stringify(entity.links),
                docsJson: JSON.stringify(entity.docs),
                updatedAt: now,
              },
            })
        })
      } else if (entity.type === 'insight') {
        await this.db
          .insert(insights)
          .values({
            id: entity.id,
            gameId: entity.gameId,
            title: entity.title,
            body: entity.body,
            createdBy: entity.createdBy,
            createdAt: entity.createdAt,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: insights.id,
            set: { title: entity.title, body: entity.body, createdBy: entity.createdBy, updatedAt: now },
          })
      } else if (entity.type === 'tag') {
        await this.db
          .insert(tags)
          .values({
            id: entity.id,
            gameId: entity.gameId,
            name: entity.name,
            color: entity.color,
            colorEnabled: entity.colorEnabled,
            targetDate: entity.targetDate,
            type: entity.tagType,
          })
          .onConflictDoUpdate({
            target: tags.id,
            set: {
              name: entity.name,
              color: entity.color,
              colorEnabled: entity.colorEnabled,
              targetDate: entity.targetDate,
              type: entity.tagType,
            },
          })
      } else if (entity.type === 'activity') {
        await this.db
          .insert(events)
          .values({
            id: entity.id,
            gameId: entity.gameId,
            occurredAt: entity.occurredAt,
            subjectType: entity.subjectType,
            subjectId: entity.subjectId,
            subjectLabel: entity.subjectLabel,
            showOnWishlist: entity.showOnWishlist,
            direction: entity.direction,
            channel: entity.channel,
            statusAfter: entity.statusAfter,
            templateId: entity.templateId,
            type: entity.activityType,
            platform: entity.platform,
            placement: entity.placement,
            title: entity.title,
            description: entity.description,
            url: entity.url,
            views: entity.views,
            likes: entity.likes,
            comments: entity.comments,
            isOwn: entity.isOwn,
            sourceId: entity.sourceId,
            externalId: entity.externalId,
            creatorId: entity.creatorId,
            createdBy: entity.createdBy,
            createdAt: entity.createdAt,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: events.id,
            set: {
              occurredAt: entity.occurredAt,
              subjectType: entity.subjectType,
              subjectId: entity.subjectId,
              subjectLabel: entity.subjectLabel,
              showOnWishlist: entity.showOnWishlist,
              direction: entity.direction,
              channel: entity.channel,
              statusAfter: entity.statusAfter,
              templateId: entity.templateId,
              type: entity.activityType,
              platform: entity.platform,
              placement: entity.placement,
              title: entity.title,
              description: entity.description,
              url: entity.url,
              views: entity.views,
              likes: entity.likes,
              comments: entity.comments,
              isOwn: entity.isOwn,
              sourceId: entity.sourceId,
              externalId: entity.externalId,
              creatorId: entity.creatorId,
              createdBy: entity.createdBy,
              updatedAt: now,
            },
          })
      } else {
        if (entity.status === 'done' && entity.checklist.some((item) => !item.done)) {
          throw new Error('A task with unchecked checklist items cannot be completed')
        }
        let seq = entity.seq
        const completedAt = entity.status === 'done' ? (entity.completedAt ?? now) : null
        const existing = (
          await this.db.select({ id: tasks.id, seq: tasks.seq }).from(tasks).where(eq(tasks.id, entity.id)).limit(1)
        )[0]
        if (!existing && !seq) seq = await nextTaskSeq(this.db, entity.gameId)
        await this.db.transaction(async (tx) => {
          await tx
            .insert(tasks)
            .values({
              id: entity.id,
              gameId: entity.gameId,
              seq,
              title: entity.title,
              description: entity.description,
              status: entity.status,
              priority: entity.priority,
              startDate: entity.startDate,
              dueDate: entity.dueDate,
              reminderAt: entity.reminderAt,
              completedAt,
              recurrenceInterval: entity.recurrenceInterval,
              recurrenceUnit: entity.recurrenceUnit,
              lastCompletedAt: entity.lastCompletedAt,
              sortOrder: entity.sortOrder,
              createdAt: entity.createdAt,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: tasks.id,
              set: {
                seq,
                title: entity.title,
                description: entity.description,
                status: entity.status,
                priority: entity.priority,
                startDate: entity.startDate,
                dueDate: entity.dueDate,
                reminderAt: entity.reminderAt,
                completedAt,
                recurrenceInterval: entity.recurrenceInterval,
                recurrenceUnit: entity.recurrenceUnit,
                lastCompletedAt: entity.lastCompletedAt,
                sortOrder: entity.sortOrder,
                updatedAt: now,
              },
            })
          await tx.delete(taskChecklistItems).where(eq(taskChecklistItems.taskId, entity.id))
          if (entity.checklist.length)
            await tx.insert(taskChecklistItems).values(
              entity.checklist.map((item, sortOrder) => ({
                id: item.id ?? crypto.randomUUID(),
                taskId: entity.id,
                text: item.text,
                done: item.done,
                sortOrder,
              })),
            )
          await tx.delete(taskDependencies).where(eq(taskDependencies.blockedTaskId, entity.id))
          const validBlockers = entity.blockedBy.length
            ? await tx
                .select({ id: tasks.id })
                .from(tasks)
                .where(and(eq(tasks.gameId, entity.gameId), inArray(tasks.id, entity.blockedBy)))
            : []
          if (validBlockers.length !== new Set(entity.blockedBy).size) {
            throw new Error('Every blocker must be an existing task in the same project')
          }
          if (entity.status === 'done' && validBlockers.length) {
            const blockerRows = await tx
              .select({ status: tasks.status })
              .from(tasks)
              .where(
                inArray(
                  tasks.id,
                  validBlockers.map((b) => b.id),
                ),
              )
            if (blockerRows.some((blocker) => blocker.status !== 'done' && blocker.status !== 'cancelled')) {
              throw new Error('A task with open blockers cannot be completed')
            }
          }
          if (validBlockers.length) {
            const gameTaskRows = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.gameId, entity.gameId))
            const gameTaskIds = gameTaskRows.map((task) => task.id)
            const existingDependencies = gameTaskIds.length
              ? await tx
                  .select()
                  .from(taskDependencies)
                  .where(
                    and(
                      inArray(taskDependencies.blockerTaskId, gameTaskIds),
                      inArray(taskDependencies.blockedTaskId, gameTaskIds),
                    ),
                  )
              : []
            const blockedByBlocker = new Map<string, string[]>()
            for (const dependency of existingDependencies) {
              if (dependency.blockedTaskId === entity.id) continue
              blockedByBlocker.set(dependency.blockerTaskId, [
                ...(blockedByBlocker.get(dependency.blockerTaskId) ?? []),
                dependency.blockedTaskId,
              ])
            }
            const reaches = (start: string, target: string): boolean => {
              const pending = [start]
              const seen = new Set<string>()
              while (pending.length) {
                const current = pending.pop()!
                if (current === target) return true
                if (seen.has(current)) continue
                seen.add(current)
                pending.push(...(blockedByBlocker.get(current) ?? []))
              }
              return false
            }
            if (validBlockers.some((blocker) => reaches(entity.id, blocker.id))) {
              throw new Error('Task dependencies would create a cycle')
            }
          }
          if (validBlockers.length)
            await tx
              .insert(taskDependencies)
              .values(validBlockers.map((blocker) => ({ blockerTaskId: blocker.id, blockedTaskId: entity.id })))
          await tx.delete(taskTagLinks).where(eq(taskTagLinks.taskId, entity.id))
          if (entity.tags.length) {
            const gameTags = await tx.select().from(tags).where(eq(tags.gameId, entity.gameId))
            const ids: string[] = []
            for (const name of [...new Set(entity.tags.map((tag) => tag.trim()).filter(Boolean))]) {
              const found = gameTags.find((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())
              if (found) ids.push(found.id)
              else {
                const inserted = await tx
                  .insert(tags)
                  .values({ gameId: entity.gameId, name })
                  .returning({ id: tags.id })
                ids.push(inserted[0]!.id)
              }
            }
            if (ids.length) await tx.insert(taskTagLinks).values(ids.map((tagId) => ({ taskId: entity.id, tagId })))
          }
        })
        await syncImportedBlockedStatus(this.db, entity.gameId)
      }
      await this.db.insert(changeLog).values({ entity: entity.type, entityId: entity.id, action: 'update' })
      return (await this.getEntity(entity.gameId, entity.type, entity.id))!
    } finally {
      await this.db
        .delete(workspaceImportGuard)
        .where(
          and(
            eq(workspaceImportGuard.gameId, entity.gameId),
            eq(workspaceImportGuard.entityType, entity.type),
            eq(workspaceImportGuard.entityId, entity.id),
            eq(workspaceImportGuard.owner, guardOwner),
          ),
        )
    }
  }

  async listFiles(gameId: string): Promise<WorkspaceFileRecord[]> {
    return this.db.select().from(workspaceFiles).where(eq(workspaceFiles.gameId, gameId))
  }

  async upsertFile(input: WorkspaceFileUpsert): Promise<WorkspaceFileRecord> {
    const now = nowIso()
    const values = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      status: input.status ?? ('synced' as const),
      missingSince: input.missingSince ?? null,
      mtimeMs: input.mtimeMs ?? null,
      size: input.size ?? null,
      lastSyncedAt: now,
      updatedAt: now,
    }
    const row = (
      await this.db
        .insert(workspaceFiles)
        .values(values)
        .onConflictDoUpdate({
          target: [workspaceFiles.gameId, workspaceFiles.entityType, workspaceFiles.entityId],
          set: {
            relativePath: input.relativePath,
            contentHash: input.contentHash,
            baseHash: input.baseHash,
            baseContent: input.baseContent,
            revision: input.revision,
            status: input.status ?? 'synced',
            missingSince: input.missingSince ?? null,
            mtimeMs: input.mtimeMs ?? null,
            size: input.size ?? null,
            lastSyncedAt: now,
            updatedAt: now,
          },
        })
        .returning()
    )[0]!
    return row
  }

  async patchFile(id: string, patch: Partial<WorkspaceFileRecord>): Promise<void> {
    const allowed = {
      ...(patch.relativePath !== undefined ? { relativePath: patch.relativePath } : {}),
      ...(patch.contentHash !== undefined ? { contentHash: patch.contentHash } : {}),
      ...(patch.baseHash !== undefined ? { baseHash: patch.baseHash } : {}),
      ...(patch.baseContent !== undefined ? { baseContent: patch.baseContent } : {}),
      ...(patch.revision !== undefined ? { revision: patch.revision } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.missingSince !== undefined ? { missingSince: patch.missingSince } : {}),
      ...(patch.mtimeMs !== undefined ? { mtimeMs: patch.mtimeMs } : {}),
      ...(patch.size !== undefined ? { size: patch.size } : {}),
      updatedAt: nowIso(),
    }
    await this.db.update(workspaceFiles).set(allowed).where(eq(workspaceFiles.id, id))
  }

  async recordIssue(input: WorkspaceIssueInput): Promise<void> {
    const existing = (
      await this.db
        .select({ id: workspaceSyncIssues.id })
        .from(workspaceSyncIssues)
        .where(
          and(
            eq(workspaceSyncIssues.gameId, input.gameId),
            eq(workspaceSyncIssues.kind, input.kind),
            input.relativePath
              ? eq(workspaceSyncIssues.relativePath, input.relativePath)
              : isNull(workspaceSyncIssues.relativePath),
            isNull(workspaceSyncIssues.resolvedAt),
          ),
        )
        .limit(1)
    )[0]
    if (existing) {
      await this.db
        .update(workspaceSyncIssues)
        .set({ message: input.message, detailsJson: JSON.stringify(input.details ?? {}), updatedAt: nowIso() })
        .where(eq(workspaceSyncIssues.id, existing.id))
      return
    }
    await this.db.insert(workspaceSyncIssues).values({
      gameId: input.gameId,
      workspaceFileId: input.workspaceFileId ?? null,
      kind: input.kind,
      severity: input.severity ?? 'error',
      relativePath: input.relativePath ?? null,
      message: input.message,
      detailsJson: JSON.stringify(input.details ?? {}),
    })
  }

  async resolveIssues(gameId: string, relativePath?: string): Promise<void> {
    await this.db
      .update(workspaceSyncIssues)
      .set({ resolvedAt: nowIso(), updatedAt: nowIso() })
      .where(
        and(
          eq(workspaceSyncIssues.gameId, gameId),
          isNull(workspaceSyncIssues.resolvedAt),
          ...(relativePath ? [eq(workspaceSyncIssues.relativePath, relativePath)] : []),
        ),
      )
  }

  async listIssues(gameId: string, includeResolved = false): Promise<WorkspaceIssueRecord[]> {
    const rows = await this.db
      .select()
      .from(workspaceSyncIssues)
      .where(
        includeResolved
          ? eq(workspaceSyncIssues.gameId, gameId)
          : and(eq(workspaceSyncIssues.gameId, gameId), isNull(workspaceSyncIssues.resolvedAt)),
      )
      .orderBy(asc(workspaceSyncIssues.createdAt))
    return rows as WorkspaceIssueRecord[]
  }

  async resolveIssue(id: string): Promise<void> {
    await this.db
      .update(workspaceSyncIssues)
      .set({ resolvedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(workspaceSyncIssues.id, id))
  }

  async hasPendingOutbox(gameId: string, entityType: string, entityId: string): Promise<boolean> {
    const row = (
      await this.db
        .select({ id: workspaceOutbox.id })
        .from(workspaceOutbox)
        .where(
          and(
            eq(workspaceOutbox.gameId, gameId),
            eq(workspaceOutbox.entityType, entityType),
            eq(workspaceOutbox.entityId, entityId),
            isNull(workspaceOutbox.processedAt),
          ),
        )
        .limit(1)
    )[0]
    return Boolean(row)
  }

  async pendingGameIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ gameId: workspaceOutbox.gameId })
      .from(workspaceOutbox)
      .where(isNull(workspaceOutbox.processedAt))
    return rows.map((row) => row.gameId)
  }

  async enqueue(
    gameId: string,
    entityType: WorkspaceEntityType,
    entityId: string,
    operation: 'upsert' | 'quarantine' = 'upsert',
    payloadJson = '{}',
  ): Promise<void> {
    if (operation === 'upsert' && (await this.hasPendingOutbox(gameId, entityType, entityId))) return
    await this.db.insert(workspaceOutbox).values({ gameId, entityType, entityId, operation, payloadJson })
  }

  async pendingOutbox(gameId: string, limit = 100) {
    const now = nowIso()
    const staleClaim = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    // Claim and return in one SQLite statement so desktop and MCP processes cannot
    // both write the same outbox item. Abandoned claims become eligible after 5m.
    const rows = await this.db.all<{
      id: number
      entityType: string
      entityId: string
      operation: 'upsert' | 'quarantine'
      payloadJson: string
      attempts: number
    }>(sql`
      UPDATE workspace_outbox
      SET claimed_at = ${now}
      WHERE id IN (
        SELECT id FROM workspace_outbox
        WHERE game_id = ${gameId}
          AND processed_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          AND (claimed_at IS NULL OR claimed_at <= ${staleClaim})
        ORDER BY id
        LIMIT ${limit}
      )
      AND processed_at IS NULL
      AND (claimed_at IS NULL OR claimed_at <= ${staleClaim})
      RETURNING id, entity_type AS entityType, entity_id AS entityId,
        operation, payload_json AS payloadJson, attempts
    `)
    return rows.sort((a, b) => a.id - b.id)
  }

  async completeOutbox(id: number): Promise<void> {
    await this.db
      .update(workspaceOutbox)
      .set({ processedAt: nowIso(), claimedAt: null, lastError: null })
      .where(eq(workspaceOutbox.id, id))
  }

  async failOutbox(id: number, error: string, attempts: number): Promise<void> {
    const delay = Math.min(300, 2 ** Math.min(attempts, 8))
    const next = new Date(Date.now() + delay * 1000).toISOString()
    await this.db
      .update(workspaceOutbox)
      .set({ attempts: attempts + 1, claimedAt: null, lastError: error.slice(0, 2000), nextAttemptAt: next })
      .where(eq(workspaceOutbox.id, id))
  }

  async getStatus(gameId: string): Promise<WorkspaceStatus> {
    const [config, files, issues, pending] = await Promise.all([
      this.getConfig(gameId),
      this.listFiles(gameId),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(workspaceSyncIssues)
        .where(and(eq(workspaceSyncIssues.gameId, gameId), isNull(workspaceSyncIssues.resolvedAt))),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(workspaceOutbox)
        .where(and(eq(workspaceOutbox.gameId, gameId), isNull(workspaceOutbox.processedAt))),
    ])
    const counts: WorkspaceStatus['files'] = {
      synced: 0,
      dirty: 0,
      conflict: 0,
      missing: 0,
      invalid: 0,
      quarantined: 0,
    }
    for (const file of files) counts[file.status] += 1
    return {
      config,
      files: counts,
      openIssues: Number(issues[0]?.count ?? 0),
      pendingWrites: Number(pending[0]?.count ?? 0),
    }
  }
}
