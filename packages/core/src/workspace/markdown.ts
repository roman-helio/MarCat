import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { isMap, parseDocument, type Document } from 'yaml'
import { slugify } from '../util/slug'
import {
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceDocumentError,
  type ProjectWorkspaceEntity,
  type TaskChecklistWorkspaceItem,
  type WorkspaceEntity,
  type WorkspaceEntityType,
} from './types'

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export interface ParsedMarkdown {
  document: Document.Parsed
  properties: Record<string, unknown>
  body: string
}

export function parseWorkspaceMarkdown(content: string): ParsedMarkdown {
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new WorkspaceDocumentError('Document exceeds the 5 MiB workspace limit')
  }
  const match = content.match(FRONTMATTER)
  if (!match) throw new WorkspaceDocumentError('Document must start with YAML frontmatter')
  const document = parseDocument(match[1], {
    keepSourceTokens: true,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  })
  if (document.errors.length) {
    throw new WorkspaceDocumentError(document.errors.map((error) => error.message).join('; '), 'invalid_yaml')
  }
  if (document.contents != null && !isMap(document.contents)) {
    throw new WorkspaceDocumentError('Frontmatter must be a YAML mapping', 'invalid_yaml')
  }
  return {
    document,
    properties: (document.toJS({ maxAliasCount: 20 }) ?? {}) as Record<string, unknown>,
    body: content.slice(match[0].length).replace(/^\r?\n/, ''),
  }
}

const stringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : value == null ? fallback : String(value)
const nullableString = (value: unknown): string | null => {
  const result = stringValue(value).trim()
  return result ? result : null
}
const numberValue = (value: unknown): number | null => {
  if (value == null || (typeof value === 'string' && !value.trim())) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const booleanValue = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : value == null ? fallback : String(value).toLowerCase() === 'true'
const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => stringValue(item).trim()).filter(Boolean)
    : value == null
      ? []
      : [stringValue(value)].filter(Boolean)

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  fallback: T[number],
): T[number] {
  const parsed = stringValue(value, fallback)
  if (!allowed.includes(parsed)) {
    throw new WorkspaceDocumentError(`${field} must be one of: ${allowed.join(', ')}`)
  }
  return parsed
}

function titleAndRest(body: string, fallbackTitle: string): { title: string; rest: string } {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const heading = lines.findIndex((line) => /^#\s+/.test(line))
  if (heading < 0) return { title: fallbackTitle, rest: body.trim() }
  const title = lines[heading]!.replace(/^#\s+/, '').trim() || fallbackTitle
  const rest = [...lines.slice(0, heading), ...lines.slice(heading + 1)].join('\n').trim()
  return { title, rest }
}

function parseSections(body: string): { intro: string; sections: Record<string, string> } {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const sections: Record<string, string> = {}
  const intro: string[] = []
  let current: string | null = null
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      current = heading[1]!.trim().toLowerCase()
      sections[current] = ''
    } else if (current) {
      sections[current] = `${sections[current]}${sections[current] ? '\n' : ''}${line}`
    } else {
      intro.push(line)
    }
  }
  for (const key of Object.keys(sections)) sections[key] = sections[key]!.trim()
  return { intro: intro.join('\n').trim(), sections }
}

function requireType(value: unknown): WorkspaceEntityType {
  const type = stringValue(value) as WorkspaceEntityType
  if (!['project', 'insight', 'task', 'tag', 'activity'].includes(type)) {
    throw new WorkspaceDocumentError(`Unsupported marcat-type: ${type || '(missing)'}`)
  }
  return type
}

export interface ParseEntityContext {
  gameId: string
  projectKey?: string | null
  now?: string
  filename?: string
}

