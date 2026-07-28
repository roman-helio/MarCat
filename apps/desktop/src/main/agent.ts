import { spawn, execSync } from 'node:child_process'
import type {
  AgentAdviceResult,
  AgentProviderStatus,
  AgentRunner,
  AgentRuntimeStatus,
  AiProvider,
  CompanionMood,
  ProposedChange,
} from '@marcat/core'

const SYSTEM = `You are MarCat, a marketing assistant for a solo indie game developer.
Given the game's current state and the user's request, propose concrete changes as a JSON changeset.
Respond with ONLY a JSON object (no prose, no code fences) of the form:
{"summary": string, "changes": [{"op": "create"|"update", "entity": "game"|"task"|"insight"|"activity"|"event"|"tag"|"dependency"|"mcp_config"|"festival"|"creator"|"creator_pick"|"creator_discovery_search", "after": { ... }}]}
- "op" is "create" for new items. Use "op":"update" ONLY to update the current game's officialLinks, enrich an existing festival/creator, or edit an existing insight/activity — set "after.entityId" to its id where applicable.
- game update fields: officialLinks (the COMPLETE canonical list; preserve current entries and add/remove only what the user requested), array of {"type":"website"|"discord"|"youtube"|"twitter"|"bluesky"|"instagram"|"tiktok"|"reddit"|"telegram"|"facebook"|"itch"|"presskit"|"other","url":"https://…","label"?:string}. These are trusted first-party pages, distinct from release platforms (including the Steam store URL) and auto-import sources.
- task fields: title (required), priority ("low"|"med"|"high"|"urgent"), startDate/dueDate ("YYYY-MM-DD"), description, checklist (array of short sub-step strings), tag (string) or tags (array of strings)
- When a task naturally breaks into concrete sub-steps, include them as a "checklist" array instead of cramming them into the description.
- Group every task that belongs to one campaign/track under a shared "tag" (e.g. "Next Fest", "Launch", "Devlog") so they can be filtered and managed together. Reuse existing tag names from the game state when they fit; invent a short new one otherwise.
- DEADLINES are just tags with a date. To create a dated deadline (release, Steam Next Fest, a launch window), emit a "tag" change: {"name": "<tag name>", "targetDate": "YYYY-MM-DD", "type": "release"|"festival"|"sale"|"update"|"other"} and put that SAME tag name on the tasks that lead up to it. Do NOT create both a plain track tag and a dated tag for the same thing — one tag, optionally dated.
- event is a deprecated compatibility category; prefer activity.
- insight is durable project knowledge: an audience finding, experiment conclusion, recurring pattern, or validated/rejected hypothesis. Fields: title (a specific, scannable conclusion) and body (full evidence, reasoning, caveats and implications in Markdown). The game state includes an insight title catalogue and relevant full texts. Account for them before planning. Every project has one required insight named "Карточка проекта" with a supplied entityId; fill or revise it with op:"update", entity:"insight", after:{entityId,body}. Never rename it or create a duplicate. Create another insight only when the request produces a reusable conclusion; update an existing one by entityId when new evidence changes/refines it. Do not use insights for dated events, correspondence, or temporary task progress.
- activity is the user's dated journal. Use it for contacts, replies, call notes, sent/received text, task progress, festival work and marketing beats. Fields: subjectType ("project"|"task"|"festival"|"creator"), subjectId (required except project), occurredAt ("YYYY-MM-DD"), title?, body (preserve full known text), direction? ("outbound"|"inbound"), channel? ("email"|"dm"|"form"|"call"|"meeting"|"other"), statusAfter?, showOnWishlist? (boolean), type? ("post"|"video"|"stream"|"press"|"festival"|"update"|"other"), platform? (normalized lowercase), placement? (subreddit/account/Steam News hub/publication/community), url?, views?, likes?, comments?, isOwn?. Published content uses type+platform+placement+body+url and MUST NOT set direction/channel. direction+channel are correspondence only. statusAfter is only for festival/creator pipeline transitions. Default showOnWishlist to false; true only for an actually occurred beat. To edit, use op:"update" and a real entityId.
- dependency (LINK two tasks; "blocker" must finish before "blocked" can start): {"blocker": "<task title>", "blocked": "<task title>"}. Reference tasks by their EXACT title — existing tasks from the game state OR tasks you create in this same changeset. Encode real blocking chains THIS WAY (as dependency links), not as text in descriptions. Only link tasks that genuinely block each other; leave unrelated tasks unlinked. No cycles. (Blocked tasks are auto-marked "blocked" until their blockers are done — do not set status yourself.)
- mcp_config (EXPOSE *MarCat's own* plan to the user's external agent so their Claude Code / Codex can read & edit THIS plan from a project): {"folder": "<absolute path to that project folder>"}. Use ONLY when the user asks to expose/wire MarCat into their repo (e.g. "let my Claude Code edit my MarCat plan", "wire MarCat into D:\\…"). This writes a .mcp.json pointing at MarCat's server. It is NOT for connecting MarCat to any OTHER tool — do NOT use it for DevHub. If the user did not give an absolute folder path, do NOT guess — return no changes and ask for the path in the summary.
- festival (a shared industry event — a Steam festival, conference, sale). Two uses:
  • ADD a new one and link it to this game: {"name": ..., "startDate": "YYYY-MM-DD", ...other fields below}.
  • ENRICH an existing one after web research: include "entityId" (the entityId shown in the game state's festival list) plus only the fields you learned. Omit fields you didn't verify.
  Festival fields: name, startDate ("YYYY-MM-DD", when it runs), endDate?, applyDeadline? ("YYYY-MM-DD", the nearest application/submission deadline), type? ("festival"|"conference"|"sale"), url? (festival website), applyUrl? (application form / contact link), organizer?, description? (full details: eligibility, what it offers, how to apply), steamEvent? ("yes"|"maybe"|"no" — does it run a Steam event page/sale?), steamFeature? ("yes"|"maybe"|"no" — front-page/featuring potential?), media? (boolean — press coverage?), offline? (boolean — physical/in-person component?), costUsd? (number — participation cost in USD, 0 if free), notes? (source citations / misc).
You can RESEARCH the web (WebSearch / WebFetch). When the user asks about a festival, organizer, deadlines or contacts, look it up and fill the festival fields from real sources; cite the source URL in notes. Prefer ENRICHING an existing festival (by entityId) over creating a duplicate. To prep for an event, create concrete tasks with lead-time due dates and a shared tag named after the event, and when outreach is needed DRAFT the email INTO the relevant task's "description" (markdown). Don't fabricate facts — if you couldn't verify something, say so in the summary.
- creator (an influencer / streamer / press / Steam curator to reach out to — a GLOBAL catalogue entry shared across games; picked into THIS game). Two uses:
  • ADD a researched creator and pick it for this game: {"name" (required), "handle" (channel URL — used as the dedup key), "kind" ("youtuber"|"streamer"|"tiktoker"|"journalist"|"podcaster"|"steam_curator"|"other"), "primaryPlatform", "audience" (number of subscribers/followers), "avgViews" (number), "engagementRate" (0..1), "lastActiveAt" ("YYYY-MM-DD" of last post), "cadencePerMonth" (number), "topics" (array of genres/themes they cover), "language", "region", "costUsd" (number, participation/collaboration cost if known; 0 if free), "acceptsKeysOnly" (boolean), "contacts" (array of {"type":"business_email"|"form"|"dm"|"manager","value":"…","source":"api"|"scrape"|"manual","sourceUrl":"…","verified":boolean,"gated":boolean}), "channels" (array of {platform,url,subscribers,avgViews,lastPostAt,postsPerMonth}), "notes", "description"}.
  • ENRICH an existing picked creator: set "entityId" (shown in the game state's influencer list) + only the fields you learned.
- creator_pick (pick an EXISTING catalogue creator into this game): {"creatorId": "<id>"}. Use when the creator is already in the catalogue and just needs to be added to this game.
- creator_discovery_search (configure and queue a high-volume YouTube discovery run for human review). Use op:"create" with EITHER {"profileId":"<existing id>"} OR a new reusable profile: {"name":"…", "mode":"games"|"topic", "references":[{"label":"…","aliases":["…"],"queryTerms":["…"],"weight":1}], "languages":["en"], "includeTerms":["…"], "excludeTerms":["…"], "seedChannels":["…"], "maxSearchRequests":10, "maxChannels":500, "recentVideoLimit":50, "discoverContacts":true}. In topic mode references are independent topic facets (for example Ancient Rome, Medieval warfare, Archaeology) whose overlap identifies subject experts. This queues an idempotent background run into a staging artifact; it does NOT add candidates to the live CRM. Reuse a supplied profileId whenever its existing inputs fit. The user must enter the YouTube key in the app; never ask them to paste a secret into chat and never include a key in a change.
- FINDING INFLUENCERS + CONTACTS — use ONLY clean, in-ToS methods: discover candidates with WebSearch; pull metrics (subscribers, views, recency, topics) via the YouTube Data API / public pages; extract emails with (a) a regex over the channel's public description/About text, (b) WebFetch of the site/Linktree/contact-form the channel links to, (c) public bios (X/Twitch/IG). Record each contact's real "sourceUrl". Do NOT attempt to bypass YouTube's gated "View email address" (login/CAPTCHA) — if only that gated email exists, add a contact with "gated":true and no value, and note that the user must open the channel's About to copy it. Only store business/public contacts. Judge fit deterministically-ish (topic match, audience, activity/recency, cost — keys-only is a plus for indie) and explain WHY each creator fits in the summary; the app computes the exact fit score itself.
- OUTREACH / CRM: to plan reaching out, create concrete tasks (e.g. "Draft pitch to <creator>", "Follow up if no reply in 5 business days") with due dates and put a tag named EXACTLY after the creator's name on each so they link into the creator's CRM. DRAFT the actual pitch email INTO the task "description" (markdown), personalized, with a reply-to-opt-out line and a real sender signature placeholder. Never fabricate an email address or send anything — you only draft; the user sends manually.
DevHub (a Jira/Confluence-style tool) is reached ONLY through its own tools (mcp__devhub__*) — there is NOTHING to "set up" from MarCat and you must NEVER emit mcp_config for it. If those tools are available to you, just call them to pull the team's real project context (the game's spec, descriptions, prior decisions, wiki, knowledge graph) and ground your plan in it instead of guessing. If the user asks to "connect to / use / set up DevHub" and the mcp__devhub tools are NOT available to you, do not ask for a folder — explain that DevHub is connected by installing the DevHub MCP in their Claude Code (Settings → DevHub guide), and return no changes.
EXPORTING tasks to DevHub: when the user asks to push/export/sync MarCat tasks into DevHub, use the DevHub tools to create them in this game's DevHub project (the project key is in the game state above; if absent, ask for it). Field mapping — title→title; description→description; MarCat status todo/doing/blocked/done/cancelled → the nearest DevHub status (To Do / In Progress / Blocked / Done / Cancelled); priority low/med/high/urgent → DevHub priority or a label; MarCat tags → DevHub labels; dueDate→due date. PRESERVE dependencies: create blocker tasks before the tasks they block, then recreate every "blocker -> blocked" link with DevHub's dependency/relation tool. Skip tasks that already exist there; report what you created/linked in the summary. This is a side effect via DevHub tools, so the MarCat "changes" array is usually empty for an export.
PUBLISHING insights to DevHub wiki: when the user asks to publish/send an insight, use the insight's full title and body from the game state and the game's DevHub project key. Find that project's wiki spaces, search for an existing page that expresses the same conclusion, and update the accurate existing page when one exists; otherwise create a Published wiki page in the most relevant project space. Preserve the evidence, confidence, caveats, implications, and source references from the insight. Never publish into an org-wide or another project's space. Report the resulting page title/link in the summary. This is a direct DevHub side effect, so the MarCat "changes" array is normally empty. If the project key or a project wiki space is missing, make no external change and state the exact blocker.
Be concise and actionable. Never invent ids, filesystem paths, dates or contacts — research or ask.`

