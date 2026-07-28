import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bold, Eye, Italic, List, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n/useT'

/** Markdown source editor with a safe rendered preview. Commits Markdown on blur. */
export function RichText({
  value,
  onCommit,
  editing: controlledEditing,
  onEditingChange,
  showModeToggle = true,
}: {
  value: string
  onCommit: (markdown: string) => void
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  showModeToggle?: boolean
}) {
  const t = useT()
  const rootRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [internalEditing, setInternalEditing] = useState(false)
  const editing = controlledEditing ?? internalEditing
  const setEditing = (next: boolean) => {
    setInternalEditing(next)
    onEditingChange?.(next)
  }
  const [draft, setDraft] = useState(value)

  const commit = () => {
    const markdown = draft.replace(/\r\n?/g, '\n').trim()
    if (markdown !== value) onCommit(markdown)
  }

  const focusEditor = () => {
    setEditing(true)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const wrapSelection = (before: string, after = before) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = draft.slice(start, end)
    const next = `${draft.slice(0, start)}${before}${selected}${after}${draft.slice(end)}`
    setDraft(next)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(start + before.length, end + before.length)
    })
  }

  const toggleList = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = draft.lastIndexOf('\n', textarea.selectionStart - 1) + 1
    const nextBreak = draft.indexOf('\n', textarea.selectionEnd)
    const end = nextBreak === -1 ? draft.length : nextBreak
    const block = draft.slice(start, end)
    const lines = block.split('\n')
    const removeMarkers = lines.every((line) => !line.trim() || /^\s*-\s+/.test(line))
    const replacement = lines
      .map((line) => (removeMarkers ? line.replace(/^(\s*)-\s+/, '$1') : line.trim() ? `- ${line}` : line))
      .join('\n')
    setDraft(`${draft.slice(0, start)}${replacement}${draft.slice(end)}`)
    requestAnimationFrame(() => textarea.focus())
  }

  const btn = (active = false) =>
    cn(
      'inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted transition-[color,background-color,scale] hover:bg-surface-2 hover:text-text active:scale-[0.96]',
      active && 'bg-surface-2 text-accent',
    )

  return (
    <div
      ref={rootRef}
      className="min-w-0 max-w-full overflow-hidden rounded-[var(--radius)] border border-border bg-bg"
    >
      {(editing || showModeToggle) && (
        <div className="flex gap-0.5 border-b border-border p-1">
          {editing ? (
            <>
              <button
                type="button"
                aria-label={t('common.bold')}
                title={`${t('common.bold')} (Ctrl+B)`}
                className={btn()}
                onClick={() => wrapSelection('**')}
              >
                <Bold className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={t('common.italic')}
                title={`${t('common.italic')} (Ctrl+I)`}
                className={btn()}
                onClick={() => wrapSelection('*')}
              >
                <Italic className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={t('common.bullets')}
                title={t('common.bullets')}
                className={btn()}
                onClick={toggleList}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              {showModeToggle && (
                <button
                  type="button"
                  aria-label={t('common.preview')}
                  title={t('common.preview')}
                  className={cn(btn(), 'ml-auto')}
                  onClick={() => {
                    commit()
                    setEditing(false)
                  }}
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          ) : showModeToggle ? (
            <button
              type="button"
              aria-label={t('common.edit')}
              title={t('common.edit')}
              className={cn(btn(), 'ml-auto')}
              onClick={focusEditor}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      )}

      {editing ? (
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => {
            if (!rootRef.current?.contains(event.relatedTarget)) commit()
          }}
          className="min-h-40 w-full resize-y bg-transparent px-2.5 py-2 font-mono text-sm leading-relaxed outline-none"
        />
      ) : (
        <div className="markdown-content min-h-16 min-w-0 max-w-full break-words px-2.5 py-2 text-sm text-pretty [overflow-wrap:anywhere]">
          {draft ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children, ...props }) => (
                  <a {...props} target="_blank" rel="noreferrer" className="break-all">
                    {children}
                  </a>
                ),
              }}
            >
              {draft}
            </ReactMarkdown>
          ) : (
            <span className="text-muted">—</span>
          )}
        </div>
      )}
    </div>
  )
}
