import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Resolve a user/file supplied path and prove it remains below the workspace root. */
export function resolveContained(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error('Workspace path must be a non-empty relative path')
  }
  const normalized = normalizeRelativePath(relativePath)
  const target = resolve(root, normalized)
  const rel = relative(resolve(root), target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Workspace path escapes its root: ${relativePath}`)
  }
  return target
}

export async function ensureSafeWorkspaceRoot(root: string): Promise<string> {
  const absolute = resolve(root)
  await mkdir(absolute, { recursive: true })
  const resolvedRoot = await realpath(absolute)
  const info = await lstat(resolvedRoot)
  if (!info.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`)
  return resolvedRoot
}

async function assertNoSymlinkParents(root: string, target: string): Promise<void> {
  const safeRoot = await realpath(root)
  const rel = relative(safeRoot, target)
  resolveContained(safeRoot, rel || '.')
  let current = safeRoot
  const parts = rel.split(sep).filter(Boolean)
  // The final component may be a file that does not exist yet; only inspect parents.
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`Workspace path contains a symlink: ${current}`)
      if (!info.isDirectory()) throw new Error(`Workspace path parent is not a directory: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
}

/** Recursively list visible Markdown files without following symlinks. */
export async function listVisibleMarkdownFiles(root: string): Promise<string[]> {
  const safeRoot = await ensureSafeWorkspaceRoot(root)
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const absolute = resolve(directory, entry.name)
      const rel = relative(safeRoot, absolute)
      resolveContained(safeRoot, rel)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        result.push(normalizeRelativePath(rel))
      }
    }
  }
  await visit(safeRoot)
  return result.sort((a, b) => a.localeCompare(b))
}

export interface WorkspaceDiskFile {
  content: string
  hash: string
  mtimeMs: number
  size: number
}

export async function readWorkspaceFile(root: string, relativePath: string): Promise<WorkspaceDiskFile> {
  const absolute = resolveContained(root, relativePath)
  await assertNoSymlinkParents(root, absolute)
  const info = await lstat(absolute)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Workspace document is not a regular file')
  const content = await readFile(absolute, 'utf8')
  return { content, hash: hashContent(content), mtimeMs: Math.trunc(info.mtimeMs), size: info.size }
}

const pathLocks = new Map<string, Promise<void>>()

async function withPathLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock
  })
  const tail = previous.then(() => current)
  pathLocks.set(path, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (pathLocks.get(path) === tail) pathLocks.delete(path)
  }
}

async function retryRename(from: string, to: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      await new Promise((resolveWait) => setTimeout(resolveWait, 15 * 2 ** attempt))
    }
  }
  throw lastError
}

/** Same-directory temp + fsync + rename keeps readers from observing partial files. */
export async function atomicWriteWorkspaceFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<WorkspaceDiskFile> {
  const absolute = resolveContained(root, relativePath)
  return withPathLock(absolute, async () => {
    await assertNoSymlinkParents(root, absolute)
    await mkdir(dirname(absolute), { recursive: true })
    // Refuse a parent swapped to a symlink while the directory tree was being created.
    await assertNoSymlinkParents(root, absolute)
    const temp = `${absolute}.marcat-${process.pid}-${randomUUID()}.tmp`
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // A failed temp file is intentionally left beside the target for recovery.
    await retryRename(temp, absolute)
    const info = await stat(absolute)
    return {
      content,
      hash: hashContent(content),
      mtimeMs: Math.trunc(info.mtimeMs),
      size: info.size,
    }
  })
}

/**
 * Create a managed companion file exactly once. `wx` is deliberate: after the
 * first creation the file belongs to the user, so even a configure/export race
 * must never replace edits made in Obsidian.
 */
export async function createWorkspaceFileIfMissing(
  root: string,
  relativePath: string,
  content: string,
): Promise<boolean> {
  const absolute = resolveContained(root, relativePath)
  await assertNoSymlinkParents(root, absolute)
  await mkdir(dirname(absolute), { recursive: true })
  await assertNoSymlinkParents(root, absolute)
  let handle
  try {
    handle = await open(absolute, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

export async function fileExists(root: string, relativePath: string): Promise<boolean> {
  try {
    await access(resolveContained(root, relativePath), constants.F_OK)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Move a regular workspace file to another contained path without overwriting. */
export async function moveWorkspaceFile(root: string, fromRelativePath: string, toRelativePath: string): Promise<void> {
  const from = resolveContained(root, fromRelativePath)
  const to = resolveContained(root, toRelativePath)
  await assertNoSymlinkParents(root, from)
  await assertNoSymlinkParents(root, to)
  const source = await lstat(from)
  if (!source.isFile() || source.isSymbolicLink()) throw new Error('Workspace document is not a regular file')
  await mkdir(dirname(to), { recursive: true })
  await assertNoSymlinkParents(root, to)
  try {
    await access(to, constants.F_OK)
    throw new Error(`Quarantine destination already exists: ${toRelativePath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await retryRename(from, to)
}
