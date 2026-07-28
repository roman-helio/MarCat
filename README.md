# MarCat

**Local-first marketing workspace for indie-game teams.** MarCat keeps planning, Steam analytics,
creator outreach, campaign history, and an AI copilot in one Windows desktop app without turning the
studio's operating data into somebody else's SaaS database.

## What MarCat covers

- Tasks, dependencies, recurring work, campaign deadlines, and an activity journal
- Steam wishlist imports, period comparisons, UTM links, and marketing-event attribution
- Festival catalogue and project-specific participation tracking
- Creator CRM, outreach history, public contact details, and campaign preparation
- Source connectors and a shared typed API for the desktop app and bundled MCP server
- Embedded AI assistance with inspectable, review-before-apply changesets

MarCat is bilingual (English/Russian). SQLite is the durable local application index. Projects can
optionally synchronize human-authored data to ordinary Markdown files owned by the user, so the same
workspace remains usable from Obsidian, VS Code, Git, or any text editor.

The Electron UI and bundled MCP server share the same typed domain API and workspace coordinator.

## Stack

- Electron 43, React 18, Vite 7, Tailwind CSS 4
- libSQL/SQLite in WAL mode, Drizzle ORM, tRPC over Electron IPC
- TanStack Query, ECharts, React Big Calendar, dnd-kit, TipTap
- npm workspaces with shared `packages/db` and `packages/core`

```text
apps/desktop/       Electron main/preload + React renderer
packages/db/        schema, migrations, durability and backup primitives
packages/core/      domain routers shared by desktop and MCP
packages/mcp-server external stdio MCP server for the same local plan
scripts/            smoke, migration and concurrency checks
```

## Open Markdown workspaces

Markdown synchronization is disabled by default, so existing SQLite-only projects keep their current
behaviour and performance. To enable it, open **Settings → Open project workspace**, choose the local
project/vault folder, and click **Enable & export**. MarCat creates a visible `MarCat` folder inside it;
changing the selected project folder leaves the old files untouched and exports a fresh copy to the new
location.

```text
MarCat/
  Project.md                 project card and stable agent notes
  Tasks/                     task status, dates, dependencies, tags and checklists
  Insights/                  durable findings and hypotheses
  Activity/ and Posts/       journal entries and published content
  Campaigns/                 tags, campaigns and target dates
  Views/*.base               optional Obsidian Bases tables, created once
  Conflicts/                 MarCat side of concurrent-edit conflicts
  Quarantine/Deleted/        recoverable snapshots of explicitly deleted/archived records
```

Files can be read and edited in Obsidian, VS Code, any Markdown editor, or Git. YAML properties prefixed
with `marcat-` form the synchronization contract; arbitrary YAML properties and extra `##` sections in
structured project/task documents are preserved. A new supported document without `marcat-id` receives an ID on the next rescan. Invalid
YAML, duplicate IDs and unsupported property values are isolated as issues instead of being imported.
The four generated `.base` files follow Obsidian's current Bases YAML format and are never overwritten
after creation, so view customizations remain user-owned.

Synchronization is bidirectional and uses atomic file replacement plus a durable SQLite outbox. If the
same record changes in MarCat and on disk, neither side wins silently: the original file stays in place,
MarCat writes its version under `Conflicts/`, and Settings shows the issue. Removing a file never deletes
the SQLite record automatically. Settings lets the user restore the file or archive its last synchronized
snapshot under `Quarantine/Deleted/`. Editing that database record later intentionally creates a new live
file while retaining the archived snapshot.

For recovery, close MarCat before manually replacing the database and use a verified snapshot from the
adjacent `backups` directory. Workspace Markdown is independently recoverable through the filesystem or
Git; after restoring either side, use **Rescan** and resolve any reported conflict rather than deleting
the conflict/quarantine folders blindly.

MCP clients use the same watcher, reconciliation rules and durable outbox as the desktop app. In addition
to the existing domain tools, agents can call `get_workspace_status`, `rescan_workspace`,
`list_workspace_issues`, and `get_workspace_paths`. External deletion still requires an explicit decision
in the desktop Settings UI.

For task lookup, use `search_tasks`: filtering happens in SQLite and returns a compact paginated catalogue.
Call `get_task` only for the selected full record. `list_tasks` remains backward compatible, while calls that
provide `search`, status/priority filters, pagination or `detail` use the same compact search path.

## Requirements

- Node.js 22 or newer
- npm
- Windows for the packaged desktop build
- Optional: the `claude` CLI for the embedded AI den

## Development

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm run check         # format, lint, types, tests and production build
npm test              # domain smoke + migrations + MCP + concurrent writers
npm run test:workspace # Markdown round-trip, safety and concurrency regressions
npm run build         # production build of all workspaces
npm run db:generate   # generate a migration after changing the schema
npm run package       # NSIS installer + portable Windows executable
```

Create local `.env` files only when a development tool explicitly needs them. API keys, service-account
files, local databases, generated MCP configs, test captures, and packaged builds are intentionally
excluded by `.gitignore`; keep secrets in MarCat's encrypted connector storage or the operating-system
credential store.

The database lives in `%APPDATA%/MarCat/marcat.db`. MarCat creates verified online snapshots in the
adjacent `backups` directory, including rotating launch snapshots and pre-migration snapshots.
Settings can create, inspect and stage a verified restore.

## Security and reliability

- Renderer isolation, Chromium sandbox, restrictive CSP, guarded navigation and narrow preload IPC
- Foreign keys, unique relationship invariants and atomic per-game task sequences
- Transactional bulk imports, date shifts, activity/status updates and AI changesets
- External MCP writes detected through SQLite `data_version`
- Contained workspace paths, symlink/traversal checks, collision-safe filenames and atomic file writes
- Durable, cross-process workspace outbox with conflict and missing-file quarantine semantics
- AI requests have cancellation, timeout and output limits; interrupted runs recover on restart
- Route-level code splitting and script-subset WOFF2 fonts keep the initial renderer small

`npm audit --omit=dev` is enforced in CI. The four remaining moderate audit notices are confined to
Drizzle Kit's development-only migration loader and are not packaged with the application.

## Packaging

`npm run package` writes versioned installer and portable artifacts plus `CHANGELOG.md` to
`apps/desktop/release`. The repository
does not contain a Windows code-signing certificate, so local artifacts remain unsigned until a
certificate is supplied through the release environment.