/** Parse a supported document. A missing id is assigned and returned for write-back. */
export function parseWorkspaceEntity(content: string, context: ParseEntityContext): WorkspaceEntity {
  const { properties: p, body } = parseWorkspaceMarkdown(content)
  const type = requireType(p['marcat-type'])
  const now = context.now ?? new Date().toISOString()
  const id = nullableString(p['marcat-id']) ?? (type === 'project' ? context.gameId : randomUUID())
  const fallbackTitle = context.filename ? basename(context.filename, '.md') : 'Untitled'
  const { title, rest } = titleAndRest(body, fallbackTitle)

  if (type === 'project') {
    const parsed = parseSections(rest)
    return {
      type,
      id: context.gameId,
      gameId: context.gameId,
      name: title,
      key: nullableString(p['marcat-key']) ?? context.projectKey ?? null,
      steamAppId: numberValue(p['marcat-steam-app-id']),
      steamStoreUrl: nullableString(p['marcat-steam-store-url']),
      releaseDate: nullableString(p['marcat-release-date']),
      color: stringValue(p['marcat-color'], '#27C281'),
      oneLiner: stringValue(p['marcat-one-liner']),
      description: parsed.sections.description ?? parsed.intro,
      audience: parsed.sections.audience ?? '',
      positioning: parsed.sections.positioning ?? '',
      repository: stringValue(p['marcat-repository']),
      branch: stringValue(p['marcat-branch']),
      devhubWikiUrl: stringValue(p['marcat-devhub-wiki-url']),
      agentNotes: parsed.sections['agent notes'] ?? '',
      links: Array.isArray(p['marcat-links']) ? p['marcat-links'] : [],
      docs: Array.isArray(p['marcat-docs']) ? p['marcat-docs'] : [],
      createdAt: stringValue(p['marcat-created'], now),
      updatedAt: stringValue(p['marcat-updated'], now),
    } satisfies ProjectWorkspaceEntity
  }

  if (type === 'insight') {
    const createdBy = enumValue(p['marcat-created-by'], ['manual', 'mcp', 'ai'] as const, 'marcat-created-by', 'manual')
    return {
      type,
      id,
      gameId: context.gameId,
      title,
      body: rest,
      createdBy,
      createdAt: stringValue(p['marcat-created'], now),
      updatedAt: stringValue(p['marcat-updated'], now),
    }
  }

  if (type === 'task') {
    const parsed = parseSections(rest)
    const checklist: TaskChecklistWorkspaceItem[] = []
    const nonChecklist: string[] = []
    for (const line of (parsed.sections.checklist ?? '').split('\n')) {
      const item = line.match(/^\s*-\s*\[([ xX])\]\s*(.*?)(?:\s*<!--\s*marcat-checklist-id:([^>]+)\s*-->)?\s*$/)
      if (!item) {
        if (line.trim()) nonChecklist.push(line)
        continue
      }
      const itemId = nullableString(item[3])
      checklist.push({ ...(itemId ? { id: itemId } : {}), done: item[1]!.toLowerCase() === 'x', text: item[2]!.trim() })
    }
    const description = [parsed.intro, parsed.sections.description, ...nonChecklist].filter(Boolean).join('\n\n').trim()
    const status = enumValue(
      p['marcat-status'],
      ['todo', 'doing', 'blocked', 'done', 'cancelled'] as const,
      'marcat-status',
      'todo',
    )
    const priority = enumValue(
      p['marcat-priority'],
      ['low', 'med', 'high', 'urgent'] as const,
      'marcat-priority',
      'med',
    )
    const recurrenceInterval = numberValue(p['marcat-recurrence-interval'])
    const recurrenceUnit = nullableString(p['marcat-recurrence-unit'])
    if (recurrenceInterval !== null && (!Number.isInteger(recurrenceInterval) || recurrenceInterval < 1)) {
      throw new WorkspaceDocumentError('marcat-recurrence-interval must be a positive integer')
    }
    if (recurrenceUnit !== null && !['day', 'week', 'month', 'year'].includes(recurrenceUnit)) {
      throw new WorkspaceDocumentError('marcat-recurrence-unit must be one of: day, week, month, year')
    }
    if ((recurrenceInterval === null) !== (recurrenceUnit === null)) {
      throw new WorkspaceDocumentError('marcat recurrence interval and unit must be set together')
    }
    return {
      type,
      id,
      gameId: context.gameId,
      seq: numberValue(p['marcat-seq']),
      projectKey: nullableString(p['marcat-project']) ?? context.projectKey ?? null,
      title,
      description,
      status,
      priority,
      startDate: nullableString(p['marcat-start']),
      dueDate: nullableString(p['marcat-due']),
      reminderAt: nullableString(p['marcat-reminder']),
      completedAt: nullableString(p['marcat-completed']),
      recurrenceInterval,
      recurrenceUnit: recurrenceUnit as 'day' | 'week' | 'month' | 'year' | null,
      lastCompletedAt: nullableString(p['marcat-last-completed']),
      sortOrder: numberValue(p['marcat-sort-order']) ?? 0,
      checklist,
      blockedBy: stringList(p['marcat-blocked-by']),
      tags: stringList(p['marcat-tags']),
      createdAt: stringValue(p['marcat-created'], now),
      updatedAt: stringValue(p['marcat-updated'], now),
    }
  }

  if (type === 'tag') {
    const tagType = enumValue(
      p['marcat-tag-type'],
      ['release', 'festival', 'sale', 'update', 'track', 'other'] as const,
      'marcat-tag-type',
      'track',
    )
    return {
      type,
      id,
      gameId: context.gameId,
      name: title,
      color: stringValue(p['marcat-color'], '#888888'),
      colorEnabled: booleanValue(p['marcat-color-enabled']),
      targetDate: nullableString(p['marcat-target-date']),
      tagType,
    }
  }

  const subjectType = enumValue(
    p['marcat-subject-type'],
    ['project', 'task', 'festival', 'creator'] as const,
    'marcat-subject-type',
    'project',
  )
  const direction = nullableString(p['marcat-direction'])
  if (direction !== null && direction !== 'outbound' && direction !== 'inbound') {
    throw new WorkspaceDocumentError('marcat-direction must be outbound or inbound')
  }
  const createdBy = enumValue(
    p['marcat-created-by'],
    ['manual', 'source', 'ai'] as const,
    'marcat-created-by',
    'manual',
  )
  return {
    type: 'activity',
    id,
    gameId: context.gameId,
    occurredAt: stringValue(p['marcat-occurred-at'], now.slice(0, 10)),
    subjectType,
    subjectId: nullableString(p['marcat-subject-id']),
    subjectLabel: nullableString(p['marcat-subject-label']),
    showOnWishlist: booleanValue(p['marcat-show-on-wishlist'], true),
    direction: direction === 'outbound' || direction === 'inbound' ? direction : null,
    channel: nullableString(p['marcat-channel']),
    statusAfter: nullableString(p['marcat-status-after']),
    templateId: nullableString(p['marcat-template-id']),
    activityType: stringValue(p['marcat-activity-type'], 'other'),
    platform: nullableString(p['marcat-platform']),
    placement: nullableString(p['marcat-placement']),
    title,
    description: rest,
    url: nullableString(p['marcat-url']),
    views: numberValue(p['marcat-views']),
    likes: numberValue(p['marcat-likes']),
    comments: numberValue(p['marcat-comments']),
    isOwn: booleanValue(p['marcat-is-own'], true),
    sourceId: nullableString(p['marcat-source-id']),
    externalId: nullableString(p['marcat-external-id']),
    creatorId: nullableString(p['marcat-creator-id']),
    createdBy,
    createdAt: stringValue(p['marcat-created'], now),
    updatedAt: stringValue(p['marcat-updated'], now),
  }
}

