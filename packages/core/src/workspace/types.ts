export const WORKSPACE_SCHEMA_VERSION = 2

export type WorkspaceEntityType = 'project' | 'insight' | 'task' | 'tag' | 'activity'
export type WorkspaceFileStatus = 'synced' | 'dirty' | 'conflict' | 'missing' | 'invalid' | 'quarantined'

export interface WorkspaceConfigInput {
  gameId: string
  rootPath: string
  workspaceFolder?: string
  enabled?: boolean
}

export interface WorkspaceConfigRecord {
  gameId: string
  rootPath: string
  workspaceFolder: string
  enabled: boolean
  schemaVersion: number
  lastScanAt: string | null
}

export interface ProjectWorkspaceEntity {
  type: 'project'
  id: string
  gameId: string
  name: string
  key: string | null
  steamAppId: number | null
  steamStoreUrl: string | null
  releaseDate: string | null
  color: string
  oneLiner: string
  description: string
  audience: string
  positioning: string
  repository: string
  branch: string
  devhubWikiUrl: string
  agentNotes: string
  links: unknown[]
  docs: unknown[]
  createdAt: string
  updatedAt: string
}

export interface InsightWorkspaceEntity {
  type: 'insight'
  id: string
  gameId: string
  title: string
  body: string
  createdBy: 'manual' | 'mcp' | 'ai'
  createdAt: string
  updatedAt: string
}

export interface TaskChecklistWorkspaceItem {
  id?: string
  text: string
  done: boolean
}

export interface TaskWorkspaceEntity {
  type: 'task'
  id: string
  gameId: string
  seq: number | null
  projectKey: string | null
  title: string
  description: string
  status: 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled'
  priority: 'low' | 'med' | 'high' | 'urgent'
  startDate: string | null
  dueDate: string | null
  reminderAt: string | null
  completedAt: string | null
  recurrenceInterval: number | null
  recurrenceUnit: 'day' | 'week' | 'month' | 'year' | null
  lastCompletedAt: string | null
  sortOrder: number
  checklist: TaskChecklistWorkspaceItem[]
  blockedBy: string[]
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface TagWorkspaceEntity {
  type: 'tag'
  id: string
  gameId: string
  name: string
  color: string
  colorEnabled: boolean
  targetDate: string | null
  tagType: 'release' | 'festival' | 'sale' | 'update' | 'track' | 'other'
}

export interface ActivityWorkspaceEntity {
  type: 'activity'
  id: string
  gameId: string
  occurredAt: string
  subjectType: 'project' | 'task' | 'festival' | 'creator'
  subjectId: string | null
  subjectLabel: string | null
  showOnWishlist: boolean
  direction: 'outbound' | 'inbound' | null
  channel: string | null
  statusAfter: string | null
  templateId: string | null
  activityType: string
  platform: string | null
  placement: string | null
  title: string
  description: string
  url: string | null
  views: number | null
  likes: number | null
  comments: number | null
  isOwn: boolean
  sourceId: string | null
  externalId: string | null
  creatorId: string | null
  createdBy: 'manual' | 'source' | 'ai'
  createdAt: string
  updatedAt: string
}

export type WorkspaceEntity =
  | ProjectWorkspaceEntity
  | InsightWorkspaceEntity
  | TaskWorkspaceEntity
  | TagWorkspaceEntity
  | ActivityWorkspaceEntity

export interface WorkspaceFileRecord {
  id: string
  gameId: string
  entityType: string
  entityId: string
  relativePath: string
  contentHash: string
  baseHash: string
  baseContent: string
  revision: number
  status: WorkspaceFileStatus
  missingSince: string | null
  mtimeMs: number | null
  size: number | null
  lastSyncedAt: string
}

export interface WorkspaceIssueInput {
  gameId: string
  workspaceFileId?: string | null
  kind: 'invalid_yaml' | 'invalid_document' | 'conflict' | 'duplicate_id' | 'io' | 'missing'
  severity?: 'warning' | 'error'
  relativePath?: string | null
  message: string
  details?: Record<string, unknown>
}

export interface WorkspaceIssueRecord extends WorkspaceIssueInput {
  id: string
  severity: 'warning' | 'error'
  detailsJson: string
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkspaceScanResult {
  scanned: number
  imported: number
  exported: number
  renamed: number
  missing: number
  conflicts: number
  invalid: number
  issues: number
}

export interface WorkspaceStatus {
  config: WorkspaceConfigRecord | null
  files: Record<WorkspaceFileStatus, number>
  openIssues: number
  pendingWrites: number
}

export class WorkspaceDocumentError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid_yaml' | 'invalid_document' = 'invalid_document',
  ) {
    super(message)
    this.name = 'WorkspaceDocumentError'
  }
}