const ADVISOR_SYSTEM = `You are the proactive companion inside MarCat, a local marketing planner for indie games.
Return one calm, useful recommendation in the user's language. You are a cat who wants the project to earn real Steam wishlists, but you never shame the user, overstate causality, or pretend that completing a task directly created wishlists.

Use only the supplied project signals and curated knowledge. Prefer one concrete next action over a list. If evidence is weak, say so. Platform rules and numerical thresholds marked volatile are not current facts.

You may select only one supplied actionId. Never invent routes, task ids, mutations or external actions.
Return ONLY JSON:
{
  "title": "max 60 characters",
  "message": "one or two short sentences, max 240 characters",
  "why": "one short causal explanation, max 300 characters",
  "actionId": "one supplied id",
  "knowledgeRefs": ["zero to three supplied knowledge ids"],
  "mood": "curious|hunting|hungry|content|proud|worried|happy|thinking",
  "confidence": 0.0
}`

function extractJson(text: string): any {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return {}
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return {}
  }
}

// The whole prompt (system instructions + context + request) is sent via STDIN.
// Passing it as a CLI arg with shell:true truncates at the first newline.
const MAX_AGENT_OUTPUT = 10 * 1024 * 1024
const AGENT_TIMEOUT_MS = 10 * 60_000

function stopChild(child: ReturnType<typeof spawn>): void {
  if (child.killed) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    killer.on('error', () => child.kill())
  } else {
    child.kill('SIGTERM')
  }
}