function propertiesFor(entity: WorkspaceEntity, revision: number): Record<string, unknown> {
  const common: Record<string, unknown> = {
    'marcat-type': entity.type,
    'marcat-id': entity.id,
    'marcat-schema': WORKSPACE_SCHEMA_VERSION,
    'marcat-revision': revision,
  }
  if (entity.type === 'project')
    return {
      ...common,
      'marcat-key': entity.key,
      'marcat-steam-app-id': entity.steamAppId,
      'marcat-steam-store-url': entity.steamStoreUrl,
      'marcat-release-date': entity.releaseDate,
      'marcat-color': entity.color,
      'marcat-one-liner': entity.oneLiner,
      'marcat-repository': entity.repository || null,
      'marcat-branch': entity.branch || null,
      'marcat-devhub-wiki-url': entity.devhubWikiUrl || null,
      'marcat-links': entity.links.length ? entity.links : null,
      'marcat-docs': entity.docs.length ? entity.docs : null,
      'marcat-created': entity.createdAt,
      'marcat-updated': entity.updatedAt,
    }
  if (entity.type === 'insight')
    return {
      ...common,
      'marcat-created-by': entity.createdBy,
      'marcat-created': entity.createdAt,
      'marcat-updated': entity.updatedAt,
    }
  if (entity.type === 'task')
    return {
      ...common,
      'marcat-project': entity.projectKey,
      'marcat-seq': entity.seq,
      'marcat-status': entity.status,
      'marcat-priority': entity.priority,
      'marcat-start': entity.startDate,
      'marcat-due': entity.dueDate,
      'marcat-reminder': entity.reminderAt,
      'marcat-completed': entity.completedAt,
      'marcat-recurrence-interval': entity.recurrenceInterval,
      'marcat-recurrence-unit': entity.recurrenceUnit,
      'marcat-last-completed': entity.lastCompletedAt,
      'marcat-sort-order': entity.sortOrder || null,
      'marcat-blocked-by': entity.blockedBy.length ? entity.blockedBy : null,
      'marcat-tags': entity.tags.length ? entity.tags : null,
      'marcat-created': entity.createdAt,
      'marcat-updated': entity.updatedAt,
    }
  if (entity.type === 'tag')
    return {
      ...common,
      'marcat-tag-type': entity.tagType,
      'marcat-color': entity.color,
      'marcat-color-enabled': entity.colorEnabled || null,
      'marcat-target-date': entity.targetDate,
    }
  return {
    ...common,
    'marcat-occurred-at': entity.occurredAt,
    'marcat-subject-type': entity.subjectType,
    'marcat-subject-id': entity.subjectId,
    'marcat-subject-label': entity.subjectLabel,
    'marcat-show-on-wishlist': entity.showOnWishlist,
    'marcat-direction': entity.direction,
    'marcat-channel': entity.channel,
    'marcat-status-after': entity.statusAfter,
    'marcat-template-id': entity.templateId,
    'marcat-activity-type': entity.activityType,
    'marcat-platform': entity.platform,
    'marcat-placement': entity.placement,
    'marcat-url': entity.url,
    'marcat-views': entity.views,
    'marcat-likes': entity.likes,
    'marcat-comments': entity.comments,
    'marcat-is-own': entity.isOwn,
    'marcat-source-id': entity.sourceId,
    'marcat-external-id': entity.externalId,
    'marcat-creator-id': entity.creatorId,
    'marcat-created-by': entity.createdBy,
    'marcat-created': entity.createdAt,
    'marcat-updated': entity.updatedAt,
  }
}

