import { STEAMIZDAT_KNOWLEDGE_CARDS } from './steamizdat'

export type KnowledgeKind = 'product_doc' | 'principle' | 'heuristic' | 'platform_rule' | 'case_study'
export type KnowledgeVolatility = 'low' | 'medium' | 'high'
export type KnowledgeLang = 'ru' | 'en'

interface LocalizedText {
  ru: string
  en: string
}

export interface KnowledgeCard {
  id: string
  kind: KnowledgeKind
  title: LocalizedText
  summary: LocalizedText
  guidance: LocalizedText
  tags: string[]
  routes?: string[]
  mechanism?: 'traffic' | 'store_conversion' | 'festival_readiness' | 'outreach' | 'product_workflow'
  source: string
  sourcePages?: string
  sourceYear?: number
  showSource?: boolean
  volatility: KnowledgeVolatility
  confidence: 'curated' | 'heuristic'
}

/**
 * Curated, paraphrased knowledge shipped with MarCat. The source PDF itself is
 * deliberately not bundled: cards remain small, attributable and reviewable.
 */
export const KNOWLEDGE_CARDS: KnowledgeCard[] = [
  {
    id: 'product-first-steps',
    kind: 'product_doc',
    title: { ru: 'Первые шаги в MarCat', en: 'First steps in MarCat' },
    summary: {
      ru: 'Начните с карточки проекта, одной ближайшей цели и короткой очереди конкретных задач.',
      en: 'Start with the project brief, one nearest goal, and a short queue of concrete tasks.',
    },
    guidance: {
      ru: 'Добавьте Steam-ссылку и дату релиза, заведите ближайший дедлайн, затем создайте только те задачи, которые ведут к нему.',
      en: 'Add the Steam URL and release date, create the nearest deadline, then add only the tasks that lead to it.',
    },
    tags: ['start', 'setup', 'project', 'steam', 'deadline'],
    routes: ['/g/'],
    mechanism: 'product_workflow',
    source: 'MarCat product guide',
    volatility: 'low',
    confidence: 'curated',
  },
  {
    id: 'product-task-focus',
    kind: 'product_doc',
    title: { ru: 'Фокус в задачах', en: 'Task focus' },
    summary: {
      ru: 'Доска отвечает на вопрос «что делать», список помогает разбирать массив, а граф показывает только реальные зависимости.',
      en: 'The board answers “what to do”, the list handles bulk work, and the graph shows only real dependencies.',
    },
    guidance: {
      ru: 'Держите одну задачу в работе. Связывайте только блокер и задачу, которую он действительно разблокирует; несвязанные задачи остаются отдельными.',
      en: 'Keep one task in progress. Link only a blocker and the task it truly unlocks; unrelated tasks stay separate.',
    },
    tags: ['tasks', 'focus', 'priority', 'blocked', 'dependency', 'graph'],
    routes: ['/tasks'],
    mechanism: 'product_workflow',
    source: 'MarCat product guide',
    volatility: 'low',
    confidence: 'curated',
  },
  {
    id: 'product-wishlist-data',
    kind: 'product_doc',
    title: { ru: 'Данные по вишлистам', en: 'Wishlist data' },
    summary: {
      ru: 'График становится полезным, когда рядом с динамикой вишлистов отмечены реальные маркетинговые активности.',
      en: 'The chart becomes useful when real marketing activities are marked alongside wishlist movement.',
    },
    guidance: {
      ru: 'Импортируйте CSV Steam или добавьте точку вручную, а важные публикации, фестивали и рассылки фиксируйте в журнале.',
      en: 'Import a Steam CSV or add a point manually, and log important posts, festivals and outreach in the journal.',
    },
    tags: ['wishlist', 'analytics', 'csv', 'journal', 'events'],
    routes: ['/analytics', '/events'],
    mechanism: 'product_workflow',
    source: 'MarCat product guide',
    volatility: 'low',
    confidence: 'curated',
  },
  ...STEAMIZDAT_KNOWLEDGE_CARDS,
]

const normalize = (value: string): string[] =>
  value
    .toLocaleLowerCase()
    .replace(/[^a-zа-яё0-9]+/giu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2)

export function retrieveKnowledge(input: {
  query?: string
  route?: string
  preferredIds?: string[]
  limit?: number
}): KnowledgeCard[] {
  const limit = Math.max(1, Math.min(input.limit ?? 4, 6))
  const queryTokens = new Set(normalize(input.query ?? ''))
  const preferred = new Set(input.preferredIds ?? [])
  const route = input.route ?? ''

  return KNOWLEDGE_CARDS.map((card, index) => {
    let score = preferred.has(card.id) ? 100 : 0
    if (route && card.routes?.some((candidate) => route.includes(candidate))) score += 18
    const haystack = normalize(
      [card.id, card.tags.join(' '), card.title.ru, card.title.en, card.summary.ru, card.summary.en].join(' '),
    )
    for (const token of haystack) if (queryTokens.has(token)) score += card.tags.includes(token) ? 6 : 2
    if (!queryTokens.size && !preferred.size && card.kind === 'product_doc') score += 1
    return { card, score, index }
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.card)
}

export function localizedKnowledge(card: KnowledgeCard, lang: KnowledgeLang) {
  const showSource = card.showSource !== false
  return {
    id: card.id,
    kind: card.kind,
    title: card.title[lang],
    summary: card.summary[lang],
    guidance: card.guidance[lang],
    mechanism: card.mechanism ?? null,
    source: showSource ? card.source : '',
    sourcePages: showSource ? (card.sourcePages ?? null) : null,
    sourceYear: card.sourceYear ?? null,
    volatility: card.volatility,
    confidence: card.confidence,
  }
}

export function knowledgeContext(cards: KnowledgeCard[], lang: KnowledgeLang): string {
  if (!cards.length) return ''
  return [
    'Curated MarCat knowledge. Prefer it over unsourced memory. Numeric thresholds are heuristics unless marked otherwise:',
    ...cards.map((card) => {
      const copy = localizedKnowledge(card, lang)
      return [
        `[${copy.id}] ${copy.title}`,
        `- ${copy.summary}`,
        `- Apply: ${copy.guidance}`,
        ...(copy.source ? [`- Source: ${copy.source}${copy.sourcePages ? `, pp. ${copy.sourcePages}` : ''}`] : []),
        `- Type: ${copy.kind}; volatility: ${copy.volatility}; confidence: ${copy.confidence}`,
      ].join('\n')
    }),
    'If a claim is volatile, conflicting, or platform-policy related, label it as uncertain and offer to verify current official documentation instead of asserting it.',
  ].join('\n')
}
