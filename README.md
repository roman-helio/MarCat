# MarCat

**Local-first marketing workspace for indie-game teams.** MarCat keeps planning, Steam analytics,
creator outreach, campaign history, and an AI copilot in one Windows desktop app without turning the
studio's operating data into somebody else's SaaS database.

## What MarCat covers

- Tasks, dependencies, recurring work, campaign deadlines, and an activity journal
- Steam wishlist imports, period comparisons, UTM links, and marketing-event attribution
- Festival catalogue and project-specific participation tracking
- Creator Contacts, outreach history, public contact details, and campaign preparation
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
Creator, activity, chart-event and festival catalogues use the same bounded page envelope:
`totalCount`, `offset`, `limit`, `nextOffset`, and compact `items`. Full bodies, notes and evidence are loaded
only for selected records through `get_creator`, `get_activity` or `get_festival`.

Local agents that also have filesystem access can call `get_readonly_database_access` for large joins and
aggregations. The returned SQLite URI must be opened with `mode=ro` plus `PRAGMA query_only=ON`; do not use
`immutable=1`, because committed WAL rows must remain visible. Direct writes are unsupported and must go
through MarCat tools so domain validation, idempotency and Markdown synchronization still run.

## Multi-platform creator discovery

Inside a game, **Influencers → Discovery** runs one durable, resumable search without using an LLM for
matching. A reusable profile contains competitor/reference games (with aliases and search terms) or topic
facets such as history periods, required phrases, exclusions, and languages. One click automatically uses
every configured source:

- YouTube Data API for channel discovery and recent-video evidence
- one ScrapeCreators connector for Instagram profiles, TikTok videos, and X profiles/posts

The deterministic scorer rewards distinct reference coverage, matching public content, recency, reach,
and available contact evidence. Public business emails are collected from bios, descriptions, posts, and
the first relevant page on a linked public website. Private/local network addresses are rejected, page
reads are bounded, and login/CAPTCHA-gated contacts are never bypassed.

Each run is an immutable staging artifact with a snapshotted profile, platforms, progress, counters, post
or video evidence, contacts, and candidate decisions. Results never enter project Contacts automatically.
A user or MCP agent filters by reference count, fit, and public-email availability, previews the exact
create-versus-enrich count, and confirms one bulk action. Existing cards retain manual fields, outreach
status, do-not-contact flags, and correspondence. Stable platform identities, public email/website
identities, request hashes, and database constraints deduplicate same-platform accounts, cross-platform
cards, contacts, evidence, and project picks.

The first visit asks only for a search profile and at least one source. YouTube is free to call within
Google's daily project quota. ScrapeCreators uses credits after any provider trial and supplies all three
social networks with one key. MarCat displays the exact local YouTube quota ledger and the latest credit
balance returned by ScrapeCreators; it does not spend another credit merely to poll the balance. A default
run can spend at most ten times its per-network search-request setting, and an optional daily provider
budget remains available in **Settings → Connectors**.

Successful paid responses are cached for 30 days. Restarting, resuming, or forcing an identical run reuses
that durable cache instead of silently spending the same credits again. Every run also remains queryable
in SQLite and, when project files are enabled, is mirrored to
`MarCat/Discovery/Creators/<run-id>.json`.

External MCP agents can create profiles, queue/control runs, inspect historical results, preview compact
batch counts, and explicitly add or hide up to 1,000 filtered creators per call without loading thousands
of records into model context. The desktop app resolves the connected sources when it executes an
MCP-queued run; neither MCP nor the embedded agent can read or set protected keys.

See the official [YouTube Data API setup guide](https://developers.google.com/youtube/v3/getting-started),
[YouTube quota guide](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits), and
[ScrapeCreators API documentation](https://docs.scrapecreators.com/).

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