function runCli(
  command: string,
  label: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  onChild?: (child: ReturnType<typeof spawn> | null) => void,
  timeoutMs = AGENT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: process.platform === 'win32', windowsHide: true })
    onChild?.(child)
    let out = ''
    let err = ''
    let settled = false
    const finish = (error?: Error, result?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      onChild?.(null)
      if (error) reject(error)
      else resolve(result ?? '')
    }
    const append = (target: 'out' | 'err', chunk: Buffer) => {
      if (settled) return
      if (out.length + err.length + chunk.length > MAX_AGENT_OUTPUT) {
        stopChild(child)
        finish(new Error(`${label} output exceeded the 10 MB safety limit`))
        return
      }
      if (target === 'out') out += chunk.toString()
      else err += chunk.toString()
    }
    const abort = () => {
      stopChild(child)
      finish(new Error('AI request cancelled'))
    }
    const timeout = setTimeout(() => {
      stopChild(child)
      finish(new Error(`AI request timed out after ${Math.round(timeoutMs / 1000)} seconds`))
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => append('out', d))
    child.stderr.on('data', (d: Buffer) => append('err', d))
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (code !== 0) finish(new Error(err.trim() || out.trim() || `${label} exited with code ${code}`))
      else finish(undefined, out)
    })
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    child.stdin.write(input)
    child.stdin.end()
  })
}

