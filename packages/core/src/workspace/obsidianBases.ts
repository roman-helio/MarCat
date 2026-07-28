import { createWorkspaceFileIfMissing } from './filesystem'

interface BaseDefinition {
  filename: string
  type: 'task' | 'insight' | 'activity' | 'tag'
  name: string
  properties: Array<[property: string, displayName: string]>
}

const BASES: BaseDefinition[] = [
  {
    filename: 'Tasks.base',
    type: 'task',
    name: 'Tasks',
    properties: [
      ['file.name', 'Task'],
      ['marcat-status', 'Status'],
      ['marcat-priority', 'Priority'],
      ['marcat-due', 'Due'],
      ['marcat-tags', 'Campaigns'],
    ],
  },
  {
    filename: 'Insights.base',
    type: 'insight',
    name: 'Insights',
    properties: [
      ['file.name', 'Insight'],
      ['marcat-created-by', 'Created by'],
      ['marcat-created', 'Created'],
      ['marcat-updated', 'Updated'],
    ],
  },
  {
    filename: 'Activity.base',
    type: 'activity',
    name: 'Activity',
    properties: [
      ['file.name', 'Activity'],
      ['marcat-occurred-at', 'Date'],
      ['marcat-activity-type', 'Type'],
      ['marcat-platform', 'Platform'],
      ['marcat-views', 'Views'],
    ],
  },
  {
    filename: 'Campaigns.base',
    type: 'tag',
    name: 'Campaigns',
    properties: [
      ['file.name', 'Campaign'],
      ['marcat-tag-type', 'Type'],
      ['marcat-target-date', 'Target date'],
      ['marcat-color', 'Color'],
    ],
  },
]

const quote = (value: string): string => JSON.stringify(value)

export function renderObsidianBase(definition: BaseDefinition): string {
  const configured = definition.properties
    .map(([property, displayName]) => `  ${quote(property)}:\n    displayName: ${quote(displayName)}`)
    .join('\n')
  const order = definition.properties.map(([property]) => `      - ${quote(property)}`).join('\n')
  return `filters:\n  and:\n    - 'note["marcat-type"] == "${definition.type}"'\nproperties:\n${configured}\nviews:\n  - type: table\n    name: ${quote(definition.name)}\n    order:\n${order}\n`
}

/** Generate useful Obsidian views once; existing files are always user-owned. */
export async function ensureObsidianBases(workspaceRoot: string): Promise<number> {
  let created = 0
  for (const definition of BASES) {
    if (
      await createWorkspaceFileIfMissing(workspaceRoot, `Views/${definition.filename}`, renderObsidianBase(definition))
    ) {
      created += 1
    }
  }
  return created
}
