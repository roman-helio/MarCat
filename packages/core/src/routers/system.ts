import fs from 'node:fs'
import os from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createVerifiedBackup, verifyDatabaseFile } from '@marcat/db'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'

const backupsDir = (dbPath: string) => join(dirname(dbPath), 'backups')

/** Does either supported agent CLI register a DevHub MCP server? */
function detectDevhub(): { connected: boolean; serverName: string | null; client: 'claude' | 'codex' | null } {
  try {
    const file = join(os.homedir(), '.claude.json')
    if (fs.existsSync(file)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
        const scan = (servers: unknown): string | null => {
          if (!servers || typeof servers !== 'object') return null
          for (const [k, v] of Object.entries(servers as Record<string, unknown>)) {
            if (/devhub/i.test(k) || /devhub/i.test(JSON.stringify(v ?? ''))) return k
          }
          return null
        }
        const top = scan(cfg.mcpServers)
        if (top) return { connected: true, serverName: top, client: 'claude' }
        const projects = (cfg.projects ?? {}) as Record<string, { mcpServers?: unknown }>
        for (const project of Object.values(projects)) {
          const hit = scan(project?.mcpServers)
          if (hit) return { connected: true, serverName: hit, client: 'claude' }
        }
      } catch {
        // A malformed Claude config must not hide a valid Codex integration.
      }
    }

    const codexConfig = join(os.homedir(), '.codex', 'config.toml')
    if (fs.existsSync(codexConfig)) {
      const toml = fs.readFileSync(codexConfig, 'utf8')
      const sections = [...toml.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([^\]]+))\]\s*$/gim)]
      for (let index = 0; index < sections.length; index += 1) {
        const match = sections[index]
        const name = (match[1] ?? match[2] ?? '').trim()
        const start = (match.index ?? 0) + match[0].length
        const end = sections[index + 1]?.index ?? toml.length
        if (/devhub/i.test(name) || /devhub/i.test(toml.slice(start, end))) {
          return { connected: true, serverName: name || 'devhub', client: 'codex' }
        }
      }
    }
    return { connected: false, serverName: null, client: null }
  } catch {
    return { connected: false, serverName: null, client: null }
  }
}

export const systemRouter = router({
  /** Installed application version and the canonical all-version changelog. */
  releaseInfo: publicProcedure.query(({ ctx }) => {
    const changelogPath = ctx.appPaths?.changelogPath
    let changelog = ''
    if (changelogPath && fs.existsSync(changelogPath)) {
      changelog = fs.readFileSync(changelogPath, 'utf8')
    }
    return { version: ctx.appPaths?.appVersion ?? '0.0.0', changelog }
  }),

  /** Paths for wiring the external MCP server (shown in Settings → MCP help). */
  mcpInfo: publicProcedure.query(({ ctx }) => ({
    dbPath: ctx.appPaths?.dbPath ?? '',
    serverPath: ctx.appPaths?.mcpServerPath ?? '',
  })),

  devhubStatus: publicProcedure.query(() => detectDevhub()),

  /** Changes when another SQLite connection (for example MCP) commits. */
  dataVersion: publicProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.get<{ data_version: number }>(sql.raw('PRAGMA data_version'))
    return Number(row?.data_version ?? 0)
  }),

  /** Write a timestamped, consistent copy of the database into the backups folder. */
  backup: publicProcedure.mutation(async ({ ctx }) => {
    const dbPath = ctx.appPaths?.dbPath
    if (!dbPath || !fs.existsSync(dbPath)) throw new Error('Database path unavailable')
    const dir = backupsDir(dbPath)
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(dir, `marcat-${stamp}.db`)
    await createVerifiedBackup(ctx.db, dest)
    return { path: dest, dir }
  }),

  listBackups: publicProcedure.query(({ ctx }) => {
    const dbPath = ctx.appPaths?.dbPath
    if (!dbPath) return { dir: '', backups: [] as { name: string; path: string; sizeKb: number; at: string }[] }
    const dir = backupsDir(dbPath)
    if (!fs.existsSync(dir)) return { dir, backups: [] }
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const p = join(dir, f)
        const st = fs.statSync(p)
        return { name: f, path: p, sizeKb: Math.round(st.size / 1024), at: st.mtime.toISOString() }
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1))
    return { dir, backups }
  }),

  /** Stage a backup to be swapped in on next launch (safe — the DB is open now). */
  restoreBackup: publicProcedure.input(z.object({ path: z.string() })).mutation(async ({ ctx, input }) => {
    const dbPath = ctx.appPaths?.dbPath
    if (!dbPath) throw new Error('Database path unavailable')
    const dir = backupsDir(dbPath)
    // Only allow restoring from our own backups folder.
    if (dirname(input.path) !== dir || !input.path.endsWith('.db') || !fs.existsSync(input.path)) {
      throw new Error('Unknown backup file')
    }
    await verifyDatabaseFile(input.path)
    const restore = join(dirname(dbPath), 'marcat.restore')
    const partial = `${restore}.partial`
    fs.copyFileSync(input.path, partial)
    fs.rmSync(restore, { force: true })
    fs.renameSync(partial, restore)
    return { ok: true, name: basename(input.path) }
  }),
})
