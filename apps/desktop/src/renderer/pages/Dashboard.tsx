import { useEffect, useState, type ComponentType } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarClock,
  CalendarDays,
  CircleCheck,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCcw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { useUi } from '@/store/ui'
import { confirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { cn, fieldCls } from '@/lib/utils'
import { useT } from '@/i18n/useT'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { TaskCard } from '@/components/tasks/TaskCard'
import { TaskDrawer } from '@/components/tasks/TaskDrawer'
import { OFFICIAL_LINK_OPTIONS, type OfficialLink, type OfficialLinkType } from '@/components/games/officialLinks'

const PLATFORMS = [
  { id: 'pc_steam', key: 'plat.pc_steam', placeholder: 'https://store.steampowered.com/app/…' },
  { id: 'pc_web', key: 'plat.pc_web', placeholder: 'https://itch.io/… or web build URL' },
  { id: 'mobile', key: 'plat.mobile', placeholder: 'App Store / Google Play URL' },
  { id: 'console', key: 'plat.console', placeholder: 'console store URL' },
] as const

interface PlatformEntry {
  id: string
  url: string
}
interface GameFormValues {
  name: string
  releaseDate: string
  platforms: PlatformEntry[]
  officialLinks: OfficialLink[]
  key: string
  color: string
}

const emptyForm: GameFormValues = {
  name: '',
  releaseDate: '',
  platforms: [],
  officialLinks: [],
  key: '',
  color: '#ff6a3d',
}

function toInput(values: GameFormValues) {
  const projectKey = values.key.trim()
  return {
    name: values.name.trim(),
    // steamStoreUrl + steamAppId are derived server-side from the pc_steam URL.
    releaseDate: values.releaseDate || null,
    platforms: values.platforms.map((p) => ({ id: p.id, url: p.url.trim() })),
    officialLinks: values.officialLinks
      .map((link) => ({ ...link, url: link.url.trim(), label: link.label?.trim() || undefined }))
      .filter((link) => link.url),
    // One project prefix is used both for MarCat task ids and DevHub project lookup.
    // Blank → server auto-derives (create) or leaves unchanged (update).
    key: projectKey || undefined,
    color: values.color,
  }
}

const labelCls = 'grid gap-1 t-hint'

function GameForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  pending,
  autoFocusLink,
}: {
  initial: GameFormValues
  submitLabel: string
  onSubmit: (values: GameFormValues) => void
  onCancel?: () => void
  pending?: boolean
  autoFocusLink?: OfficialLinkType
}) {
  const t = useT()
  const [values, setValues] = useState(initial)
  const set = (k: keyof GameFormValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }))

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (values.name.trim()) onSubmit(values)
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          {t('form.name')}
          <input className={fieldCls} value={values.name} onChange={set('name')} autoFocus={!autoFocusLink} />
        </label>
        <label className={labelCls}>
          {t('form.releaseDate')}
          <input type="date" className={fieldCls} value={values.releaseDate} onChange={set('releaseDate')} />
        </label>
        <label className={labelCls}>
          {t('form.key')}
          <input
            className={cn(fieldCls, 'uppercase')}
            value={values.key}
            onChange={set('key')}
            placeholder={t('form.keyPh')}
            maxLength={10}
          />
        </label>
        <label className="flex items-center gap-2 t-hint">
          {t('form.color')}
          <input
            type="color"
            className="h-9 w-12 cursor-pointer rounded-[var(--radius)] border border-border bg-bg"
            value={values.color}
            onChange={set('color')}
          />
        </label>
      </div>
      <div className={labelCls}>
        {t('form.platforms')}
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => {
            const on = values.platforms.some((x) => x.id === p.id)
            return (
              <button
                key={p.id}
                type="button"
                onClick={() =>
                  setValues((v) => ({
                    ...v,
                    platforms: on ? v.platforms.filter((x) => x.id !== p.id) : [...v.platforms, { id: p.id, url: '' }],
                  }))
                }
                className={cn(
                  'tap min-h-10 rounded-[var(--radius)] px-3 text-xs shadow-[0_0_0_1px_var(--border)] transition-[scale,background-color,color,box-shadow] duration-150 active:scale-[0.96]',
                  on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-text',
                )}
              >
                {t(p.key)}
              </button>
            )
          })}
        </div>
        {/* one URL field per enabled platform (Steam page, web build, store…). */}
        <div className="mt-1 grid gap-1.5">
          {PLATFORMS.filter((p) => values.platforms.some((x) => x.id === p.id)).map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-muted">{t(p.key)}</span>
              <input
                className={cn(fieldCls, 'flex-1')}
                placeholder={p.placeholder}
                value={values.platforms.find((x) => x.id === p.id)?.url ?? ''}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    platforms: v.platforms.map((x) => (x.id === p.id ? { ...x, url: e.target.value } : x)),
                  }))
                }
              />
            </div>
          ))}
        </div>
      </div>
      <div className={labelCls}>
        {t('form.officialLinks')}
        <p className="text-pretty text-xs text-muted">{t('form.officialLinksHint')}</p>
        <div className="flex flex-wrap gap-2">
          {OFFICIAL_LINK_OPTIONS.map((option) => {
            const on = values.officialLinks.some((link) => link.type === option.type)
            return (
              <button
                key={option.type}
                type="button"
                onClick={() =>
                  setValues((current) => ({
                    ...current,
                    officialLinks: on
                      ? current.officialLinks.filter((link) => link.type !== option.type)
                      : [...current.officialLinks, { type: option.type, url: '' }],
                  }))
                }
                className={cn(
                  'tap min-h-10 rounded-[var(--radius)] px-3 text-xs shadow-[0_0_0_1px_var(--border)] transition-[scale,background-color,color,box-shadow] duration-150 active:scale-[0.96]',
                  on ? 'bg-accent/10 text-accent shadow-[0_0_0_1px_var(--accent)]' : 'text-muted hover:text-text',
                )}
              >
                {t(option.labelKey)}
              </button>
            )
          })}
        </div>
        <div className="mt-1 grid gap-1.5">
          {OFFICIAL_LINK_OPTIONS.filter((option) => values.officialLinks.some((link) => link.type === option.type)).map(
            (option) => {
              const link = values.officialLinks.find((item) => item.type === option.type)
              return (
                <div key={option.type} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  <span className="w-24 shrink-0 text-xs text-muted">{t(option.labelKey)}</span>
                  <input
                    className={cn(fieldCls, 'min-w-0 flex-1')}
                    placeholder={option.placeholder}
                    value={link?.url ?? ''}
                    autoFocus={option.type === autoFocusLink}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        officialLinks: current.officialLinks.map((item) =>
                          item.type === option.type ? { ...item, url: event.target.value } : item,
                        ),
                      }))
                    }
                  />
                  {option.type === 'other' && (
                    <input
                      className={cn(fieldCls, 'w-full sm:w-36')}
                      placeholder={t('form.linkLabel')}
                      value={link?.label ?? ''}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          officialLinks: current.officialLinks.map((item) =>
                            item.type === option.type ? { ...item, label: event.target.value } : item,
                          ),
                        }))
                      }
                    />
                  )}
                </div>
              )
            },
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || !values.name.trim()}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </form>
  )
}

