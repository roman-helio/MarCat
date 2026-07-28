import { useMemo, useRef, useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { useModal } from '@/lib/modal'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { ColorSelect } from '@/components/ui/ColorSelect'
import { useT } from '@/i18n/useT'
import {
  PRIORITY_ORDER,
  PRIORITY_META,
  STATUS_ORDER,
  STATUS_META,
  type TaskPriority,
  type RecurrenceUnit,
  type TaskStatus,
  type TaskTag,
  type TaskWithTags,
} from './meta'
import { smartMatches } from './smartSearch'
import { TaskRecurrenceControl } from './TaskRecurrenceControl'

const panel = 'rounded-[12px] bg-bg/55 p-3 shadow-hard'

export function TaskCreateDrawer({
  gameId,
  tasks,
  tags,
  onClose,
  onCreated,
}: {
  gameId: string
  tasks: TaskWithTags[]
  tags: TaskTag[]
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const t = useT()
  const panelRef = useRef<HTMLFormElement>(null)
  useModal(panelRef, onClose)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<TaskStatus>('todo')
  const [priority, setPriority] = useState<TaskPriority>('med')
  const [startDate, setStartDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [recurrence, setRecurrence] = useState<{ every: number; unit: RecurrenceUnit } | null>(null)
  const [tagQuery, setTagQuery] = useState('')
  const [tagIds, setTagIds] = useState<Set<string>>(new Set())
  const [newTagNames, setNewTagNames] = useState<Set<string>>(new Set())
  const [tagFocused, setTagFocused] = useState(false)
  const [blockerQuery, setBlockerQuery] = useState('')
  const [blockerFocused, setBlockerFocused] = useState(false)
  const [blockerIds, setBlockerIds] = useState<Set<string>>(new Set())
  const [newChecklistItem, setNewChecklistItem] = useState('')
  const [checklist, setChecklist] = useState<string[]>([])

  const matchingTags = useMemo(() => {
    return smartMatches(
      tags.filter((tag) => !tagIds.has(tag.id)),
      tagQuery,
      (tag) => [tag.name],
    ).slice(0, 6)
  }, [tagIds, tagQuery, tags])
  const matchingBlockers = useMemo(
    () =>
      smartMatches(
        tasks.filter((task) => !blockerIds.has(task.id)),
        blockerQuery,
        (task) => [task.taskKey ?? '', task.title, task.description],
      ).slice(0, 8),
    [blockerIds, blockerQuery, tasks],
  )
  const exactTag = tags.find((tag) => tag.name.toLocaleLowerCase() === tagQuery.trim().toLocaleLowerCase())
  const canCreateTag =
    !!tagQuery.trim() &&
    !exactTag &&
    ![...newTagNames].some((name) => name.toLocaleLowerCase() === tagQuery.trim().toLocaleLowerCase())

  const create = useMutation({
    mutationFn: () =>
      trpc.tasks.create.mutate({
        gameId,
        title: title.trim(),
        description,
        status,
        priority,
        startDate: startDate || null,
        dueDate: dueDate || null,
        recurrence: recurrence ?? undefined,
        tagIds: [...tagIds],
        newTagNames: [...newTagNames],
        blockerTaskIds: [...blockerIds],
        checklist,
      }),
    onSuccess: (task) => onCreated(task.id),
    onError: toast.fromError,
  })

  const addChecklistItem = () => {
    const value = newChecklistItem.trim()
    if (!value) return
    setChecklist((items) => [...items, value])
    setNewChecklistItem('')
  }

  const addTag = () => {
    const name = tagQuery.trim()
    if (!name) return
    if (exactTag) setTagIds((ids) => new Set(ids).add(exactTag.id))
    else setNewTagNames((names) => new Set(names).add(name))
    setTagQuery('')
    setTagFocused(false)
  }

  const addFirstBlocker = () => {
    const first = matchingBlockers[0]
    if (!first) return
    setBlockerIds((ids) => new Set(ids).add(first.id))
    setBlockerQuery('')
    setBlockerFocused(false)
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={onClose}>
      <form
        ref={panelRef}
        className="enter flex h-full w-[min(760px,100vw)] flex-col overflow-hidden border-l border-border bg-surface shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (title.trim()) create.mutate()
        }}
      >
        <div className="flex min-h-14 items-center gap-3 border-b border-border px-4">
          <h2 className="t-title flex-1">{t('tasks.createTitle')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="tap inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="nums mb-1 text-xs text-muted">{t('tasks.keyAfterCreate')}</p>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('tasks.taskTitlePlaceholder')}
            className="mb-4 w-full bg-transparent text-xl font-medium leading-snug text-text outline-none placeholder:text-muted/60 focus-visible:ring-0"
          />
          <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_272px]">
            <main className="min-w-0 space-y-4">
              <section className={panel}>
                <label className="text-xs font-medium text-text" htmlFor="new-task-description">
                  {t('task.description')}
                </label>
                <textarea
                  id="new-task-description"
                  rows={10}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('tasks.descriptionPlaceholder')}
                  className={cn(fieldCls, 'mt-2 resize-y leading-relaxed')}
                />
              </section>

              <section className={panel}>
                <h3 className="text-xs font-medium text-text">{t('task.checklist')}</h3>
                <div className="mt-2 space-y-1">
                  {checklist.map((item, index) => (
                    <div key={`${item}-${index}`} className="flex min-h-10 items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 text-pretty">{item}</span>
                      <button
                        type="button"
                        onClick={() => setChecklist((items) => items.filter((_, itemIndex) => itemIndex !== index))}
                        className="tap inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-alarm"
                        aria-label={t('common.delete')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <input
                      value={newChecklistItem}
                      onChange={(event) => setNewChecklistItem(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          addChecklistItem()
                        }
                      }}
                      placeholder={t('task.addItem')}
                      className={fieldCls}
                    />
                    <Button type="button" size="icon" variant="outline" onClick={addChecklistItem}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </section>
            </main>

            <aside className="min-w-0 space-y-3">
              <section className={panel}>
                <div className="grid gap-3">
                  <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,.85fr)] gap-2">
                    <label className="grid min-w-0 gap-1 text-xs text-muted">
                      {t('task.status')}
                      <ColorSelect
                        value={status}
                        onChange={setStatus}
                        ariaLabel={t('task.status')}
                        options={STATUS_ORDER.map((value) => ({
                          value,
                          label: t(`status.${value}`),
                          tone: STATUS_META[value].badge,
                        }))}
                      />
                    </label>
                    <label className="grid min-w-0 gap-1 text-xs text-muted">
                      {t('task.priority')}
                      <ColorSelect
                        value={priority}
                        onChange={setPriority}
                        ariaLabel={t('task.priority')}
                        options={PRIORITY_ORDER.map((value) => ({
                          value,
                          label: t(`prio.${value}`),
                          tone: PRIORITY_META[value].cls,
                        }))}
                      />
                    </label>
                  </div>
                  <label className="grid min-w-0 gap-1 text-xs text-muted">
                    {t('task.start')}
                    <input
                      type="date"
                      value={startDate}
                      onChange={(event) => setStartDate(event.target.value)}
                      className={cn(fieldCls, 'min-w-0')}
                    />
                  </label>
                  <label className="grid min-w-0 gap-1 text-xs text-muted">
                    {t('task.due')}
                    <input
                      type="date"
                      value={dueDate}
                      onChange={(event) => setDueDate(event.target.value)}
                      className={cn(fieldCls, 'min-w-0')}
                    />
                  </label>
                  <div className="border-t border-border pt-2">
                    <TaskRecurrenceControl value={recurrence} onChange={setRecurrence} />
                  </div>
                </div>
              </section>

              <section className={panel}>
                <h3 className="text-xs font-medium text-text">{t('task.tags')}</h3>
                <div className="mt-2 flex flex-wrap gap-1">
                  {tags
                    .filter((tag) => tagIds.has(tag.id))
                    .map((tag) => (
                      <button
                        type="button"
                        key={tag.id}
                        onClick={() => setTagIds((ids) => new Set([...ids].filter((id) => id !== tag.id)))}
                        className="tap inline-flex min-h-8 max-w-full items-center gap-1 rounded-[6px] bg-surface-2 px-2 text-xs text-muted"
                      >
                        <span className="truncate">{tag.name}</span>
                        <X className="h-3 w-3 shrink-0" />
                      </button>
                    ))}
                  {[...newTagNames].map((name) => (
                    <button
                      type="button"
                      key={name}
                      onClick={() => setNewTagNames((names) => new Set([...names].filter((item) => item !== name)))}
                      className="tap inline-flex min-h-8 max-w-full items-center gap-1 rounded-[6px] bg-blue-50 px-2 text-xs text-blue-700 dark:bg-blue-400/10 dark:text-blue-300"
                    >
                      <span className="truncate">{name}</span>
                      <X className="h-3 w-3 shrink-0" />
                    </button>
                  ))}
                </div>
                <input
                  value={tagQuery}
                  onChange={(event) => setTagQuery(event.target.value)}
                  onFocus={() => setTagFocused(true)}
                  onBlur={() => setTagFocused(false)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addTag()
                    }
                  }}
                  placeholder={t('tasks.searchGoals')}
                  className={cn(fieldCls, 'mt-2')}
                />
                {tagFocused && (canCreateTag || matchingTags.length > 0) && (
                  <div className="mt-1 rounded-[8px] bg-surface p-1 shadow-hard">
                    {canCreateTag && (
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={addTag}
                        className="tap flex h-10 w-full items-center gap-2 rounded-[6px] px-2 text-left text-xs text-accent hover:bg-surface-2"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span className="truncate">{t('tasks.createTag', { name: tagQuery.trim() })}</span>
                      </button>
                    )}
                    {matchingTags.map((tag) => (
                      <button
                        type="button"
                        key={tag.id}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setTagIds((ids) => new Set(ids).add(tag.id))
                          setTagQuery('')
                          setTagFocused(false)
                        }}
                        className="tap flex h-10 w-full items-center rounded-[6px] px-2 text-left text-xs hover:bg-surface-2"
                      >
                        <span className="truncate" title={tag.name}>
                          {tag.name}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className={panel}>
                <h3 className="text-xs font-medium text-text">{t('task.blockers')}</h3>
                <div className="mt-2 space-y-1">
                  {tasks
                    .filter((task) => blockerIds.has(task.id))
                    .map((task) => (
                      <button
                        type="button"
                        key={task.id}
                        onClick={() => setBlockerIds((ids) => new Set([...ids].filter((id) => id !== task.id)))}
                        className="tap flex min-h-10 w-full items-center gap-2 rounded-[var(--radius)] px-2 text-left text-xs hover:bg-surface-2"
                      >
                        <span className="nums shrink-0 text-muted">{task.taskKey}</span>
                        <span className="min-w-0 flex-1 truncate">{task.title}</span>
                        <X className="h-3 w-3 shrink-0" />
                      </button>
                    ))}
                </div>
                <input
                  value={blockerQuery}
                  onChange={(event) => setBlockerQuery(event.target.value)}
                  onFocus={() => setBlockerFocused(true)}
                  onBlur={() => setBlockerFocused(false)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addFirstBlocker()
                    }
                  }}
                  placeholder={t('tasks.searchBlockers')}
                  className={cn(fieldCls, 'mt-2')}
                />
                {blockerFocused && matchingBlockers.length > 0 && (
                  <div className="mt-1 rounded-[8px] bg-surface p-1 shadow-hard">
                    {matchingBlockers.map((task) => (
                      <button
                        type="button"
                        key={task.id}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setBlockerIds((ids) => new Set(ids).add(task.id))
                          setBlockerQuery('')
                          setBlockerFocused(false)
                        }}
                        className="tap flex h-10 w-full items-center gap-2 rounded-[6px] px-2 text-left text-xs hover:bg-surface-2"
                      >
                        <span className="nums w-16 shrink-0 text-muted">{task.taskKey}</span>
                        <span className="min-w-0 flex-1 truncate">{task.title}</span>
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-muted">{t('task.blockerAutomation')}</p>
              </section>
            </aside>
          </div>
        </div>

        <div className="flex min-h-16 items-center justify-end gap-2 border-t border-border px-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={!title.trim() || create.isPending}>
            <Plus className="h-4 w-4" />
            {t('tasks.create')}
          </Button>
        </div>
      </form>
    </div>
  )
}