/** Keep user-owned H2 sections byte-for-byte while MarCat updates its sections. */
function preservedSections(existingContent: string | undefined, owned: Set<string>): string[] {
  if (!existingContent) return []
  const body = parseWorkspaceMarkdown(existingContent).body.replace(/\r\n/g, '\n')
  const lines = body.split('\n')
  const result: string[] = []
  let start = -1
  let heading = ''
  const flush = (end: number) => {
    if (start < 0 || owned.has(heading)) return
    const block = lines.slice(start, end).join('\n').trimEnd()
    if (block) result.push(block)
  }
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^##\s+(.+?)\s*$/)
    if (!match) continue
    flush(index)
    start = index
    heading = match[1]!.trim().toLowerCase()
  }
  flush(lines.length)
  return result
}

function markdownBody(entity: WorkspaceEntity, existingContent?: string): string {
  if (entity.type === 'project') {
    const sections = [
      ['Description', entity.description],
      ['Audience', entity.audience],
      ['Positioning', entity.positioning],
      ['Agent Notes', entity.agentNotes],
    ].map(([heading, content]) => `## ${heading}\n\n${content}`)
    const preserved = preservedSections(
      existingContent,
      new Set(['description', 'audience', 'positioning', 'agent notes']),
    )
    return `# ${entity.name}\n\n${[...sections, ...preserved].join('\n\n')}`
  }
  if (entity.type === 'task') {
    const checklist = entity.checklist
      .map(
        (item) =>
          `- [${item.done ? 'x' : ' '}] ${item.text}${item.id ? ` <!-- marcat-checklist-id:${item.id} -->` : ''}`,
      )
      .join('\n')
    const owned = [`## Description\n\n${entity.description}`, ...(checklist ? [`## Checklist\n\n${checklist}`] : [])]
    const preserved = preservedSections(existingContent, new Set(['description', 'checklist']))
    return `# ${entity.title}\n\n${[...owned, ...preserved].join('\n\n')}`
  }
  const title = entity.type === 'tag' ? entity.name : entity.title
  const body = entity.type === 'tag' ? '' : entity.type === 'activity' ? entity.description : entity.body
  return `# ${title}${body ? `\n\n${body}` : ''}`
}

