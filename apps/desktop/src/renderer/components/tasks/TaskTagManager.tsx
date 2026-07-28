import { useMemo, useState } from 'react'
import { Check, ChevronDown, Pencil, Search, X } from 'lucide-react'
import { cn, fieldCls } from '@/lib/utils'
import { useT } from '@/i18n/useT'
import type { TaskTag } from './meta'

export type TagWithProgress = TaskTag & {
  targetDate: string | null
  linkedTotal: number
  linkedDone: number
  linkedClosed: number
  openCount: number
  overdueCount: number
}

export function TaskTagManager({
  tags,
  activeTag,
  onChange,
  onEdit,
}: {
  tags: TagWithProgress[]
  activeTag: string | null
  onChange: (id: string | null) => void
  onEdit: (id: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [showCompleted, setShowCompleted] = useState(false)
  const selected = tags.find((tag) => tag.id === activeTag) ?? null
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return tags.filter((tag) => {
      const complete = tag.linkedTotal > 0 && tag.openCount === 0
      if (!showCompleted && complete && tag.id !== activeTag) return false
      return !needle || tag.name.toLocaleLowerCase().includes(needle)
    })
  }, [activeTag, query, showCompleted, tags])

  return (
    <div className={cn('relative flex min-w-0 items-center gap-2', open && 'z-50')}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="tap inline-flex h-10 shrink-0 items-center gap-2 rounded-[var(--radius)] bg-surface px-3 text-sm text-text shadow-hard hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <span>{t('tasks.goals')}</span>
        <span className="nums text-xs text-muted">{tags.length}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-150 ease-out', open && 'rotate-180')} />
      </button>

      {selected && (
        <span
          className={cn(
            'inline-flex h-8 min-w-0 max-w-80 items-center gap-1 rounded-[6px] pl-2 text-xs',
            !selected.colorEnabled && 'bg-surface-2 text-muted',
          )}
          style={selected.colorEnabled ? { background: `${selected.color}1f`, color: selected.color } : undefined}
        >
          <span className="truncate" title={selected.name}>
            {selected.name}
          </span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="tap inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] hover:bg-black/10"
            aria-label={t('tasks.clearGoal')}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}

      {open && (
        <div className="enter absolute left-0 top-12 z-50 w-[min(520px,calc(100vw-280px))] rounded-[12px] bg-surface p-2 shadow-hard">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('tasks.searchGoals')}
              className={cn(fieldCls, 'bg-surface-2/50 pl-9')}
            />
          </div>
          <label className="mt-1 flex h-10 cursor-pointer items-center gap-2 rounded-[var(--radius)] px-2 text-xs text-muted hover:bg-surface-2 hover:text-text">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(event) => setShowCompleted(event.target.checked)}
              className="accent-accent"
            />
            {t('tasks.showCompletedGoals')}
          </label>
          <div className="max-h-80 overflow-y-auto">
            {visible.map((tag) => {
              const complete = tag.linkedTotal > 0 && tag.openCount === 0
              return (
                <div key={tag.id} className="group/tag flex min-h-10 items-center rounded-[8px] hover:bg-surface-2">
                  <button
                    type="button"
                    onClick={() => {
                      onChange(tag.id === activeTag ? null : tag.id)
                      setOpen(false)
                    }}
                    className="tap flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[8px] px-2 text-left"
                  >
                    <span
                      className={cn('h-2 w-2 shrink-0 rounded-full', !tag.colorEnabled && 'bg-muted/50')}
                      style={tag.colorEnabled ? { background: tag.color } : undefined}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm" title={tag.name}>
                      {tag.name}
                    </span>
                    {complete && <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-label={t('status.done')} />}
                    <span className="nums w-14 shrink-0 text-right text-xs text-muted">
                      {tag.linkedClosed}/{tag.linkedTotal}
                    </span>
                    {tag.targetDate && (
                      <span className="nums w-20 shrink-0 text-right text-xs text-muted">{tag.targetDate}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onEdit(tag.id)
                      setOpen(false)
                    }}
                    className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] text-muted opacity-0 transition-opacity duration-150 ease-out group-hover/tag:opacity-100 focus-visible:opacity-100 hover:text-text"
                    aria-label={t('common.edit')}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              )
            })}
            {visible.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">{t('tasks.noGoals')}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
