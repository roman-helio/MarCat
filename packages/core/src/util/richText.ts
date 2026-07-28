import TurndownService from 'turndown'

const HTML_BLOCK = /<(?:p|ul|ol|li|br|strong|em|blockquote|pre|h[1-6])(?:\s|>|\/)/i

const turndown = new TurndownService({
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
})

/** Keep Markdown as the canonical task-description format, including legacy TipTap HTML. */
export function taskDescriptionToMarkdown(value: string): string {
  const source = value.replace(/\r\n?/g, '\n').trim()
  if (!source || !HTML_BLOCK.test(source)) return source
  return turndown
    .turndown(source)
    .replace(/\r\n?/g, '\n')
    .replace(/^(\s*[-+*])\s+/gm, '$1 ')
    .replace(/^(\s*\d+[.)])\s+/gm, '$1 ')
    .trim()
}