/** Update only MarCat-owned properties; arbitrary user properties/comments survive. */
export function renderWorkspaceEntity(
  entity: WorkspaceEntity,
  options: { existingContent?: string; revision?: number } = {},
): string {
  let document: Document.Parsed
  if (options.existingContent) {
    document = parseWorkspaceMarkdown(options.existingContent).document
  } else {
    document = parseDocument('', { keepSourceTokens: true })
  }
  const properties = propertiesFor(entity, options.revision ?? 1)
  const desiredKeys = new Set(Object.keys(properties))
  if (isMap(document.contents)) {
    for (const pair of [...document.contents.items]) {
      const key = stringValue(pair.key && 'value' in pair.key ? pair.key.value : pair.key)
      if (key.startsWith('marcat-') && !desiredKeys.has(key)) document.delete(key)
    }
  }
  for (const [key, value] of Object.entries(properties)) {
    if (value == null || value === '') document.delete(key)
    else document.set(key, value)
  }
  const yaml = document.toString({ lineWidth: 0 }).trimEnd()
  return `---\n${yaml}\n---\n\n${markdownBody(entity, options.existingContent).trimEnd()}\n`
}

export function defaultWorkspacePath(entity: WorkspaceEntity): string {
  const shortId = entity.id.replace(/-/g, '').slice(0, 8)
  if (entity.type === 'project') return 'Project.md'
  if (entity.type === 'task') {
    const key = entity.projectKey && entity.seq ? `${entity.projectKey}-${entity.seq}` : null
    return `Tasks/${key ?? `${slugify(entity.title) || 'task'}--${shortId}`}.md`
  }
  if (entity.type === 'insight') return `Insights/${slugify(entity.title) || 'insight'}--${shortId}.md`
  if (entity.type === 'tag') return `Campaigns/${slugify(entity.name) || 'campaign'}--${shortId}.md`
  const folder = ['post', 'video', 'stream', 'press'].includes(entity.activityType) ? 'Posts' : 'Activity'
  return `${folder}/${entity.occurredAt}-${slugify(entity.title) || 'activity'}--${shortId}.md`
}
