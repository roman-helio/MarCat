import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  CalendarDays,
  Eye,
  EyeOff,
  KanbanSquare,
  LayoutList,
  Maximize2,
  Minimize2,
  Network,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { useCompanion } from '@/store/companion'
import { confirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Toggle'
import { TaskListView } from '@/components/tasks/TaskListView'
import { TaskBoard } from '@/components/tasks/TaskBoard'
import { TaskGraph } from '@/components/tasks/TaskGraph'
import { TaskCalendarView } from '@/components/tasks/TaskCalendarView'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { TaskDrawer } from '@/components/tasks/TaskDrawer'
import { TaskCreateDrawer } from '@/components/tasks/TaskCreateDrawer'
import { TaskTagManager } from '@/components/tasks/TaskTagManager'
import { PRIORITY_ORDER, STATUS_ORDER, type TaskPriority, type TaskStatus } from '@/components/tasks/meta'
import { sortTasks, type SortDirection, type TaskSortKey } from '@/components/tasks/taskSort'
import { useT } from '@/i18n/useT'

type TaskView = 'list' | 'board' | 'graph' | 'calendar'

interface TaskViewPreferences {
  view: TaskView
  query: string
  sortKey: TaskSortKey
  sortDirection: SortDirection
  hideCompleted: boolean
  activeTag: string | null
  collapsedDependencyIds: string[]
}

const defaultPreferences: TaskViewPreferences = {
  view: 'list',
  query: '',
  sortKey: 'manual',
  sortDirection: 'asc',
  hideCompleted: false,
  activeTag: null,
  collapsedDependencyIds: [],
}

function readPreferences(gameId?: string): TaskViewPreferences {
  if (!gameId) return defaultPreferences
  try {
    const stored = JSON.parse(
      localStorage.getItem(`marcat:task-view:${gameId}`) ?? '{}',
    ) as Partial<TaskViewPreferences>
    return {
      ...defaultPreferences,
      ...stored,
      view: ['list', 'board', 'graph', 'calendar'].includes(stored.view ?? '')
        ? (stored.view as TaskView)
        : defaultPreferences.view,
      collapsedDependencyIds: Array.isArray(stored.collapsedDependencyIds)
        ? stored.collapsedDependencyIds.filter((id): id is string => typeof id === 'string')
        : [],
    }
  } catch {
    return defaultPreferences
  }
}

export function Tasks() {
  const t = useT()
  const { gameId } = useParams<{ gameId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const setCurrentGame = useUi((s) => s.setCurrentGame)
  const react = useCompanion((s) => s.react)
  const qc = useQueryClient()
  const initialPreferences = useRef(readPreferences(gameId))
  const [view, setView] = useState<TaskView>(initialPreferences.current.view)
  const [query, setQuery] = useState(initialPreferences.current.query)
  const [sortKey, setSortKey] = useState<TaskSortKey>(initialPreferences.current.sortKey)
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialPreferences.current.sortDirection)
  const [hideCompleted, setHideCompleted] = useState(initialPreferences.current.hideCompleted)
  const [collapsedDependencyIds, setCollapsedDependencyIds] = useState<Set<string>>(
    () => new Set(initialPreferences.current.collapsedDependencyIds),
  )
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => searchParams.get('task'))
  const [linkError, setLinkError] = useState<string | null>(null)
  const [activeTag, setActiveTag] = useState<string | null>(
    () => searchParams.get('tag') ?? initialPreferences.current.activeTag,
  )
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [editTag, setEditTag] = useState<string | null>(null)
  const [tagMsg, setTagMsg] = useState<string | null>(null)
  const skipPreferenceWrite = useRef(true)

  useEffect(() => {
    const stored = readPreferences(gameId)
    skipPreferenceWrite.current = true
    setView(stored.view)
    setQuery(stored.query)
    setSortKey(stored.sortKey)
    setSortDirection(stored.sortDirection)
    setHideCompleted(stored.hideCompleted)
    setActiveTag(stored.activeTag)
    setCollapsedDependencyIds(new Set(stored.collapsedDependencyIds))
  }, [gameId])

  useEffect(() => {
    if (!gameId) return
    if (skipPreferenceWrite.current) {
      skipPreferenceWrite.current = false
      return
    }
    const preferences: TaskViewPreferences = {
      view,
      query,
      sortKey,
      sortDirection,
      hideCompleted,
      activeTag,
      collapsedDependencyIds: [...collapsedDependencyIds],
    }
    localStorage.setItem(`marcat:task-view:${gameId}`, JSON.stringify(preferences))
  }, [activeTag, collapsedDependencyIds, gameId, hideCompleted, query, sortDirection, sortKey, view])

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
  }, [gameId, setCurrentGame])

  useEffect(() => {
    const linkedTask = searchParams.get('task')
    if (linkedTask) setSelected(linkedTask)
    const linkedTag = searchParams.get('tag')
    if (linkedTag) setActiveTag(linkedTag)
  }, [searchParams])

  const openTask = (id: string) => {
    setSelected(id)
    const next = new URLSearchParams(searchParams)
    next.set('task', id)
    setSearchParams(next, { replace: true })
  }
  const closeTask = () => {
    setSelected(null)
    const next = new URLSearchParams(searchParams)
    next.delete('task')
    setSearchParams(next, { replace: true })
  }
  const changeActiveTag = (id: string | null) => {
    setActiveTag(id)
    const next = new URLSearchParams(searchParams)
    if (id) next.set('tag', id)
    else next.delete('tag')
    setSearchParams(next, { replace: true })
  }

  const tasks = useQuery({
    queryKey: ['tasks', gameId],
    queryFn: () => trpc.tasks.list.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const gameTags = useQuery({
    queryKey: ['tags-status', gameId],
    queryFn: () => trpc.tags.withStatus.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const runs = useQuery({
    queryKey: ['ai-runs', gameId],
    queryFn: () => trpc.ai.listRuns.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  // Only runs that actually have changes awaiting review — not chat-only replies.
  const pendingProposals = (runs.data ?? []).filter((r) => r.status === 'proposed' && r.pendingChanges > 0)
  const deps = useQuery({
    queryKey: ['task-deps', gameId],
    queryFn: () => trpc.tasks.listDependencies.query({ gameId: gameId! }),
    enabled: !!gameId && (view === 'graph' || view === 'list'),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['tasks', gameId] })
    qc.invalidateQueries({ queryKey: ['tags', gameId] })
    qc.invalidateQueries({ queryKey: ['tags-status', gameId] })
  }
  const clearSel = () => setPicked(new Set())
  const toggleSel = (id: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const move = useMutation({
    mutationFn: (v: { id: string; status: TaskStatus }) =>
      trpc.tasks.update.mutate({ id: v.id, patch: { status: v.status } }),
    onSuccess: (_r, v) => {
      invalidate()
      if (v.status === 'done') react('taskDone')
    },
  })
  const invalidateDeps = () => qc.invalidateQueries({ queryKey: ['task-deps', gameId] })
  const addDep = useMutation({
    mutationFn: (v: { blockerTaskId: string; blockedTaskId: string }) => trpc.tasks.addDependency.mutate(v),
    onSuccess: () => {
      setLinkError(null)
      invalidateDeps()
      qc.invalidateQueries({ queryKey: ['tasks', gameId] })
    },
    onError: () => setLinkError(t('task.cycleError')),
  })
  const removeDep = useMutation({
    mutationFn: (id: string) => trpc.tasks.removeDependency.mutate({ id }),
    onSuccess: () => {
      invalidateDeps()
      qc.invalidateQueries({ queryKey: ['tasks', gameId] })
    },
  })

  // bulk task ops
  const afterBulk = () => {
    invalidate()
    clearSel()
  }
  const bulkUpdate = useMutation({
    mutationFn: (v: { ids: string[]; patch: { status?: TaskStatus; priority?: TaskPriority } }) =>
      trpc.tasks.bulkUpdate.mutate(v),
    onSuccess: afterBulk,
  })
  const bulkRemove = useMutation({
    mutationFn: (ids: string[]) => trpc.tasks.bulkRemove.mutate({ ids }),
    onSuccess: afterBulk,
  })
  const bulkAssign = useMutation({
    mutationFn: (v: { ids: string[]; tagId: string }) => trpc.tasks.bulkAssignTag.mutate(v),
    onSuccess: afterBulk,
  })
  const bulkUnassign = useMutation({
    mutationFn: (v: { ids: string[]; tagId: string }) => trpc.tasks.bulkUnassignTag.mutate(v),
    onSuccess: afterBulk,
  })

  // tag editing
  const updateTag = useMutation({
    mutationFn: (v: {
      id: string
      patch: { name?: string; color?: string; colorEnabled?: boolean; targetDate?: string | null }
    }) => trpc.tags.update.mutate(v),
    onSuccess: (res) => {
      invalidate()
      setTagMsg(res && res.shiftedTasks > 0 ? t('home.shifted', { n: res.shiftedTasks }) : null)
    },
  })
  const removeTag = useMutation({
    mutationFn: (id: string) => trpc.tags.remove.mutate({ id }),
    onSuccess: () => {
      setEditTag(null)
      changeActiveTag(null)
      invalidate()
    },
    onError: toast.fromError,
  })
  const askRemoveTag = (id: string, name: string) =>
    void confirm({ title: t('common.deleteQ', { name }), danger: true, confirmLabel: t('common.delete') }).then(
      (ok) => ok && removeTag.mutate(id),
    )
  const askBulkDelete = () =>
    void confirm({
      title: t('tasks.confirmDelete', { n: picked.size }),
      danger: true,
      confirmLabel: t('common.delete'),
    }).then((ok) => ok && bulkRemove.mutate([...picked]))

  if (!gameId) return null

  const allTasks = tasks.data ?? []
  const allTags = gameTags.data ?? []
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = allTasks.filter((task) => {
    if (hideCompleted && (task.status === 'done' || task.status === 'cancelled')) return false
    if (activeTag && !task.tags.some((tag) => tag.id === activeTag)) return false
    if (!normalizedQuery) return true
    return [task.taskKey, task.title, task.description].some((value) =>
      value?.toLocaleLowerCase().includes(normalizedQuery),
    )
  })
  const shown = sortTasks(filtered, sortKey, sortDirection)
  const shownIds = new Set(shown.map((task) => task.id))
  const dependencyParentIds = new Set(
    (deps.data ?? [])
      .filter((dependency) => shownIds.has(dependency.blockerTaskId))
      .map((dependency) => dependency.blockerTaskId),
  )
  const dependenciesCollapsed =
    dependencyParentIds.size > 0 && [...dependencyParentIds].every((id) => collapsedDependencyIds.has(id))
  const ids = [...picked]
  const editing = allTags.find((tg) => tg.id === editTag) ?? null
  const changeSort = (key: TaskSortKey) => {
    if (sortKey === key) setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDirection('asc')
    }
  }

  return (
    <div className="enter-stagger space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-[12px] bg-surface p-2 shadow-hard">
        <h1 className="t-title px-1">{t('tasks.title')}</h1>
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('tasks.searchPlaceholder')}
            aria-label={t('common.search')}
            className={cn(fieldCls, 'bg-surface-2/50 pl-9 pr-9')}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="tap absolute right-0 top-0 inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted hover:text-text"
              aria-label={t('common.clear')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex h-10 shrink-0 items-center rounded-[10px] bg-surface-2/70 p-0.5 shadow-hard">
          <label
            className={cn(
              'tap inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-[8px] text-muted hover:bg-surface hover:text-text',
              hideCompleted && 'bg-surface text-accent shadow-hard',
            )}
            title={t('tasks.hideCompleted')}
          >
            <input
              type="checkbox"
              checked={hideCompleted}
              onChange={(event) => setHideCompleted(event.target.checked)}
              className="sr-only"
            />
            {hideCompleted ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            <span className="sr-only">{t('tasks.hideCompleted')}</span>
          </label>
          {view === 'list' && (
            <button
              type="button"
              onClick={() => setCollapsedDependencyIds(dependenciesCollapsed ? new Set() : dependencyParentIds)}
              className={cn(
                'tap inline-flex h-9 w-9 items-center justify-center rounded-[8px] text-muted hover:bg-surface hover:text-text',
                dependenciesCollapsed && 'bg-surface text-accent shadow-hard',
              )}
              title={dependenciesCollapsed ? t('tasks.expandAllDependencies') : t('tasks.collapseAllDependencies')}
              aria-label={dependenciesCollapsed ? t('tasks.expandAllDependencies') : t('tasks.collapseAllDependencies')}
              aria-pressed={dependenciesCollapsed}
            >
              <span className="relative h-4 w-4" aria-hidden>
                <Maximize2
                  className={cn(
                    'absolute inset-0 h-4 w-4 transition-[opacity,filter,scale] duration-300 [transition-timing-function:cubic-bezier(0.2,0,0,1)]',
                    dependenciesCollapsed ? 'scale-100 opacity-100 blur-0' : 'scale-[0.25] opacity-0 blur-[4px]',
                  )}
                />
                <Minimize2
                  className={cn(
                    'absolute inset-0 h-4 w-4 transition-[opacity,filter,scale] duration-300 [transition-timing-function:cubic-bezier(0.2,0,0,1)]',
                    dependenciesCollapsed ? 'scale-[0.25] opacity-0 blur-[4px]' : 'scale-100 opacity-100 blur-0',
                  )}
                />
              </span>
            </button>
          )}
        </div>
        <Segmented
          ariaLabel={t('tasks.title')}
          value={view}
          onChange={setView}
          items={[
            { value: 'list', icon: <LayoutList className="h-4 w-4" />, title: t('tasks.viewList') },
            { value: 'board', icon: <KanbanSquare className="h-4 w-4" />, title: t('tasks.viewBoard') },
            { value: 'graph', icon: <Network className="h-4 w-4" />, title: t('tasks.viewGraph') },
            { value: 'calendar', icon: <CalendarDays className="h-4 w-4" />, title: t('nav.calendar') },
          ]}
        />
        {view === 'board' && (
          <div className="flex items-center gap-1">
            <select
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as TaskSortKey)}
              className={cn(fieldCls, 'w-36')}
              aria-label={t('tasks.sort')}
            >
              <option value="manual">{t('tasks.sortManual')}</option>
              <option value="key">{t('tasks.sortKey')}</option>
              <option value="title">{t('tasks.sortTitle')}</option>
              <option value="status">{t('task.status')}</option>
              <option value="priority">{t('task.priority')}</option>
              <option value="tags">{t('task.tags')}</option>
              <option value="startDate">{t('task.start')}</option>
              <option value="dueDate">{t('task.due')}</option>
              <option value="createdAt">{t('tasks.sortCreated')}</option>
              <option value="updatedAt">{t('tasks.sortUpdated')}</option>
            </select>
            <button
              type="button"
              onClick={() => setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'))}
              className="tap inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text"
              aria-label={sortDirection === 'asc' ? t('tasks.sortAscending') : t('tasks.sortDescending')}
            >
              <ArrowDown
                className={cn(
                  'h-4 w-4 transition-transform duration-150 ease-out',
                  sortDirection === 'asc' && 'rotate-180',
                )}
              />
            </button>
          </div>
        )}
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          {t('tasks.newTask')}
        </Button>
      </div>

      {pendingProposals.length > 0 && (
        <Link
          to={`/g/${gameId}/ai`}
          className="hoverlift flex items-center gap-2 rounded-[var(--radius)] border border-accent/40 bg-accent/5 px-3 py-2 text-sm text-text hover:bg-accent/10"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-accent" />
          <span className="flex-1 nums">{t('tasks.proposalBanner', { n: pendingProposals.length })}</span>
          <span className="shrink-0 t-hint text-accent">{t('tasks.proposalOpen')}</span>
        </Link>
      )}

      {allTags.length > 0 && (
        <TaskTagManager
          tags={allTags}
          activeTag={activeTag}
          onChange={changeActiveTag}
          onEdit={(id) => setEditTag(id)}
        />
      )}

      {editing && (
        <div className="flex flex-wrap items-end gap-2 rounded-[12px] bg-surface p-3 shadow-hard">
          <label className="grid gap-1 t-hint">
            {t('tags.name')}
            <input
              defaultValue={editing.name}
              onBlur={(e) =>
                e.target.value.trim() &&
                e.target.value !== editing.name &&
                updateTag.mutate({ id: editing.id, patch: { name: e.target.value.trim() } })
              }
              className={cn(fieldCls, 'w-40')}
            />
          </label>
          <label className="grid gap-1 t-hint">
            {t('tags.color')}
            <input
              type="color"
              defaultValue={editing.color}
              disabled={!editing.colorEnabled}
              onBlur={(e) =>
                e.target.value !== editing.color &&
                updateTag.mutate({ id: editing.id, patch: { color: e.target.value } })
              }
              className="h-10 w-12 rounded-[var(--radius)] border border-border bg-surface disabled:cursor-not-allowed disabled:opacity-35"
            />
          </label>
          <label className="flex h-10 cursor-pointer items-center gap-2 rounded-[var(--radius)] px-2.5 text-sm text-text hover:bg-surface-2">
            <input
              type="checkbox"
              checked={editing.colorEnabled}
              onChange={(event) => updateTag.mutate({ id: editing.id, patch: { colorEnabled: event.target.checked } })}
              className="accent-accent"
            />
            {t('tags.highlight')}
          </label>
          <label className="grid gap-1 t-hint">
            {t('tags.deadline')}
            <input
              type="date"
              defaultValue={editing.targetDate ?? ''}
              onChange={(e) => updateTag.mutate({ id: editing.id, patch: { targetDate: e.target.value || null } })}
              className={cn(fieldCls, 'w-40')}
            />
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => askRemoveTag(editing.id, editing.name)}
            disabled={removeTag.isPending}
          >
            <Trash2 className="h-4 w-4 text-alarm" />
            {t('tags.delete')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditTag(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
      {tagMsg && <p className="text-xs text-accent">{tagMsg}</p>}

      {/* bulk action bar */}
      {picked.size > 0 && view === 'list' && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
          <span className="t-hint text-accent nums">{t('tasks.selected', { n: picked.size })}</span>
          <select
            className={cn(fieldCls, 'h-8 w-32')}
            value=""
            onChange={(e) =>
              e.target.value && bulkUpdate.mutate({ ids, patch: { status: e.target.value as TaskStatus } })
            }
          >
            <option value="">{t('task.status')}…</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </select>
          <select
            className={cn(fieldCls, 'h-8 w-28')}
            value=""
            onChange={(e) =>
              e.target.value && bulkUpdate.mutate({ ids, patch: { priority: e.target.value as TaskPriority } })
            }
          >
            <option value="">{t('task.priority')}…</option>
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {t(`prio.${p}`)}
              </option>
            ))}
          </select>
          <select
            className={cn(fieldCls, 'h-8 w-32')}
            value=""
            onChange={(e) => e.target.value && bulkAssign.mutate({ ids, tagId: e.target.value })}
          >
            <option value="">+ {t('task.tags')}</option>
            {allTags.map((tg) => (
              <option key={tg.id} value={tg.id}>
                {tg.name}
              </option>
            ))}
          </select>
          {activeTag && (
            <Button size="sm" variant="outline" onClick={() => bulkUnassign.mutate({ ids, tagId: activeTag })}>
              {t('tasks.removeFromTag')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={askBulkDelete} disabled={bulkRemove.isPending}>
            <Trash2 className="h-4 w-4 text-alarm" />
            {t('task.delete')}
          </Button>
          <button
            onClick={clearSel}
            className="tap ml-auto inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text"
            aria-label={t('common.clear')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {(tasks.isError || gameTags.isError || ((view === 'graph' || view === 'list') && deps.isError)) && (
        <QueryError
          error={tasks.error ?? gameTags.error ?? deps.error}
          onRetry={() => {
            void tasks.refetch()
            void gameTags.refetch()
            void deps.refetch()
          }}
        />
      )}
      {(tasks.isLoading || gameTags.isLoading || ((view === 'graph' || view === 'list') && deps.isLoading)) && (
        <LoadingState />
      )}
      {tasks.data && tasks.data.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-[var(--radius)] border border-dashed border-border py-16 text-center">
          <div className="font-mono text-2xl text-accent">=^•ω•^=</div>
          <p className="text-sm text-muted">{t('tasks.empty')}</p>
        </div>
      )}

      {tasks.data && tasks.data.length > 0 && shown.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-[12px] bg-surface py-12 text-center shadow-hard">
          <Search className="h-5 w-5 text-muted" />
          <p className="text-sm text-muted">{t('tasks.noResults')}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQuery('')
              changeActiveTag(null)
              setHideCompleted(false)
            }}
          >
            {t('tasks.clearFilters')}
          </Button>
        </div>
      )}

      {shown.length > 0 && view === 'list' && deps.isSuccess && (
        <TaskListView
          tasks={shown}
          dependencies={deps.data}
          onSelect={openTask}
          selectedIds={picked}
          onToggleSelect={toggleSel}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSort={changeSort}
          collapsedIds={collapsedDependencyIds}
          onCollapsedIdsChange={setCollapsedDependencyIds}
        />
      )}
      {shown.length > 0 && view === 'board' && (
        <TaskBoard tasks={shown} onSelect={openTask} onMove={(id, status) => move.mutate({ id, status })} />
      )}
      {shown.length > 0 && view === 'graph' && deps.isSuccess && (
        <div className="space-y-2">
          <p className="text-xs text-muted">{t('tasks.graphHint')}</p>
          {linkError && <p className="text-xs text-alarm">{linkError}</p>}
          <TaskGraph
            tasks={shown}
            deps={deps.data}
            onSelect={openTask}
            onConnect={(blockerTaskId, blockedTaskId) => addDep.mutate({ blockerTaskId, blockedTaskId })}
            onRemoveEdge={(id) => removeDep.mutate(id)}
          />
        </div>
      )}
      {shown.length > 0 && view === 'calendar' && (
        <TaskCalendarView tasks={shown} tags={allTags} onSelect={openTask} onChanged={invalidate} />
      )}

      {selected && <TaskDrawer taskId={selected} gameId={gameId} onClose={closeTask} />}
      {creating && (
        <TaskCreateDrawer
          gameId={gameId}
          tasks={allTasks}
          tags={allTags}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            invalidate()
            openTask(id)
          }}
        />
      )}
    </div>
  )
}
