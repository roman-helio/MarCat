import { randomUUID } from 'node:crypto'
import { posix, relative, resolve } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  atomicWriteWorkspaceFile,
  ensureSafeWorkspaceRoot,
  fileExists,
  hashContent,
  listVisibleMarkdownFiles,
  moveWorkspaceFile,
  normalizeRelativePath,
  readWorkspaceFile,
  resolveContained,
} from './filesystem'
import { defaultWorkspacePath, parseWorkspaceEntity, renderWorkspaceEntity } from './markdown'
import { ensureObsidianBases } from './obsidianBases'
import type { WorkspaceRepository } from './repository'
import {
  WorkspaceDocumentError,
  type WorkspaceConfigInput,
  type WorkspaceConfigRecord,
  type WorkspaceEntityType,
  type WorkspaceFileRecord,
  type WorkspaceScanResult,
  type WorkspaceStatus,
} from './types'

const ENTITY_TYPES = new Set<WorkspaceEntityType>(['project', 'insight', 'task', 'tag', 'activity'])

export interface WorkspaceCoordinatorOptions {
  now?: () => Date
  watcherDebounceMs?: number
  onError?: (error: unknown) => void
}

export interface WorkspaceWatchHandle {
  close(): Promise<void>
}

function blankResult(): WorkspaceScanResult {
  return { scanned: 0, imported: 0, exported: 0, renamed: 0, missing: 0, conflicts: 0, invalid: 0, issues: 0 }
}

function validateWorkspaceFolder(folder: string): string {
  const normalized = normalizeRelativePath(folder).replace(/\/$/, '')
  if (!normalized || normalized.split('/').some((part) => !part || part === '..' || part.startsWith('.'))) {
    throw new Error('Workspace folder must be a visible relative path')
  }
  // Performs the full absolute/traversal validation too.
  resolveContained(process.cwd(), normalized)
  return normalized
}

function sameFilesystemPath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b
}

export class MarkdownWorkspaceCoordinator {
  private readonly now: () => Date
  private readonly watcherDebounceMs: number
  private readonly onError: (error: unknown) => void
  private readonly reconcileLocks = new Map<string, Promise<WorkspaceScanResult>>()
  private readonly drainLocks = new Map<string, Promise<number>>()
  private readonly watchHandles = new Map<string, WorkspaceWatchHandle>()
  private readonly configuredGames = new Set<string>()
  private readonly dirtyGames = new Set<string>()
  private readonly reportedErrors = new WeakSet<object>()

  constructor(
    private readonly repository: WorkspaceRepository,
    options: WorkspaceCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.watcherDebounceMs = options.watcherDebounceMs ?? 180
    this.onError = options.onError ?? (() => undefined)
  }

  /** One rejected shared reconciliation promise can have several observers; report its Error object once. */
  private readonly reportError = (error: unknown): void => {
    if (error && typeof error === 'object') {
      if (this.reportedErrors.has(error)) return
      this.reportedErrors.add(error)
    }
    this.onError(error)
  }

  async configure(input: WorkspaceConfigInput): Promise<WorkspaceConfigRecord> {
    await this.stopWatching(input.gameId)
    const previous = await this.repository.getConfig(input.gameId)
    const rootPath = await ensureSafeWorkspaceRoot(input.rootPath)
    const workspaceFolder = validateWorkspaceFolder(input.workspaceFolder ?? 'MarCat')
    const workspaceRoot = await this.safeWorkspaceRoot(rootPath, workspaceFolder)
    await ensureObsidianBases(workspaceRoot)
    const config = await this.repository.saveConfig({ ...input, rootPath, workspaceFolder })
    if (
      previous &&
      (!sameFilesystemPath(previous.rootPath, rootPath) || previous.workspaceFolder !== workspaceFolder)
    ) {
      // The old workspace remains untouched and user-owned. Its registry cannot
      // be reused for the new root because that would turn every file into a
      // false missing-file decision and prevent the requested initial export.
      await this.repository.resetRegistry(input.gameId)
    }
    if (config.enabled) this.configuredGames.add(config.gameId)
    return config
  }

  /** Start all configured workspaces after DB migrations and recover durable outbox work. */
  async start(): Promise<void> {
    await this.repository.releaseStaleImportGuards(new Date(this.now().getTime() - 10 * 60_000).toISOString())
    for (const config of await this.repository.listConfigs(true)) {
      this.configuredGames.add(config.gameId)
      try {
        await this.reconcile(config.gameId)
        if ((await this.repository.listFiles(config.gameId)).length === 0) await this.exportAll(config.gameId)
        this.watchHandles.set(config.gameId, await this.watch(config.gameId))
      } catch (error) {
        this.reportError(error)
      }
    }
  }

