import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Check, Eye, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { isOverdue } from '@/lib/date'
import { useModal } from '@/lib/modal'
import { useUi } from '@/store/ui'
import { confirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { RichText } from '@/components/ui/RichText'
import { ColorSelect } from '@/components/ui/ColorSelect'
import { useT } from '@/i18n/useT'
import { ActivityLog } from '@/components/activities/ActivityLog'
import { PRIORITY_META, PRIORITY_ORDER, STATUS_META, STATUS_ORDER, type TaskPatch } from './meta'
import { smartMatches } from './smartSearch'
import { TaskRecurrenceControl } from './TaskRecurrenceControl'

const sectionLabel = 't-hint font-medium text-text'
const panel = 'rounded-[12px] bg-bg/55 p-3 shadow-hard'

export function TaskDrawer({ taskId, gameId, onClose }: { taskId: string; gameId: string; onClose: () => void }) {
  const t = useT()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const setSeedPrompt = useUi((state) => state.setSeedPrompt)
  const panelRef = useRef<HTMLDivElement>(null)
  useModal(panelRef, onClose)
  const [newItem, setNewItem] = useState('')
  const [newTag, setNewTag] = useState('')
  const [tagFocused, setTagFocused] = useState(false)
  const [blockerQuery, setBlockerQuery] = useState('')
  const [blockerFocused, setBlockerFocused] = useState(false)
  const [depError, setDepError] = useState<string | null>(null)
  const [descriptionEditing, setDescriptionEditing] = useState(false)

  useEffect(() => setDescriptionEditing(false), [taskId])

  const detail = useQuery({ queryKey: ['task', taskId], queryFn: () => trpc.tasks.get.query({ id: taskId }) })
  const allTasks = useQuery({ queryKey: ['tasks', gameId], queryFn: () => trpc.tasks.list.query({ gameId }) })
  const gameTags = useQuery({
    queryKey: ['tags-status', gameId],
    queryFn: () => trpc.tags.withStatus.query({ gameId }),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['task', taskId] })
    qc.invalidateQueries({ queryKey: ['tasks', gameId] })
    qc.invalidateQueries({ queryKey: ['task-deps', gameId] })
    qc.invalidateQueries({ queryKey: ['tags-status', gameId] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
    qc.invalidateQueries({ queryKey: ['creator-tasks', gameId] })
  }
  const update = useMutation({
    mutationFn: (patch: TaskPatch) => trpc.tasks.update.mutate({ id: taskId, patch }),
    onSuccess: invalidate,
  })
  const addCheck = useMutation({
    mutationFn: (text: string) => trpc.tasks.addChecklistItem.mutate({ taskId, text }),
    onSuccess: () => {
      setNewItem('')
      invalidate()
    },
  })
  const toggleCheck = useMutation({
    mutationFn: (value: { id: string; done: boolean }) => trpc.tasks.toggleChecklistItem.mutate(value),
    onSuccess: invalidate,
  })
  const removeCheck = useMutation({
    mutationFn: (id: string) => trpc.tasks.removeChecklistItem.mutate({ id }),
    onSuccess: invalidate,
  })
  const reorderCheck = useMutation({
    mutationFn: (orderedIds: string[]) => trpc.tasks.reorderChecklist.mutate({ taskId, orderedIds }),
    onSuccess: invalidate,
  })
  const addDep = useMutation({
    mutationFn: (blockerTaskId: string) => trpc.tasks.addDependency.mutate({ blockerTaskId, blockedTaskId: taskId }),
    onSuccess: () => {
      setDepError(null)
      invalidate()
    },
    onError: () => setDepError(t('task.cycleError')),
  })
  const removeDep = useMutation({
    mutationFn: (id: string) => trpc.tasks.removeDependency.mutate({ id }),
    onSuccess: invalidate,
  })
  const assignTag = useMutation({
    mutationFn: (tagId: string) => trpc.tasks.assignTag.mutate({ taskId, tagId }),
    onSuccess: () => {
      setNewTag('')
      invalidate()
    },
  })
  const createTag = useMutation({
    mutationFn: (name: string) => trpc.tags.create.mutate({ gameId, name }),
    onSuccess: (tag) => {
      qc.invalidateQueries({ queryKey: ['tags', gameId] })
      qc.invalidateQueries({ queryKey: ['tags-status', gameId] })
      if (tag) assignTag.mutate(tag.id)
    },
  })
  const unassignTag = useMutation({
    mutationFn: (tagId: string) => trpc.tasks.unassignTag.mutate({ taskId, tagId }),
    onSuccess: invalidate,
  })
  const removeTask = useMutation({
    mutationFn: () => trpc.tasks.remove.mutate({ id: taskId }),
    onSuccess: () => {
      invalidate()
      onClose()
    },
    onError: toast.fromError,
  })

  const task = detail.data?.task
  const checklist = detail.data?.checklist ?? []
  const checklistDone = checklist.filter((item) => item.done).length
  const titleById = new Map((allTasks.data ?? []).map((item) => [item.id, item.title]))
  const statusById = new Map((allTasks.data ?? []).map((item) => [item.id, item.status]))
  const candidates = (allTasks.data ?? []).filter(
    (item) => item.id !== taskId && !(detail.data?.blockedBy ?? []).some((dep) => dep.blockerTaskId === item.id),
  )
  const assignedTagIds = new Set((detail.data?.tags ?? []).map((tag) => tag.id))
  const tagSuggestions = smartMatches(
    (gameTags.data ?? []).filter((tag) => !assignedTagIds.has(tag.id)),
    newTag,
    (tag) => [tag.name],
  ).slice(0, 6)
  const exactAvailableTag = (gameTags.data ?? []).find(
    (tag) => tag.name.toLocaleLowerCase() === newTag.trim().toLocaleLowerCase(),
  )
  const canCreateTag = !!newTag.trim() && !exactAvailableTag
  const blockerSuggestions = smartMatches(candidates, blockerQuery, (candidate) => [
    candidate.taskKey ?? '',
    candidate.title,
    candidate.description,
  ]).slice(0, 8)

  const askDeleteTask = () =>
    void confirm({
      title: t('task.deleteTitle'),
      body: t('task.deleteBody', { name: task?.title ?? '' }),
      danger: true,
      confirmLabel: t('common.delete'),
    }).then((ok) => ok && removeTask.mutate())

  const addTagByName = (raw: string) => {
    const name = raw.trim()
    if (!name) return
    const existing = (gameTags.data ?? []).find((tag) => tag.name.toLowerCase() === name.toLowerCase())
    if (existing) assignTag.mutate(existing.id)
    else createTag.mutate(name)
    setTagFocused(false)
  }

  const addFirstBlocker = () => {
    const first = blockerSuggestions[0]
    if (!first) return
    addDep.mutate(first.id)
    setBlockerQuery('')
    setBlockerFocused(false)
  }

  const move = (index: number, direction: -1 | 1) => {
    const ids = checklist.map((item) => item.id)
    const destination = index + direction
    if (destination < 0 || destination >= ids.length) return
    ;[ids[index], ids[destination]] = [ids[destination]!, ids[index]!]
    reorderCheck.mutate(ids)
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className="enter flex h-full w-[min(800px,100vw)] flex-col overflow-hidden border-l border-border bg-surface shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-border px-4">
          <span className="nums text-xs text-muted">{task?.taskKey ?? t('task.title')}</span>
          {task && (
            <span className={cn('rounded-[5px] px-1.5 py-0.5 text-[11px]', STATUS_META[task.status].badge)}>
              {t(`status.${task.status}`)}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{task?.title}</span>
          <button
            onClick={onClose}
            className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!task ? (
          <p className="p-4 text-sm text-muted">{t('common.loading')}</p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <p className="nums mb-1 text-xs font-medium text-accent">{task.taskKey}</p>
            <input
              key={task.id}
              defaultValue={task.title}
              onBlur={(event) => {
                const value = event.target.value.trim()
                if (value && value !== task.title) update.mutate({ title: value })
              }}
              className="mb-4 w-full bg-transparent text-xl font-medium leading-snug text-text outline-none focus-visible:ring-0"
              aria-label={t('task.title')}
            />

            <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_272px]">
              <main className="min-w-0 space-y-4">
                <section className={cn(panel, 'min-w-0 overflow-hidden')}>
                  <div className="flex h-10 items-center justify-between gap-2">
                    <h2 className={sectionLabel}>{t('task.description')}</h2>
                    <button
                      type="button"
                      onClick={() => setDescriptionEditing((value) => !value)}
                      className="tap inline-flex h-10 items-center gap-1.5 rounded-[8px] px-2 text-xs text-muted hover:bg-surface-2 hover:text-text"
                      aria-label={descriptionEditing ? t('common.preview') : t('common.edit')}
                      title={descriptionEditing ? t('common.preview') : t('common.edit')}
                    >
                      {descriptionEditing ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                      <span>{descriptionEditing ? t('common.preview') : t('common.edit')}</span>
                    </button>
                  </div>
                  <div className="mt-2 min-w-0 max-w-full overflow-hidden">
                    <RichText
                      key={task.id}
                      value={task.description}
                      onCommit={(markdown) => markdown !== task.description && update.mutate({ description: markdown })}
                      editing={descriptionEditing}
                      onEditingChange={setDescriptionEditing}
                      showModeToggle={false}
                    />
                  </div>
                </section>

                <section className={panel}>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className={sectionLabel}>{t('task.checklist')}</h2>
                    <span className="nums text-xs text-muted">
                      {checklistDone}/{checklist.length}
                    </span>
                  </div>
                  <div className="mt-2 space-y-0.5">
                    {checklist.map((item, index) => (
                      <div key={item.id} className="group/check flex min-h-9 items-center gap-2 text-sm">
                        <label className="inline-flex h-9 w-7 shrink-0 cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            checked={item.done}
                            onChange={(event) => toggleCheck.mutate({ id: item.id, done: event.target.checked })}
                            className="accent-accent"
                          />
                        </label>
                        <span className={cn('min-w-0 flex-1 text-pretty', item.done && 'text-muted line-through')}>
                          {item.text}
                        </span>
                        <span className="flex opacity-0 transition-opacity duration-150 ease-out group-hover/check:opacity-100 focus-within:opacity-100">
                          <button
                            onClick={() => move(index, -1)}
                            disabled={index === 0}
                            className="tap inline-flex h-9 w-8 items-center justify-center rounded-[6px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-25"
                            aria-label={t('task.moveUp')}
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => move(index, 1)}
                            disabled={index === checklist.length - 1}
                            className="tap inline-flex h-9 w-8 items-center justify-center rounded-[6px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-25"
                            aria-label={t('task.moveDown')}
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => removeCheck.mutate(item.id)}
                            className="tap inline-flex h-9 w-8 items-center justify-center rounded-[6px] text-muted hover:bg-surface-2 hover:text-alarm"
                            aria-label={t('common.delete')}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <input
                        value={newItem}
                        onChange={(event) => setNewItem(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && newItem.trim()) addCheck.mutate(newItem.trim())
                        }}
                        placeholder={t('task.addItem')}
                        className={fieldCls}
                      />
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => newItem.trim() && addCheck.mutate(newItem.trim())}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </section>

                <section className={panel}>
                  <ActivityLog gameId={gameId} subjectType="task" subjectId={taskId} />
                </section>
              </main>

              <aside className="space-y-3 md:sticky md:top-0">
                <section className={panel}>
                  <div className="grid gap-3">
                    <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,.85fr)] gap-2">
                      <label className="grid min-w-0 gap-1 t-hint">
                        {t('task.status')}
                        <ColorSelect
                          value={task.status}
                          onChange={(status) => update.mutate({ status })}
                          ariaLabel={t('task.status')}
                          options={STATUS_ORDER.map((status) => ({
                            value: status,
                            label: t(`status.${status}`),
                            tone: STATUS_META[status].badge,
                          }))}
                        />
                      </label>
                      <label className="grid min-w-0 gap-1 t-hint">
                        {t('task.priority')}
                        <ColorSelect
                          value={task.priority}
                          onChange={(priority) => update.mutate({ priority })}
                          ariaLabel={t('task.priority')}
                          options={PRIORITY_ORDER.map((priority) => ({
                            value: priority,
                            label: t(`prio.${priority}`),
                            tone: PRIORITY_META[priority].cls,
                          }))}
                        />
                      </label>
                    </div>
                    <label className="grid min-w-0 gap-1 t-hint">
                      {t('task.start')}
                      <input
                        type="date"
                        className={cn(fieldCls, 'min-w-0')}
                        value={task.startDate ?? ''}
                        onChange={(event) => update.mutate({ startDate: event.target.value || null })}
                      />
                    </label>
                    <label className="grid min-w-0 gap-1 t-hint">
                      {t('task.due')}
                      <input
                        type="date"
                        className={cn(
                          fieldCls,
                          'min-w-0',
                          isOverdue(task.dueDate) && task.status !== 'done' && 'text-alarm',
                        )}
                        value={task.dueDate ?? ''}
                        onChange={(event) => update.mutate({ dueDate: event.target.value || null })}
                      />
                    </label>
                    <div className="border-t border-border pt-2">
                      <TaskRecurrenceControl
                        value={
                          task.recurrenceInterval && task.recurrenceUnit
                            ? { every: task.recurrenceInterval, unit: task.recurrenceUnit }
                            : null
                        }
                        onChange={(recurrence) => update.mutate({ recurrence })}
                      />
                    </div>
                  </div>
                </section>

                <section className={panel}>
                  <h2 className={sectionLabel}>{t('task.tags')}</h2>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(detail.data?.tags ?? []).map((tag) => (
                      <span
                        key={tag.id}
                        className={cn(
                          'inline-flex items-center rounded-[6px] pl-1.5 text-[11px]',
                          !tag.colorEnabled && 'bg-surface-2 text-muted',
                        )}
                        style={tag.colorEnabled ? { background: `${tag.color}1f`, color: tag.color } : undefined}
                      >
                        <span className="max-w-40 truncate">{tag.name}</span>
                        <button
                          onClick={() => unassignTag.mutate(tag.id)}
                          aria-label={t('common.remove')}
                          className="tap inline-flex h-8 w-8 items-center justify-center rounded-[5px] hover:bg-black/10"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <input
                    value={newTag}
                    onChange={(event) => setNewTag(event.target.value)}
                    onFocus={() => setTagFocused(true)}
                    onBlur={() => setTagFocused(false)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        addTagByName(newTag)
                      }
                    }}
                    placeholder={t('task.addTag')}
                    className={cn(fieldCls, 'mt-2')}
                  />
                  {tagFocused && (canCreateTag || tagSuggestions.length > 0) && (
                    <div className="mt-1 overflow-hidden rounded-[8px] border border-border bg-surface">
                      {canCreateTag && (
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => addTagByName(newTag)}
                          className="tap flex min-h-10 w-full items-center gap-2 px-2.5 text-left text-xs text-accent hover:bg-surface-2"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span className="truncate">{t('tasks.createTag', { name: newTag.trim() })}</span>
                        </button>
                      )}
                      {tagSuggestions.map((tag) => (
                        <button
                          key={tag.id}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            assignTag.mutate(tag.id)
                            setTagFocused(false)
                          }}
                          className="flex min-h-10 w-full items-center gap-2 px-2.5 text-left text-xs hover:bg-surface-2"
                        >
                          <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                          <span className="nums shrink-0 text-[11px] text-muted">
                            {tag.linkedClosed}/{tag.linkedTotal}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {newTag.trim() && <p className="mt-1 text-[11px] text-muted">{t('tasks.tagCreateHint')}</p>}
                </section>

                <section className={panel}>
                  <h2 className={sectionLabel}>{t('task.blockers')}</h2>
                  <div className="mt-1 space-y-0.5">
                    {(detail.data?.blockedBy ?? []).map((dependency) => {
                      const blockerStatus = statusById.get(dependency.blockerTaskId)
                      const done = blockerStatus === 'done' || blockerStatus === 'cancelled'
                      return (
                        <div key={dependency.id} className="flex min-h-9 items-center gap-2 text-xs">
                          {done ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-success" />
                          ) : (
                            <span className="h-3 w-3 shrink-0 rounded-[3px] bg-alarm/15 ring-1 ring-alarm/30" />
                          )}
                          <span className={cn('min-w-0 flex-1 truncate', done && 'text-muted line-through')}>
                            {titleById.get(dependency.blockerTaskId) ?? '—'}
                          </span>
                          <button
                            onClick={() => removeDep.mutate(dependency.id)}
                            className="tap inline-flex h-9 w-8 items-center justify-center rounded-[6px] text-muted hover:bg-surface-2 hover:text-alarm"
                            aria-label={t('common.delete')}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  <div className="relative mt-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
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
                      className={cn(fieldCls, 'pl-8')}
                    />
                  </div>
                  {blockerFocused && blockerSuggestions.length > 0 && (
                    <div className="mt-1 overflow-hidden rounded-[8px] bg-surface p-1 shadow-hard">
                      {blockerSuggestions.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            addDep.mutate(candidate.id)
                            setBlockerQuery('')
                            setBlockerFocused(false)
                          }}
                          className="tap flex h-10 w-full items-center gap-2 rounded-[6px] px-2 text-left text-xs hover:bg-surface-2"
                        >
                          <span className="nums w-16 shrink-0 text-muted">{candidate.taskKey}</span>
                          <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {depError && <p className="mt-1 text-xs text-alarm">{depError}</p>}
                  <p className="mt-2 text-[11px] leading-relaxed text-muted">{t('task.blockerAutomation')}</p>
                  {(detail.data?.blocks ?? []).length > 0 && (
                    <p className="mt-2 text-xs text-muted text-pretty">
                      {t('task.blocks', {
                        list: detail
                          .data!.blocks.map((dependency) => titleById.get(dependency.blockedTaskId) ?? '—')
                          .join(', '),
                      })}
                    </p>
                  )}
                </section>

                <div className="flex items-center justify-between gap-1 pt-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSeedPrompt(
                        `${t('task.title')}: "${task.title}" [${t(`status.${task.status}`)}, ${t(`prio.${task.priority}`)}]${task.dueDate ? `, ${t('task.due')} ${task.dueDate}` : ''}. `,
                      )
                      navigate(`/g/${gameId}/ai`)
                    }}
                  >
                    <Sparkles className="h-4 w-4 text-accent" />
                    {t('ai.askCat')}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={askDeleteTask} disabled={removeTask.isPending}>
                    <Trash2 className="h-4 w-4 text-alarm" />
                  </Button>
                </div>
              </aside>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