type Overview = Awaited<ReturnType<typeof trpc.dashboard.overview.query>>
type DashboardTask = Overview['tasksOverdue'][number]

type QueueTone = 'alarm' | 'warning' | 'accent' | 'muted'

interface QueueItem {
  key: string
  icon: ComponentType<{ className?: string }>
  title: string
  context: string
  meta: string
  path: string
  tone: QueueTone
  priority: number
  task?: DashboardTask
}

const toneCls: Record<QueueTone, string> = {
  alarm: 'bg-alarm',
  warning: 'bg-warning',
  accent: 'bg-accent',
  muted: 'bg-muted',
}

function DashInsights({
  data,
  onOpen,
  onOpenTask,
}: {
  data: Overview
  onOpen: (path: string) => void
  onOpenTask: (taskId: string, gameId: string) => void
}) {
  const t = useT()
  const rel = (d: number) =>
    d === 0 ? t('dash.today') : d > 0 ? t('dash.inDays', { n: d }) : t('dash.agoDays', { n: -d })
  const items: QueueItem[] = [
    ...data.syncs.map((x, index) => ({
      key: `sync-${x.gameId}-${index}`,
      icon: RefreshCcw,
      title: `${x.platform} @${x.handle}`,
      context: `${x.gameName} · ${t('dash.syncErrors')}`,
      meta: t('dash.fixNow'),
      path: `/g/${x.gameId}/sources`,
      tone: 'alarm' as const,
      priority: 0,
    })),
    ...data.tasksOverdue.map((x) => ({
      key: `task-${x.id}`,
      icon: CalendarClock,
      title: x.title,
      context: `${x.gameName} · ${t('dash.overdue')}`,
      meta: rel(x.daysLeft),
      path: `/g/${x.gameId}/tasks?task=${encodeURIComponent(x.id)}`,
      tone: 'alarm' as const,
      priority: 1,
      task: x,
    })),
    ...data.deadlines
      .filter((x) => x.alarm)
      .map((x) => ({
        key: `deadline-${x.id}`,
        icon: CalendarClock,
        title: x.name,
        context: `${x.gameName} · ${t('dash.deadlines')}`,
        meta: rel(x.daysLeft),
        path: `/g/${x.gameId}`,
        tone: 'alarm' as const,
        priority: 2,
      })),
    ...data.aiReview.map((x) => ({
      key: `ai-${x.runId}`,
      icon: Sparkles,
      title: x.prompt,
      context: `${x.gameName} · ${t('dash.aiReview')}`,
      meta: t('dash.reviewN', { n: x.pendingChanges }),
      path: `/g/${x.gameId}/ai`,
      tone: 'accent' as const,
      priority: 3,
    })),
    ...data.tasksUpcoming
      .filter((x) => x.daysLeft <= 7)
      .map((x) => ({
        key: `upcoming-${x.id}`,
        icon: CalendarClock,
        title: x.title,
        context: `${x.gameName} · ${t('dash.upcoming')}`,
        meta: rel(x.daysLeft),
        path: `/g/${x.gameId}/tasks?task=${encodeURIComponent(x.id)}`,
        tone: x.daysLeft <= 3 ? ('warning' as const) : ('muted' as const),
        priority: 4 + Math.max(x.daysLeft, 0) / 100,
        task: x,
      })),
    ...data.festivals
      .filter((x) => x.deadlineDays != null && x.deadlineDays >= 0 && x.deadlineDays <= 14)
      .map((x) => ({
        key: `festival-${x.gameId}-${x.id}`,
        icon: CalendarDays,
        title: x.name,
        context: `${x.gameName} · ${t('dash.festivals')}`,
        meta: rel(x.deadlineDays!),
        path: `/g/${x.gameId}/festivals`,
        tone: 'warning' as const,
        priority: 5 + x.deadlineDays! / 100,
      })),
  ].sort((a, b) => a.priority - b.priority)

  const primary = items[0]
  const queue = items.slice(1, 6)
  const criticalCount = data.syncs.length + data.tasksOverdue.length + data.deadlines.filter((x) => x.alarm).length
  const weekCount = data.tasksUpcoming.filter((x) => x.daysLeft <= 7).length
  const reviewCount = data.aiReview.reduce((sum, x) => sum + x.pendingChanges, 0)

  return (
    <section className="space-y-3" aria-labelledby="focus-heading">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 t-hint">
        <span>{t('dash.criticalCount', { n: criticalCount })}</span>
        <span>{t('dash.weekCount', { n: weekCount })}</span>
        <span>{t('dash.reviewCount', { n: reviewCount })}</span>
      </div>

      <div>
        <h2 id="focus-heading" className="mb-2 t-section">
          {t('dash.doNow')}
        </h2>
        {primary?.task ? (
          <TaskCard
            task={primary.task}
            gameName={primary.task.gameName}
            onOpen={() => onOpenTask(primary.task!.id, primary.task!.gameId)}
          />
        ) : primary ? (
          <button
            type="button"
            onClick={() => onOpen(primary.path)}
            className="tactile flex w-full items-center gap-3 rounded-[10px] bg-surface p-3 text-left shadow-hard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', toneCls[primary.tone])} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="break-words t-body font-medium text-pretty [overflow-wrap:anywhere]">{primary.title}</div>
              <div className="mt-0.5 break-words t-hint [overflow-wrap:anywhere]">
                {primary.context} · {primary.meta}
              </div>
            </div>
          </button>
        ) : (
          <div className="flex items-center gap-3 rounded-[10px] bg-surface p-4 text-success shadow-hard">
            <CircleCheck className="h-5 w-5 shrink-0" aria-hidden />
            <span className="t-body">{t('dash.allClear')}</span>
          </div>
        )}
      </div>

      {queue.length > 0 && (
        <div>
          <h2 className="mb-2 t-section">{t('dash.queue')}</h2>
          <div className="space-y-2">
            {queue.map((item) => {
              if (item.task) {
                return (
                  <TaskCard
                    key={item.key}
                    task={item.task}
                    gameName={item.task.gameName}
                    onOpen={() => onOpenTask(item.task!.id, item.task!.gameId)}
                  />
                )
              }
              const Icon = item.icon
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onOpen(item.path)}
                  className="tactile flex min-h-12 w-full items-center gap-3 rounded-[10px] bg-surface px-4 py-3 text-left shadow-hard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 break-words t-body text-pretty [overflow-wrap:anywhere]">
                    {item.title}
                  </span>
                  <span className="hidden max-w-56 break-words t-hint [overflow-wrap:anywhere] sm:block">
                    {item.context}
                  </span>
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', toneCls[item.tone])} aria-hidden />
                  <span className="nums w-16 shrink-0 text-right t-hint">{item.meta}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

export function Dashboard() {
  const t = useT()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const setCurrentGame = useUi((s) => s.setCurrentGame)
  const [searchParams, setSearchParams] = useSearchParams()
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(() => searchParams.get('edit'))
  const requestedLink = OFFICIAL_LINK_OPTIONS.find((option) => option.type === searchParams.get('addLink'))?.type
  const [selectedTask, setSelectedTask] = useState<{ id: string; gameId: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setEditingId(searchParams.get('edit')), [searchParams])

  const games = useQuery({ queryKey: ['games'], queryFn: () => trpc.games.list.query() })
  const overview = useQuery({ queryKey: ['dashboard'], queryFn: () => trpc.dashboard.overview.query() })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['games'] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
    qc.invalidateQueries({ queryKey: ['storefront-metrics'] })
  }

  const create = useMutation({
    mutationFn: (values: GameFormValues) => trpc.games.create.mutate(toInput(values)),
    onSuccess: (game) => {
      setError(null)
      setCreating(false)
      invalidate()
      if (game) {
        setCurrentGame(game.id)
        navigate(`/g/${game.id}`)
      }
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })
  const update = useMutation({
    mutationFn: ({ id, values }: { id: string; values: GameFormValues }) =>
      trpc.games.update.mutate({ id, patch: toInput(values) }),
    onSuccess: () => {
      setError(null)
      setEditingId(null)
      const next = new URLSearchParams(searchParams)
      next.delete('edit')
      next.delete('addLink')
      setSearchParams(next, { replace: true })
      invalidate()
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })
  const remove = useMutation({
    mutationFn: (id: string) => trpc.games.remove.mutate({ id }),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.fromError(e),
  })
  const askDelete = (g: { id: string; name: string }) =>
    void confirm({
      title: t('dash.confirmDelete', { name: g.name }),
      danger: true,
      confirmLabel: t('common.delete'),
    }).then((ok) => ok && remove.mutate(g.id))

  const open = (id: string) => {
    setCurrentGame(id)
    navigate(`/g/${id}`)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="t-title">{t('dash.focusTitle')}</h1>
          <p className="mt-1 t-hint">{t('dash.focusSubtitle')}</p>
        </div>
        {!creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            {t('dash.newGame')}
          </Button>
        )}
      </header>

      {error && (
        <div className="rounded-[var(--radius)] border border-alarm bg-alarm/10 px-3 py-2 text-sm text-alarm">
          {error}
        </div>
      )}

      {creating && (
        <div className="rounded-[var(--radius)] border border-border bg-surface p-4">
          <h2 className="mb-3 t-section">{t('dash.newGame')}</h2>
          <GameForm
            initial={emptyForm}
            submitLabel={t('common.create')}
            pending={create.isPending}
            onSubmit={(v) => create.mutate(v)}
            onCancel={() => setCreating(false)}
          />
        </div>
      )}

      {(games.isError || overview.isError) && (
        <QueryError
          error={games.error ?? overview.error}
          onRetry={() => {
            void games.refetch()
            void overview.refetch()
          }}
        />
      )}
      {(games.isLoading || overview.isLoading) && <LoadingState />}

      {/* One primary action and a deliberately short cross-game work queue. */}
      {overview.data && (games.data?.length ?? 0) > 0 && (
        <DashInsights
          data={overview.data}
          onOpen={(p) => navigate(p)}
          onOpenTask={(id, gameId) => setSelectedTask({ id, gameId })}
        />
      )}

      {(games.data?.length ?? 0) > 0 && <h2 className="t-section pt-1">{t('dash.projects')}</h2>}

      {games.data && games.data.length === 0 && !creating && (
        <div className="flex flex-col items-center gap-2 rounded-[var(--radius)] border border-dashed border-border py-16 text-center">
          <div className="font-mono text-2xl text-accent">=^•ω•^=</div>
          <p className="text-sm text-muted">{t('dash.empty')}</p>
        </div>
      )}

      <div className="enter-stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(games.data ?? []).map((g) =>
          editingId === g.id ? (
            <div
              key={g.id}
              className="rounded-[var(--radius)] border border-border bg-surface p-4 sm:col-span-2 lg:col-span-3"
            >
              <h2 className="mb-3 t-section">{t('form.editTitle', { name: g.name })}</h2>
              <GameForm
                initial={{
                  name: g.name,
                  releaseDate: g.releaseDate ?? '',
                  platforms: g.platforms ?? [],
                  officialLinks:
                    requestedLink && !g.officialLinks?.some((link) => link.type === requestedLink)
                      ? [...(g.officialLinks ?? []), { type: requestedLink, url: '' }]
                      : (g.officialLinks ?? []),
                  key: g.devhubProject ?? g.key ?? '',
                  color: g.color,
                }}
                autoFocusLink={requestedLink}
                submitLabel={t('common.save')}
                pending={update.isPending}
                onSubmit={(values) => update.mutate({ id: g.id, values })}
                onCancel={() => {
                  setEditingId(null)
                  const next = new URLSearchParams(searchParams)
                  next.delete('edit')
                  next.delete('addLink')
                  setSearchParams(next, { replace: true })
                }}
              />
            </div>
          ) : (
            <div
              key={g.id}
              className={cn(
                'hoverlift group flex flex-col gap-3 rounded-[var(--radius)] border border-border bg-surface p-4 transition-colors hover:border-accent/50',
              )}
            >
              <div className="flex items-start gap-2">
                <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: g.color }} aria-hidden />
                <div className="min-w-0">
                  <button
                    className="block truncate text-left t-body font-medium hover:text-accent"
                    onClick={() => open(g.id)}
                    title={g.name}
                  >
                    {g.name}
                  </button>
                  <div className="truncate t-hint">{g.key ?? g.slug}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                {g.releaseDate && <span className="nums">{g.releaseDate}</span>}
                {g.steamStoreUrl && (
                  <a href={g.steamStoreUrl} className="inline-flex items-center gap-1 text-info hover:underline">
                    Steam <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>

              <div className="mt-auto flex gap-1.5 pt-1">
                <Button size="sm" onClick={() => open(g.id)}>
                  {t('common.open')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingId(g.id)
                    const next = new URLSearchParams(searchParams)
                    next.set('edit', g.id)
                    setSearchParams(next, { replace: true })
                  }}
                  aria-label={t('common.edit')}
                  title={t('common.edit')}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => askDelete(g)}
                  disabled={remove.isPending}
                  aria-label={t('common.delete')}
                  title={t('common.delete')}
                >
                  <Trash2 className="h-4 w-4 text-alarm" />
                </Button>
              </div>
            </div>
          ),
        )}
      </div>

      {selectedTask && (
        <TaskDrawer taskId={selectedTask.id} gameId={selectedTask.gameId} onClose={() => setSelectedTask(null)} />
      )}
    </div>
  )
}