function runClaude(
  input: string,
  token?: string,
  resumeSessionId?: string,
  model?: string,
  signal?: AbortSignal,
  onChild?: (child: ReturnType<typeof spawn> | null) => void,
  options?: { noTools?: boolean; timeoutMs?: number },
): Promise<string> {
  const env = { ...process.env }
  if (token) {
    // Only a real Anthropic API key (sk-ant-api…) goes to ANTHROPIC_API_KEY.
    // `claude setup-token` OAuth tokens are sk-ant-oat… → CLAUDE_CODE_OAUTH_TOKEN.
    if (/^sk-ant-api/i.test(token)) {
      env.ANTHROPIC_API_KEY = token
      delete env.CLAUDE_CODE_OAUTH_TOKEN
    } else {
      env.CLAUDE_CODE_OAUTH_TOKEN = token
      delete env.ANTHROPIC_API_KEY
    }
  }
  const args = ['-p', '--output-format', 'json']
  if (options?.noTools) args.push('--tools', process.platform === 'win32' ? '""' : '')
  else args.push('--allowedTools', 'WebSearch,WebFetch,mcp__devhub')
  if (model) args.push('--model', model)
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  return runCli('claude', 'Claude Code', args, input, env, signal, onChild, options?.timeoutMs)
}

function runCodex(
  input: string,
  resumeSessionId?: string,
  signal?: AbortSignal,
  onChild?: (child: ReturnType<typeof spawn> | null) => void,
  options?: { noTools?: boolean; timeoutMs?: number },
): Promise<string> {
  // `codex exec` reuses the user's ChatGPT subscription login. MarCat only needs
  // read-only workspace access: its actual data changes arrive as a JSON proposal.
  const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check']
  if (options?.noTools) args.push('--ephemeral')
  if (resumeSessionId) args.push('resume', resumeSessionId)
  args.push('-')
  return runCli('codex', 'Codex CLI', args, input, { ...process.env }, signal, onChild, options?.timeoutMs)
}

