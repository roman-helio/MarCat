import type { DB } from '@marcat/db'
import type { MarkdownWorkspaceCoordinator } from './workspace/coordinator'

export type ProposedOp = 'create' | 'update' | 'delete'

export interface ProposedChange {
  op: ProposedOp
  /** task | event | dependency | tag */
  entity: string
  after: Record<string, unknown>
}

export interface AgentRunInput {
  gameId: string
  prompt: string
  /** Pre-built textual summary of the game's current state. */
  context: string
  /** When set, continue an existing chat (claude --resume) instead of starting fresh. */
  resumeSessionId?: string
  /** Resolved model id to pass to the CLI (e.g. 'claude-sonnet-5'). Omit for the CLI default. */
  model?: string
  /** Cancels an in-flight CLI process when the user stops it or the app exits. */
  signal?: AbortSignal
}

export interface AgentRunResult {
  summary: string
  changes: ProposedChange[]
  rawOutput: string
  model?: string
  /** Claude session id, so the run can be resumed as a chat. */
  sessionId?: string
}

export type CompanionMood =
  | 'sleeping'
  | 'idle'
  | 'happy'
  | 'excited'
  | 'thinking'
  | 'worried'
  | 'alarmed'
  | 'proud'
  | 'curious'
  | 'hunting'
  | 'hungry'
  | 'content'

export interface CompanionAdviceAction {
  id: string
  label: string
  path: string
}

export interface AgentAdviceInput {
  gameId: string
  language: 'ru' | 'en'
  /** Small, pre-filtered project signal pack. Never the full database dump. */
  context: string
  /** At most a few curated cards selected locally before inference. */
  knowledge: string
  /** Server-authored actions. Claude may select an id, never invent a route or mutation. */
  actions: CompanionAdviceAction[]
  model?: string
  signal?: AbortSignal
}

export interface AgentAdviceResult {
  title: string
  message: string
  why: string
  actionId: string
  knowledgeRefs: string[]
  mood: CompanionMood
  confidence: number
  model?: string
}

export type AiProvider = 'claude' | 'codex'
export type AiAuthMode = 'subscription' | 'oauth_token' | 'api_key' | 'unknown' | 'none'

export interface AgentProviderStatus {
  available: boolean
  authenticated: boolean
  authMode: AiAuthMode
  account?: string
  subscription?: string
}

export interface AgentRuntimeStatus {
  provider: AiProvider
  available: boolean
  providers: Record<AiProvider, AgentProviderStatus>
}

/** Implemented in the Electron main process (drives Claude Code or Codex CLI). */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>
  /** Short, no-tools advisor call used by the proactive companion. */
  advise?(input: AgentAdviceInput): Promise<AgentAdviceResult>
  /** Lightweight selected-provider lookup used for model routing. */
  provider?(): AiProvider
  /** CLI and authentication diagnostics shown in Settings. */
  status?(): AgentRuntimeStatus
  cancelAll?(): void
}

/** Secure storage for the AI preference, Claude token and connector API keys. */
export interface SecretsStore {
  getClaudeToken(): string | undefined
  setClaudeToken(token: string | null): void
  getAiProvider(): AiProvider | undefined
  setAiProvider(provider: AiProvider): void
  /** Per-provider connector API key (e.g. 'twitterapi', 'scrapecreators'). */
  getApiKey(provider: string): string | undefined
  setApiKey(provider: string, key: string | null): void
}

/**
 * Request context shared by all tRPC procedures. The transport layer builds it
 * and injects the database handle (and, in the desktop app, the AI agent runner).
 */
export interface Context {
  db: DB
  workspace?: MarkdownWorkspaceCoordinator
  agent?: AgentRunner
  secrets?: SecretsStore
  /** Runtime metadata and filesystem paths known by the desktop main process. */
  appPaths?: { dbPath: string; mcpServerPath: string; appVersion?: string; changelogPath?: string }
}

export type CreateContext = () => Context | Promise<Context>