  async enable(gameId: string): Promise<WorkspaceScanResult> {
    await this.stopWatching(gameId)
    this.configuredGames.add(gameId)
    const result = await this.reconcile(gameId)
    const initial = await this.exportAll(gameId)
    result.exported += initial.exported
    this.watchHandles.set(gameId, await this.watch(gameId))
    return result
  }

  async disable(gameId: string): Promise<void> {
    await this.stopWatching(gameId)
    this.configuredGames.delete(gameId)
    this.dirtyGames.delete(gameId)
    await this.repository.disableConfig(gameId)
  }

  async stop(): Promise<void> {
    await Promise.all([...this.watchHandles.values()].map((handle) => handle.close()))
    this.watchHandles.clear()
    this.configuredGames.clear()
    this.dirtyGames.clear()
  }

  private async stopWatching(gameId: string): Promise<void> {
    const handle = this.watchHandles.get(gameId)
    if (handle) await handle.close()
    this.watchHandles.delete(gameId)
  }

  /** Cheap request hook: only reconciles projects marked dirty by their watcher. */
  async beforeRequest(): Promise<void> {
    const dirty = [...this.dirtyGames]
    this.dirtyGames.clear()
    await Promise.all(dirty.map((gameId) => this.reconcile(gameId).catch(this.reportError)))
  }

  /** Durable triggers already queued changes; request callers wait only for pending file writes. */
  async afterMutation(): Promise<void> {
    if (this.configuredGames.size === 0) return
    const pending = (await this.repository.pendingGameIds()).filter((gameId) => this.configuredGames.has(gameId))
    await Promise.all(
      pending.map(async (gameId) => {
        try {
          await this.drainOutbox(gameId)
          if (!(await this.repository.gameExists(gameId))) await this.disable(gameId)
        } catch (error) {
          this.reportError(error)
        }
      }),
    )
  }

  async paths(gameId: string): Promise<{ root: string; files: Array<WorkspaceFileRecord & { absolutePath: string }> }> {
    const { root } = await this.workspaceRoot(gameId)
    const files = (await this.repository.listFiles(gameId)).map((file) => ({
      ...file,
      absolutePath: resolveContained(root, file.relativePath),
    }))
    return { root, files }
  }

  async status(gameId: string): Promise<WorkspaceStatus> {
    return this.repository.getStatus(gameId)
  }

  async listConfigs(): Promise<WorkspaceConfigRecord[]> {
    return this.repository.listConfigs()
  }

  /** Stable, human-accessible folder for immutable creator-discovery run artifacts. */
  async discoveryArchiveLocation(gameId: string): Promise<string> {
    const { root } = await this.workspaceRoot(gameId)
    const archive = await ensureSafeWorkspaceRoot(resolveContained(root, 'Discovery/Creators'))
    // Re-prove containment after realpath in case an existing folder was replaced with a symlink.
    resolveContained(root, relative(root, archive) || '.')
    return archive
  }