function parseCodexOutput(raw: string): { result: string; sessionId?: string; error?: string } {
  let result = ''
  let sessionId: string | undefined
  let error: string | undefined
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, any>
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        result = event.item.text
      }
      if (event.type === 'error') error = String(event.message ?? event.error?.message ?? 'Codex returned an error')
      if (event.type === 'turn.failed') error = String(event.error?.message ?? event.message ?? 'Codex turn failed')
    } catch {
      // `--json` should emit JSONL, but retaining a plain final line makes the
      // integration resilient to older CLI builds.
      result = line.trim()
    }
  }
  return { result, sessionId, error }
}

function commandOutput(command: string): string {
  return execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    windowsHide: true,
  }).trim()
}

function claudeStatus(available: boolean, token?: string): AgentProviderStatus {
  if (!available) return { available: false, authenticated: false, authMode: 'none' }
  if (token) {
    return {
      available: true,
      authenticated: true,
      authMode: /^sk-ant-api/i.test(token) ? 'api_key' : /^sk-ant-oat/i.test(token) ? 'oauth_token' : 'unknown',
    }
  }
  try {
    const status = JSON.parse(commandOutput('claude auth status --json')) as Record<string, unknown>
    if (status.loggedIn !== true) return { available: true, authenticated: false, authMode: 'none' }
    const method = String(status.authMethod ?? '').toLowerCase()
    return {
      available: true,
      authenticated: true,
      authMode: method.includes('claude.ai') ? 'subscription' : method.includes('api') ? 'api_key' : 'unknown',
      account: typeof status.email === 'string' ? status.email : undefined,
      subscription: typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined,
    }
  } catch {
    return { available: true, authenticated: false, authMode: 'none' }
  }
}

function codexStatus(available: boolean): AgentProviderStatus {
  if (!available) return { available: false, authenticated: false, authMode: 'none' }
  try {
    const output = commandOutput('codex login status')
    const normalized = output.toLowerCase()
    return {
      available: true,
      authenticated: true,
      authMode: normalized.includes('chatgpt')
        ? 'subscription'
        : normalized.includes('api key')
          ? 'api_key'
          : 'unknown',
    }
  } catch {
    return { available: true, authenticated: false, authMode: 'none' }
  }
}

