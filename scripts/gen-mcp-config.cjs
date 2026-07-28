/* Emit a ready-to-use .mcp.json + AGENTS.md for wiring MarCat into an external agent. */
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const serverPath = path.join(repo, 'packages', 'mcp-server', 'dist', 'index.cjs')
const appdata = process.env.APPDATA || process.env.HOME || ''
const userData = path.join(appdata, 'MarCat')
const defaultDbPath = path.join(userData, 'marcat.db')
const markerPath = path.join(userData, 'active-db-path.txt')
const dbPath = (() => {
  try {
    const markedPath = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : ''
    const resolvedUserData = path.resolve(userData)
    const resolvedMarkedPath = path.resolve(markedPath)
    if (markedPath && resolvedMarkedPath.startsWith(resolvedUserData) && fs.existsSync(resolvedMarkedPath)) {
      return resolvedMarkedPath
    }
  } catch {
    /* ignore invalid marker */
  }
  return defaultDbPath
})()
const outDir = path.join(repo, 'mcp')
fs.mkdirSync(outDir, { recursive: true })

const mcpJson = {
  mcpServers: {
    marcat: {
      command: 'node',
      args: [serverPath],
      env: { MARCAT_DB: dbPath },
    },
  },
}
fs.writeFileSync(path.join(outDir, '.mcp.json'), JSON.stringify(mcpJson, null, 2) + '\n')