  /** Write one deterministic discovery artifact without touching unchanged files. */
  async writeDiscoveryArchive(
    gameId: string,
    runId: string,
    content: string,
  ): Promise<{ path: string; changed: boolean }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid discovery run id')
    const { root } = await this.workspaceRoot(gameId)
    const relativePath = `Discovery/Creators/${runId}.json`
    if (await fileExists(root, relativePath)) {
      const current = await readWorkspaceFile(root, relativePath)
      if (current.hash === hashContent(content)) {
        return { path: resolveContained(root, relativePath), changed: false }
      }
    }
    await atomicWriteWorkspaceFile(root, relativePath, content)
    return { path: resolveContained(root, relativePath), changed: true }
  }

  async listIssues(gameId: string, includeResolved = false) {
    return this.repository.listIssues(gameId, includeResolved)
  }

  async resolveIssue(id: string): Promise<void> {
    await this.repository.resolveIssue(id)
  }

  async decideMissing(
    gameId: string,
    entityType: WorkspaceEntityType,
    entityId: string,
    decision: 'restore' | 'quarantine',
  ): Promise<{ exported: number }> {
    await this.repository.enqueue(
      gameId,
      entityType,
      entityId,
      decision === 'restore' ? 'upsert' : 'quarantine',
      decision === 'restore' ? JSON.stringify({ restoreMissing: true }) : '{}',
    )
    return { exported: await this.drainOutbox(gameId) }
  }

  /** Queue a domain mutation from UI/MCP/AI. Calling this in the same DB transaction is durable. */
  async enqueueEntityChange(gameId: string, entityType: WorkspaceEntityType, entityId: string): Promise<void> {
    await this.repository.enqueue(gameId, entityType, entityId)
  }

  async exportAll(gameId: string): Promise<WorkspaceScanResult> {
    const { root } = await this.workspaceRoot(gameId)
    await ensureObsidianBases(root)
    const entities = await this.repository.listEntities(gameId)
    for (const entity of entities) await this.repository.enqueue(gameId, entity.type, entity.id)
    const result = blankResult()
    result.exported = await this.drainOutbox(gameId)
    return result
  }

  /** Full deterministic reconciliation; safe to run at startup and after watcher event bursts. */
  async reconcile(gameId: string): Promise<WorkspaceScanResult> {
    const active = this.reconcileLocks.get(gameId)
    if (active) return active
    const run = this.reconcileUnlocked(gameId).finally(() => this.reconcileLocks.delete(gameId))
    this.reconcileLocks.set(gameId, run)
    return run
  }

  private async workspaceRoot(gameId: string): Promise<{ config: WorkspaceConfigRecord; root: string }> {
    const config = await this.repository.getConfig(gameId)
    if (!config) throw new Error('Markdown workspace is not configured for this project')
    if (!config.enabled) throw new Error('Markdown workspace is disabled for this project')
    const base = await ensureSafeWorkspaceRoot(config.rootPath)
    const root = await this.safeWorkspaceRoot(base, validateWorkspaceFolder(config.workspaceFolder))
    return { config, root }
  }

  private async safeWorkspaceRoot(base: string, workspaceFolder: string): Promise<string> {
    const root = await ensureSafeWorkspaceRoot(resolveContained(base, workspaceFolder))
    // `realpath` may reveal that an existing workspace-folder symlink escapes
    // the selected project. Prove containment again using the canonical path.
    resolveContained(base, relative(base, root) || '.')
    return root
  }

  private async availableExportPath(
    root: string,
    preferredPath: string,
    entityId: string,
    registryByPath: Map<string, WorkspaceFileRecord>,
  ): Promise<string> {
    const occupied = async (candidate: string) => registryByPath.has(candidate) || (await fileExists(root, candidate))
    if (!(await occupied(preferredPath))) return preferredPath
    const extension = posix.extname(preferredPath) || '.md'
    const stem = preferredPath.slice(0, -extension.length)
    const stableSuffix = entityId.replace(/[^a-zA-Z0-9_-]/g, '') || randomUUID()
    const stable = `${stem}--${stableSuffix}${extension}`
    if (!(await occupied(stable))) return stable
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = `${stem}--${stableSuffix}-${randomUUID().slice(0, 8)}${extension}`
      if (!(await occupied(candidate))) return candidate
    }
    throw new Error(`Could not allocate a collision-safe workspace path for ${preferredPath}`)
  }

  private async reconcileUnlocked(gameId: string): Promise<WorkspaceScanResult> {
    const { root } = await this.workspaceRoot(gameId)
    const result = blankResult()
    const registry = await this.repository.listFiles(gameId)
    const openIssuePaths = new Set(
      (await this.repository.listIssues(gameId)).flatMap((issue) =>
        issue.relativePath ? [normalizeRelativePath(issue.relativePath)] : [],
      ),
    )
    const byEntity = new Map(registry.map((file) => [`${file.entityType}:${file.entityId}`, file]))
    const byPath = new Map(registry.map((file) => [normalizeRelativePath(file.relativePath), file]))
    const seenRegistryIds = new Set<string>()
    const seenEntityKeys = new Map<string, string>()
    const paths = (await listVisibleMarkdownFiles(root)).filter(
      (path) => !path.startsWith('Conflicts/') && !path.startsWith('Quarantine/'),
    )

    // Reading/parsing is sequential on purpose: it gives deterministic duplicate-id ownership.
    for (const relativePath of paths) {
      result.scanned += 1
      let disk
      try {
        disk = await readWorkspaceFile(root, relativePath)
        const entity = parseWorkspaceEntity(disk.content, {
          gameId,
          filename: relativePath,
          now: this.now().toISOString(),
        })
        const entityKey = `${entity.type}:${entity.id}`
        const duplicatePath = seenEntityKeys.get(entityKey)
        if (duplicatePath) {
          result.issues += 1
          await this.repository.recordIssue({
            gameId,
            kind: 'duplicate_id',
            relativePath,
            message: `Duplicate ${entity.type} id also exists in ${duplicatePath}`,
            details: { entityId: entity.id, duplicatePath },
          })
          continue
        }
        seenEntityKeys.set(entityKey, relativePath)
        let known = byEntity.get(entityKey)
        const pathOwner = byPath.get(relativePath)
        if (pathOwner && pathOwner.id !== known?.id) {
          result.issues += 1
          await this.repository.recordIssue({
            gameId,
            kind: 'duplicate_id',
            relativePath,
            message: 'File path is already registered to another MarCat entity',
          })
          continue
        }
        if (known) {
          seenRegistryIds.add(known.id)
          if (normalizeRelativePath(known.relativePath) !== relativePath) {
            if (await fileExists(root, known.relativePath)) {
              result.issues += 1
              await this.repository.recordIssue({
                gameId,
                workspaceFileId: known.id,
                kind: 'duplicate_id',
                relativePath,
                message: `Both the registered path and renamed path exist for ${entity.id}`,
              })
              continue
            }
            await this.repository.patchFile(known.id, { relativePath })
            known = { ...known, relativePath }
            result.renamed += 1
          }
          if (disk.hash === known.baseHash || disk.hash === known.contentHash) {
            // A clean full scan is read-only for unchanged files. Avoiding two
            // SQLite writes per file keeps large Obsidian vault rescans cheap.
            if (
              known.contentHash !== disk.hash ||
              known.status !== 'synced' ||
              known.missingSince !== null ||
              known.mtimeMs !== disk.mtimeMs ||
              known.size !== disk.size
            ) {
              await this.repository.patchFile(known.id, {
                contentHash: disk.hash,
                status: 'synced',
                missingSince: null,
                mtimeMs: disk.mtimeMs,
                size: disk.size,
              })
            }
            if (known.status !== 'synced' || openIssuePaths.has(relativePath)) {
              await this.repository.resolveIssues(gameId, relativePath)
            }
            continue
          }
          if (await this.repository.hasPendingOutbox(gameId, entity.type, entity.id)) {
            result.conflicts += 1
            result.issues += 1
            await this.repository.patchFile(known.id, { status: 'conflict', contentHash: disk.hash })
            await this.repository.recordIssue({
              gameId,
              workspaceFileId: known.id,
              kind: 'conflict',
              relativePath,
              message: 'The Markdown file and MarCat were edited since their last common revision',
              details: { baseHash: known.baseHash, fileHash: disk.hash },
            })
            continue
          }
        }

        const stored = await this.repository.ingestEntity(entity)
        const revision = (known?.revision ?? 0) + 1
        const normalized = renderWorkspaceEntity(stored, { existingContent: disk.content, revision })
        const finalDisk =
          normalized === disk.content ? disk : await atomicWriteWorkspaceFile(root, relativePath, normalized)
        const row = await this.repository.upsertFile({
          id: known?.id,
          gameId,
          entityType: stored.type,
          entityId: stored.id,
          relativePath,
          contentHash: finalDisk.hash,
          baseHash: finalDisk.hash,
          baseContent: finalDisk.content,
          revision,
          status: 'synced',
          mtimeMs: finalDisk.mtimeMs,
          size: finalDisk.size,
        })
        seenRegistryIds.add(row.id)
        byEntity.set(entityKey, row)
        result.imported += 1
        await this.repository.resolveIssues(gameId, relativePath)
      } catch (error) {
        result.invalid += 1
        result.issues += 1
        const kind = error instanceof WorkspaceDocumentError ? error.kind : 'io'
        await this.repository.recordIssue({
          gameId,
          workspaceFileId: byPath.get(relativePath)?.id,
          kind,
          relativePath,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const missingAt = this.now().toISOString()
    for (const file of registry) {
      if (seenRegistryIds.has(file.id)) continue
      if (file.status === 'quarantined') continue
      // Conflict/quarantine artifacts are not part of the live registry tree.
      if (!(await fileExists(root, file.relativePath))) {
        result.missing += 1
        result.issues += 1
        await this.repository.patchFile(file.id, {
          status: 'missing',
          missingSince: file.missingSince ?? missingAt,
        })
        await this.repository.recordIssue({
          gameId,
          workspaceFileId: file.id,
          kind: 'missing',
          severity: 'warning',
          relativePath: file.relativePath,
          message: 'File is missing; the database entity was quarantined from deletion',
          details: { entityType: file.entityType, entityId: file.entityId },
        })
      }
    }
    result.exported += await this.drainOutbox(gameId)
    await this.repository.markScanned(gameId, this.now().toISOString())
    return result
  }

  async drainOutbox(gameId: string): Promise<number> {
    const active = this.drainLocks.get(gameId)
    if (active) return active
    const run = this.drainOutboxUnlocked(gameId).finally(() => this.drainLocks.delete(gameId))
    this.drainLocks.set(gameId, run)
    return run
  }

  private async drainOutboxUnlocked(gameId: string): Promise<number> {
    const { root } = await this.workspaceRoot(gameId)
    let exported = 0
    // pendingOutbox claims bounded batches for cross-process safety. Keep
    // draining until the due queue is empty so exportAll really exports all.
    while (true) {
      const pending = await this.repository.pendingOutbox(gameId)
      if (pending.length === 0) break
      const entities = new Map(
        (await this.repository.listEntities(gameId)).map((entity) => [`${entity.type}:${entity.id}`, entity]),
      )
      const registryByEntity = new Map(
        (await this.repository.listFiles(gameId)).map((file) => [`${file.entityType}:${file.entityId}`, file]),
      )
      const registryByPath = new Map(
        [...registryByEntity.values()].map((file) => [normalizeRelativePath(file.relativePath), file]),
      )
      for (const item of pending) {
        try {
          if (!ENTITY_TYPES.has(item.entityType as WorkspaceEntityType)) {
            throw new Error(`Unsupported workspace entity type: ${item.entityType}`)
          }
          const type = item.entityType as WorkspaceEntityType
          const entityKey = `${type}:${item.entityId}`
          if (item.operation === 'quarantine') {
            const registry = registryByEntity.get(entityKey)
            if (registry?.status === 'quarantined') {
              await this.repository.completeOutbox(item.id)
              continue
            }
            const stamp = this.now().toISOString().replace(/[:.]/g, '-')
            const sourceName = registry ? posix.basename(registry.relativePath) : `${type}-${item.entityId}.md`
            const quarantinePath = `Quarantine/Deleted/${stamp}-${item.entityId.slice(0, 8)}-${sourceName}`
            let disk
            if (registry && (await fileExists(root, registry.relativePath))) {
              await moveWorkspaceFile(root, registry.relativePath, quarantinePath)
              disk = await readWorkspaceFile(root, quarantinePath)
            } else {
              let snapshot = registry?.baseContent
              if (!snapshot) {
                let payload: unknown = {}
                try {
                  payload = JSON.parse(item.payloadJson || '{}')
                } catch {
                  payload = { raw: item.payloadJson }
                }
                snapshot = `---\nmarcat-type: ${type}\nmarcat-id: ${item.entityId}\nmarcat-deleted-at: ${this.now().toISOString()}\n---\n\n# Deleted ${type}\n\nPreserved database snapshot:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
              }
              disk = await atomicWriteWorkspaceFile(root, quarantinePath, snapshot)
            }
            const quarantined = await this.repository.upsertFile({
              id: registry?.id,
              gameId,
              entityType: type,
              entityId: item.entityId,
              relativePath: quarantinePath,
              contentHash: disk.hash,
              baseHash: disk.hash,
              baseContent: disk.content,
              revision: (registry?.revision ?? 0) + 1,
              status: 'quarantined',
              mtimeMs: disk.mtimeMs,
              size: disk.size,
            })
            registryByEntity.set(entityKey, quarantined)
            registryByPath.set(normalizeRelativePath(quarantinePath), quarantined)
            await this.repository.completeOutbox(item.id)
            exported += 1
            continue
          }
          const entity = entities.get(entityKey)
          if (!entity) {
            await this.repository.completeOutbox(item.id)
            continue
          }
          const registry = registryByEntity.get(entityKey)
          const relativePath =
            registry && registry.status !== 'quarantined'
              ? registry.relativePath
              : await this.availableExportPath(root, defaultWorkspacePath(entity), entity.id, registryByPath)
          let restoreMissing = false
          try {
            restoreMissing = JSON.parse(item.payloadJson || '{}').restoreMissing === true
          } catch {
            restoreMissing = false
          }
          if (registry?.status === 'missing' && !(await fileExists(root, relativePath)) && !restoreMissing) {
            await this.repository.recordIssue({
              gameId,
              workspaceFileId: registry.id,
              kind: 'missing',
              severity: 'warning',
              relativePath,
              message: 'File remains missing; MarCat changes are stored safely until restore or quarantine is chosen',
              details: { entityType: type, entityId: item.entityId, databaseChanged: true },
            })
            await this.repository.completeOutbox(item.id)
            continue
          }
          let existingContent: string | undefined
          let currentHash: string | undefined
          let existingDisk: Awaited<ReturnType<typeof readWorkspaceFile>> | undefined
          if (await fileExists(root, relativePath)) {
            existingDisk = await readWorkspaceFile(root, relativePath)
            existingContent = existingDisk.content
            currentHash = existingDisk.hash
          }
          const currentRevision = registry?.revision ?? 1
          let revision = currentRevision
          let desired = renderWorkspaceEntity(entity, { existingContent, revision })
          let desiredHash = hashContent(desired)
          if (currentHash !== desiredHash && registry) {
            revision += 1
            desired = renderWorkspaceEntity(entity, { existingContent, revision })
            desiredHash = hashContent(desired)
          }
          if (registry && currentHash && currentHash !== registry.baseHash && desiredHash !== currentHash) {
            const conflictName = `${posix.basename(relativePath, '.md')}--marcat-${this.now().getTime()}-${randomUUID().slice(0, 6)}.md`
            const conflictPath = `Conflicts/${conflictName}`
            await atomicWriteWorkspaceFile(root, conflictPath, desired)
            await this.repository.patchFile(registry.id, { status: 'conflict', contentHash: currentHash })
            await this.repository.recordIssue({
              gameId,
              workspaceFileId: registry.id,
              kind: 'conflict',
              relativePath,
              message: `Concurrent edits preserved; MarCat version written to ${conflictPath}`,
              details: { conflictPath, baseHash: registry.baseHash, fileHash: currentHash, desiredHash },
            })
            await this.repository.completeOutbox(item.id)
            continue
          }
          const wroteFile = !existingDisk || currentHash !== desiredHash
          const disk =
            existingDisk && currentHash === desiredHash
              ? existingDisk
              : await atomicWriteWorkspaceFile(root, relativePath, desired)
          const synced = await this.repository.upsertFile({
            id: registry?.id,
            gameId,
            entityType: type,
            entityId: item.entityId,
            relativePath,
            contentHash: disk.hash,
            baseHash: disk.hash,
            baseContent: disk.content,
            revision,
            status: 'synced',
            mtimeMs: disk.mtimeMs,
            size: disk.size,
          })
          registryByEntity.set(entityKey, synced)
          registryByPath.set(normalizeRelativePath(relativePath), synced)
          await this.repository.resolveIssues(gameId, relativePath)
          await this.repository.completeOutbox(item.id)
          if (wroteFile) exported += 1
        } catch (error) {
          await this.repository.failOutbox(
            item.id,
            error instanceof Error ? error.message : String(error),
            item.attempts,
          )
          this.reportError(error)
        }
      }
    }
    return exported
  }

  async watch(gameId: string): Promise<WorkspaceWatchHandle> {
    const { root } = await this.workspaceRoot(gameId)
    let timer: NodeJS.Timeout | undefined
    let closed = false
    const schedule = () => {
      if (closed) return
      this.dirtyGames.add(gameId)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void this.reconcile(gameId).catch(this.reportError)
      }, this.watcherDebounceMs)
    }
    const watcher: FSWatcher = chokidar.watch(root, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
      ignored: (path) => {
        const rel = normalizeRelativePath(relative(root, resolve(path)))
        return (
          rel.split('/').some((part) => part.startsWith('.')) ||
          rel.startsWith('Conflicts/') ||
          rel.startsWith('Quarantine/')
        )
      },
    })
    watcher
      .on('add', schedule)
      .on('change', schedule)
      .on('unlink', schedule)
      .on('addDir', schedule)
      .on('unlinkDir', schedule)
    watcher.on('error', this.reportError)
    return {
      close: async () => {
        closed = true
        if (timer) clearTimeout(timer)
        await watcher.close()
      },
    }
  }
}