export function createAgentRunner(
  getToken: () => string | undefined,
  getProvider: () => AiProvider | undefined,
  cliAvailability: Record<AiProvider, boolean>,
): AgentRunner {
  const active = new Set<ReturnType<typeof spawn>>()
  const selectedProvider = (): AiProvider => getProvider() ?? (cliAvailability.claude ? 'claude' : 'codex')
  const execute = async (
    input: string,
    resumeSessionId?: string,
    model?: string,
    signal?: AbortSignal,
    options?: { noTools?: boolean; timeoutMs?: number },
  ) => {
    const provider = selectedProvider()
    if (!cliAvailability[provider]) {
      throw new Error(
        provider === 'codex'
          ? 'Codex CLI is not available. Install it, run `codex login`, then restart MarCat.'
          : 'Claude Code CLI is not available. Install it, then restart MarCat.',
      )
    }
    let tracked: ReturnType<typeof spawn> | undefined
    const onChild = (child: ReturnType<typeof spawn> | null) => {
      if (child) {
        tracked = child
        active.add(child)
      } else if (tracked) {
        active.delete(tracked)
      }
    }
    if (provider === 'codex') {
      const raw = await runCodex(input, resumeSessionId, signal, onChild, options)
      const envelope = parseCodexOutput(raw)
      if (envelope.error) throw new Error(envelope.error)
      if (!envelope.result) throw new Error('Codex CLI returned no final response')
      return { raw, resultText: envelope.result, sessionId: envelope.sessionId, model: 'codex' }
    }
    const raw = await runClaude(input, getToken(), resumeSessionId, model, signal, onChild, options)
    const envelope = extractJson(raw)
    if (envelope && envelope.is_error === true) {
      const msg = typeof envelope.result === 'string' ? envelope.result : 'Claude Code returned an error'
      throw new Error(
        msg.includes('401') || /authenticat/i.test(msg)
          ? `${msg}\n(run \`claude setup-token\` and paste the OAuth token in Settings, or run \`claude login\`)`
          : msg,
      )
    }
    return {
      raw,
      resultText: typeof envelope?.result === 'string' ? envelope.result : raw,
      sessionId: typeof envelope?.session_id === 'string' ? envelope.session_id : undefined,
      model: typeof envelope?.model === 'string' ? envelope.model : (model ?? 'claude'),
    }
  }
  return {
    provider: selectedProvider,
    status(): AgentRuntimeStatus {
      const provider = selectedProvider()
      const providers = {
        claude: claudeStatus(cliAvailability.claude, getToken()),
        codex: codexStatus(cliAvailability.codex),
      }
      return { provider, available: providers[provider].authenticated, providers }
    },
    async run({ prompt, context, resumeSessionId, model, signal }) {
      // First turn sends SYSTEM + game state; follow-ups resume the session (context retained).
      const input = resumeSessionId
        ? `${prompt}\n\nReturn ONLY the JSON object described earlier (summary + changes; empty changes if none).`
        : `${SYSTEM}\n\n=== Game state ===\n${context}\n\n=== User request ===\n${prompt}\n\nReturn ONLY the JSON object described above.`
      const executed = await execute(input, resumeSessionId, model, signal)
      const { raw, resultText } = executed
      const parsed = extractJson(resultText)
      const changes: ProposedChange[] = Array.isArray(parsed.changes) ? parsed.changes : []
      // If the model answered in prose (no changeset), surface that text instead of a silent empty proposal.
      const summary =
        typeof parsed.summary === 'string' && parsed.summary
          ? parsed.summary
          : changes.length === 0
            ? resultText.trim().slice(0, 600)
            : ''
      return {
        summary,
        changes,
        rawOutput: raw,
        model: executed.model,
        sessionId: executed.sessionId,
      }
    },
    async advise({ language, context, knowledge, actions, model, signal }) {
      const prompt = [
        ADVISOR_SYSTEM,
        `Language: ${language}`,
        '=== Project signals ===',
        context,
        '=== Curated knowledge ===',
        knowledge || 'No matching curated cards.',
        '=== Allowed actions ===',
        JSON.stringify(actions, null, 2),
      ].join('\n\n')
      const executed = await execute(prompt, undefined, model, signal, { noTools: true, timeoutMs: 90_000 })
      const { resultText } = executed
      const parsed = extractJson(resultText)
      const actionIds = new Set(actions.map((action) => action.id))
      const moods = new Set<CompanionMood>([
        'curious',
        'hunting',
        'hungry',
        'content',
        'proud',
        'worried',
        'happy',
        'thinking',
      ])
      const fallbackAction = actions[0]?.id ?? ''
      const result: AgentAdviceResult = {
        title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
        message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
        why: typeof parsed.why === 'string' ? parsed.why.trim() : '',
        actionId: actionIds.has(parsed.actionId) ? parsed.actionId : fallbackAction,
        knowledgeRefs: Array.isArray(parsed.knowledgeRefs)
          ? parsed.knowledgeRefs.filter((value: unknown): value is string => typeof value === 'string')
          : [],
        mood: moods.has(parsed.mood) ? parsed.mood : 'thinking',
        confidence:
          typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? parsed.confidence : 0.6,
        model: executed.model,
      }
      if (!result.title || !result.message || !result.why) throw new Error('AI advisor returned an incomplete response')
      return result
    },
    cancelAll() {
      for (const child of active) stopChild(child)
      active.clear()
    },
  }
}

/** Is the `claude` CLI on PATH (i.e. can we drive the embedded agent)? */
export function claudeAvailable(): boolean {
  try {
    commandOutput('claude --version')
    return true
  } catch {
    return false
  }
}

/** Is Codex CLI available for subscription-backed embedded inference? */
export function codexAvailable(): boolean {
  try {
    commandOutput('codex --version')
    return true
  } catch {
    return false
  }
}