const agents = `# MarCat — marketing plan (via MCP)

This project is wired to **MarCat**, a local marketing planner/tracker, through an MCP
server. You can read the plan and change it. SQLite (\`MARCAT_DB\`) is the fast query index. When a project
has a Markdown workspace configured, human-authored project data is also synchronized to ordinary visible
files that can be edited in Obsidian, Git or an editor; use \`get_workspace_status\` before assuming it is available.

## Workflow
1. Start with **get_project_card** when you know the project key (for example \`{ "key": "SAS" }\`).
   This is the one-call project brief: owner-maintained project context plus live MarCat state.
2. If you do not know the key, call **list_games** first to get the \`gameId\`.
   The project card reports workspace availability. Use **rescan_workspace** after external file edits and
   **list_workspace_issues** for conflicts or missing files; external deletion never silently deletes MarCat data.
3. Read the relevant domain before writing. Tools cover games/project cards, tasks/dependencies/checklists/tags,
   insights, the activity journal and wishlist analytics, wishlist points, UTM links, sources, festivals and creators/outreach.
   Find tasks with \`search_tasks\` and then load only the selected full record with \`get_task\`; avoid transferring the
   complete \`list_tasks\` catalogue for a lookup. Filtered \`list_tasks\` calls are compact and paginated as well.
   The project card includes the mandatory \`Карточка проекта\` brief plus ordinary insight titles. Call
   \`get_insight\` for the full text of other notes relevant to the request.
4. For “what should I do now?”, call \`get_next_actions\`. Use its ranked focus queue instead of freely
   summarizing \`list_tasks\`; prefer finishing important work already close to done before opening new work.
5. Before reporting that work is finished, run a reconciliation pass: call \`get_task\`, compare the actual
   result with every checklist item, then call \`complete_task\` with only the verified item UUIDs. If it
   returns \`completed=false\`, report the exact remaining items and keep the parent task open. Re-read the
   task after completion and check which dependent work was unblocked. For a recurring task,
   \`completed=true\` + \`recurring=true\` means this cycle finished successfully; the task intentionally
   returns to \`todo\` with a reset checklist and \`nextDueDate\`.
6. Prefer \`create_activity\`; \`create_event\` is only a deprecated compatibility alias for a project-level
   wishlist-chart event. Task descriptions accept Markdown; preserve paragraphs and lists.
7. Festivals: read with \`list_festivals\`; create/update with \`create_festival\`, \`update_festival\`,
   or bulk upsert with \`import_festivals\`. Use ISO dates (\`YYYY-MM-DD\`), \`endDate\` for ranges,
   \`applyDeadline\` for submission deadlines, and game-specific participation via
   \`pick_festival\` + \`set_festival_status\`.
8. Creator outreach: use \`log_touch\` for one message and \`log_touches_bulk\` for several. Give every
   touch a stable unique \`requestId\` and reuse it when retrying. Never fan out creator writes with
   \`Promise.all\`. An MCP error still contains text content, so success means \`isError !== true\`, not merely
   that \`content\` exists. Treat the returned \`pick.pipelineStatus\` as the verified post-write state.

## Concepts
- A **game** is a workspace. Its \`key\` is the shared task/DevHub prefix. Game \`platforms\` are release/store
  targets (PC Steam, web, mobile, console), not social publishing platforms. \`officialLinks\` are the canonical
  first-party website, social, community and press-kit URLs. Store targets remain in \`platforms\`; both are distinct from auto-import \`sources\`.
- An **activity** is one dated journal entry. The physical SQLite table is historically named \`events\`.
  A wishlist event is an activity with \`showOnWishlist=true\`, reserved for an actually occurred marketing beat.
  Drafts, preparation and ordinary notes stay false.
- Published content uses \`type\` (post/video/…), normalized lowercase \`platform\` (reddit/youtube/…),
  \`placement\` (subreddit, account, Steam News hub, publication/community), full \`body\`, \`url\` and known metrics.
  Example: a Reddit post containing a YouTube link is \`type=post\`, \`platform=reddit\`,
  \`placement=r/CityBuilders\`. Never guess metrics; null means unknown and 0 means a known zero.
- \`direction\` + \`channel\` are only for correspondence. A public social post is not outbound email.
  \`statusAfter\` is only an atomic festival or creator pipeline transition, never a task/project status.
- Creator touches and their pipeline transition are atomic. Reusing a touch \`requestId\` returns the original
  record instead of duplicating it, and a touch never moves an already-later creator stage backwards.
- Preserve provenance: MCP-created activities and creator picks are recorded as AI-created. Public/business
  creator contacts only; honor \`doNotContact\`.
- A **tag** is the single grouping entity. A tag with a \`targetDate\` is a **deadline**
  (countdown + at-risk alarm); moving that date shifts the dates of tagged tasks and their
  blocker chain. A plain tag is just a track label. Group a campaign's tasks under one tag.
- **Dependencies** are real edges (blocker must finish before blocked). Cycles are rejected.
  A task with an open blocker is auto-marked \`blocked\`; it returns to \`todo\` once blockers are done.
- A **recurring task** has \`recurrence: { every, unit }\`, where unit is day/week/month/year. Use it for
  routine checks and maintenance, not multi-step campaigns. Set recurrence to \`null\` with \`update_task\`
  to disable it. Completing a cycle advances to the nearest future due date and resets checklist items.
- **Definition of done** includes tracker reconciliation. Semantic completion in code, documents or an
  external service is not the end of the workflow: verify matching checklist items, close them through
  \`complete_task\`, and confirm the parent status. Never mark an item done merely to make the tracker tidy.
- A **festival** is a shared catalogue row in \`industry_events\`: \`name\`, \`startDate\`,
  optional \`endDate\`, \`applyDeadline\`, \`url\`, \`applyUrl\`, \`organizer\`, \`description\`,
  \`notes\`, \`steamEvent\`, \`steamFeature\`, \`media\`, \`offline\`, \`costUsd\`.
  \`import_festivals\` upserts by normalized \`name + startDate\`; do not write raw SQLite rows.
- A **project card** is durable common context for agents. Put stable facts, repo/docs links,
  product positioning and agent notes there instead of copying the same context into every task. It is also exposed
  as the mandatory \`Карточка проекта\` insight: fill it through \`update_project_card\` or \`update_insight\`; never
  create a duplicate, rename it or delete it.
- An **insight** is durable project knowledge: an audience finding, experiment conclusion, recurring pattern,
  or validated/rejected hypothesis. Start from \`list_insights\`/the project-card title catalogue and load only
  relevant full notes with \`get_insight\`. Use \`create_insight\` or \`update_insight\` for reusable conclusions;
  dated events and correspondence belong in the activity journal.
- A **wishlist point** distinguishes period changes (adds/deletes/gifts/net) from running \`balance\`.
  Use null for unknown values. UTM \`source\` is the traffic origin, \`medium\` the channel class,
  \`campaign\` the initiative, and \`content\` the creative/placement variant.
- Source tools never expose or accept API keys. Paid sync/budget confirmation remains owner-controlled in Settings.
- Changes apply **directly** to the live plan — there is no separate approval step here.
`
fs.writeFileSync(path.join(outDir, 'AGENTS.md'), agents)

console.log('Wrote:')
console.log(' ', path.join(outDir, '.mcp.json'))
console.log(' ', path.join(outDir, 'AGENTS.md'))
console.log('\nCopy .mcp.json into your game project root (Claude Code picks it up), or merge its')
console.log('"mcpServers" entry into an existing one. DB path used:', dbPath)
