import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, ExternalLink, Heart, MessageSquare, Pencil, Plus, ShoppingBag, Star, Trophy } from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { toast } from '@/store/toast'
import { daysUntil, todayIso } from '@/lib/date'
import { catLevel, resolveWishlistBalance } from '@/lib/level'
import { useUi } from '@/store/ui'
import { useCompanion } from '@/store/companion'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n/useT'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { TaskCard } from '@/components/tasks/TaskCard'
import { OFFICIAL_LINK_OPTIONS } from '@/components/games/officialLinks'

const DEADLINE_TYPES = ['release', 'festival', 'sale', 'update', 'other'] as const

function MetricCell({
  icon,
  label,
  value,
  hint,
  action,
  href,
  onClick,
}: {
  icon: ReactNode
  label: string
  value: string
  hint?: string
  action?: string
  href?: string
  onClick?: () => void
}) {
  const content = (
    <>
      <span className="flex items-center gap-1.5 text-[11px] text-muted">
        {icon}
        {label}
      </span>
      <span className="mt-1.5 flex min-h-5 items-baseline gap-2">
        <span className="nums text-sm font-semibold text-text">{value}</span>
        {action && <span className="text-[11px] font-medium text-info">{action}</span>}
      </span>
    </>
  )
  const cls =
    'block min-h-[62px] min-w-0 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-bg/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent'
  if (href)
    return (
      <a href={href} className={cls} title={hint} aria-label={`${label}: ${value}`}>
        {content}
      </a>
    )
  if (onClick)
    return (
      <button type="button" className={cn(cls, 'w-full')} title={hint} onClick={onClick}>
        {content}
      </button>
    )
  return (
    <div className={cls} title={hint}>
      {content}
    </div>
  )
}

export function GameHome() {
  const t = useT()
  const navigate = useNavigate()
  const { gameId } = useParams<{ gameId: string }>()
  const setCurrentGame = useUi((s) => s.setCurrentGame)
  const react = useCompanion((s) => s.react)
  const setLevel = useCompanion((s) => s.setLevel)
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'release', date: '' })
  const [shiftMsg, setShiftMsg] = useState<string | null>(null)

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
  }, [gameId, setCurrentGame])

  const game = useQuery({
    queryKey: ['games', gameId],
    queryFn: () => trpc.games.get.query({ id: gameId! }),
    enabled: !!gameId,
  })
  const tagsStatus = useQuery({
    queryKey: ['tags-status', gameId],
    queryFn: () => trpc.tags.withStatus.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const tasks = useQuery({
    queryKey: ['tasks', gameId],
    queryFn: () => trpc.tasks.list.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const wishlist = useQuery({
    queryKey: ['wishlist', gameId],
    queryFn: () => trpc.wishlists.series.query({ gameId: gameId! }),
    enabled: !!gameId,
    refetchInterval: 6 * 60 * 60 * 1_000,
  })
  const storefront = useQuery({
    queryKey: ['storefront-metrics', gameId],
    queryFn: () => trpc.storefront.metrics.query({ gameId: gameId! }),
    enabled: !!gameId,
    staleTime: 6 * 60 * 60 * 1_000,
    refetchInterval: 6 * 60 * 60 * 1_000,
  })

  const invalidateTags = () => {
    qc.invalidateQueries({ queryKey: ['tags-status', gameId] })
    qc.invalidateQueries({ queryKey: ['tags', gameId] })
  }
  const createDeadline = useMutation({
    mutationFn: () =>
      trpc.tags.create.mutate({
        gameId: gameId!,
        name: form.name.trim(),
        type: form.type as (typeof DEADLINE_TYPES)[number],
        targetDate: form.date,
      }),
    onSuccess: () => {
      setAdding(false)
      setForm({ name: '', type: 'release', date: '' })
      invalidateTags()
    },
    onError: toast.fromError,
  })
  const moveDeadline = useMutation({
    mutationFn: (v: { id: string; date: string }) =>
      trpc.tags.update.mutate({ id: v.id, patch: { targetDate: v.date } }),
    onSuccess: (res) => {
      invalidateTags()
      qc.invalidateQueries({ queryKey: ['tasks', gameId] })
      setShiftMsg(res && res.shiftedTasks > 0 ? t('home.shifted', { n: res.shiftedTasks }) : null)
    },
    onError: toast.fromError,
  })

  // Only dated tags act as deadlines (countdown + alarm).
  const dated = (tagsStatus.data ?? []).filter((tg) => tg.targetDate)
  const risk = dated.map((m) => {
    const dl = daysUntil(m.targetDate!)
    const alarm = m.overdueCount > 0 || (dl < 0 && m.openCount > 0)
    const warn = !alarm && dl <= 14 && m.openCount > 0
    return { m, dl, alarm, warn }
  })
  const anyAlarm = risk.some((r) => r.alarm)
  // Tamagotchi mood: the cat feeds on wishlist growth, frets over slipping deadlines.
  const today = todayIso()
  const overdue = (tasks.data ?? []).filter(
    (t) => t.dueDate && t.dueDate < today && t.status !== 'done' && t.status !== 'cancelled',
  ).length
  const pts = wishlist.data ?? []
  const last = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  const growthN =
    last && (last.adds ?? 0) > 0
      ? last.adds!
      : last?.balance != null && prev?.balance != null
        ? Math.max(0, last.balance - prev.balance)
        : 0
  const growing = !!last && growthN > 0
  const hasTasks = (tasks.data?.length ?? 0) > 0
  const balance = resolveWishlistBalance(pts)
  useEffect(() => {
    if (gameId && wishlist.data) setLevel(gameId, catLevel(balance).level)
  }, [balance, gameId, setLevel, wishlist.data])
  const alarmName = risk.find((r) => r.alarm)?.m.name ?? ''
  const warnEntry = risk.filter((r) => r.warn).sort((a, b) => a.dl - b.dl)[0]

  useEffect(() => {
    if (anyAlarm) react('milestoneRisk', { name: alarmName })
    else if (overdue > 0) react('overdue', { n: overdue })
    else if (warnEntry) react('deadlineNear', { name: warnEntry.m.name, d: warnEntry.dl })
    else if (growing) react('wishlistsUp', { n: growthN })
    else if (hasTasks) react('onTrack')
    else react('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyAlarm, overdue, !!warnEntry, growing, hasTasks, alarmName, warnEntry?.m.id, react])

  const upcoming = (tasks.data ?? [])
    .filter((t) => t.dueDate && t.status !== 'done' && t.status !== 'cancelled')
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1))
    .slice(0, 6)
  const primaryTask = upcoming[0]
  const sortedRisk = [...risk].sort((a, b) => a.dl - b.dl)
  const primaryRisk = [...risk].sort((a, b) => Number(b.alarm) - Number(a.alarm) || a.dl - b.dl)[0]

  const queryError = game.error ?? tagsStatus.error ?? tasks.error ?? wishlist.error
  if (queryError) {
    return (
      <QueryError
        error={queryError}
        onRetry={() => {
          void game.refetch()
          void tagsStatus.refetch()
          void tasks.refetch()
          void wishlist.refetch()
        }}
      />
    )
  }
  if (game.isLoading || tagsStatus.isLoading || tasks.isLoading || wishlist.isLoading) return <LoadingState />
  if (!game.data) return <p className="text-sm text-muted">{t('home.notFound')}</p>
  const g = game.data
  const topRank = storefront.data?.rank?.rank ?? null
  const reviews = storefront.data?.reviews
  const sales = storefront.data?.sales
  const critic = storefront.data?.critic

  const unit = (dl: number) => (dl === 0 ? t('home.today') : dl > 0 ? t('home.daysLeft') : t('home.daysAgo'))
  const typeLabel = (type: string) => t(`mtype.${type === 'track' ? 'other' : type}`)
  const openTask = (taskId: string) => navigate(`/g/${gameId}/tasks?task=${encodeURIComponent(taskId)}`)
  const openDeadline = (tagId: string) => navigate(`/g/${gameId}/tasks?tag=${encodeURIComponent(tagId)}`)

  return (
    <div className="enter-stagger mx-auto max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-1 h-3.5 w-3.5 rounded-full" style={{ backgroundColor: g.color }} aria-hidden />
          <div>
            <h1 className="t-title">{g.name}</h1>
            <p className="mt-1 t-hint">{t('home.focusSubtitle')}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {g.steamStoreUrl && (
            <a
              href={g.steamStoreUrl}
              className="tap inline-flex min-h-10 items-center gap-1 rounded-[var(--radius)] px-2 text-sm text-info transition-[scale,background-color] duration-150 hover:bg-surface active:scale-[0.96]"
            >
              Steam <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <Button size="sm" variant="outline" onClick={() => navigate(`/?edit=${g.id}`)}>
            <Pencil className="h-4 w-4" />
            {t('home.editProject')}
          </Button>
        </div>
      </header>

      <section
        aria-label={t('home.storefrontMetrics')}
        className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius)] bg-border shadow-[0_0_0_1px_var(--border)] sm:grid-cols-5 [&>*]:bg-surface"
      >
        <MetricCell
          icon={<Trophy className="h-3.5 w-3.5 text-warning" aria-hidden />}
          label={t('home.steamTop1000')}
          value={topRank == null ? '—' : `#${topRank.toLocaleString()}`}
          hint={t('home.steamRankHint', { n: storefront.data?.rank?.limit ?? 1_000 })}
          href={
            storefront.data?.rank?.sourceUrl ??
            'https://store.steampowered.com/search/?filter=popularwishlist&ignore_preferences=1'
          }
        />
        <MetricCell
          icon={<Heart className="h-3.5 w-3.5 text-accent" aria-hidden />}
          label={t('home.wishlists')}
          value={balance == null ? '—' : balance.toLocaleString()}
          hint={last?.date ? t('home.wishlistsAsOf', { date: last.date }) : undefined}
        />
        <MetricCell
          icon={<ShoppingBag className="h-3.5 w-3.5 text-info" aria-hidden />}
          label={t('home.sales')}
          value={sales?.netUnits == null ? '—' : sales.netUnits.toLocaleString()}
          action={storefront.data && !storefront.data.salesConnectorConfigured ? t('home.connect') : undefined}
          hint={storefront.data?.salesConnectorConfigured ? t('home.salesHint') : t('home.salesConnectHint')}
          onClick={
            storefront.data && !storefront.data.salesConnectorConfigured
              ? () => navigate('/settings?connector=steamfinancial')
              : undefined
          }
        />
        <MetricCell
          icon={<MessageSquare className="h-3.5 w-3.5 text-accent" aria-hidden />}
          label={t('home.steamReviews')}
          value={reviews ? `${reviews.total.toLocaleString()} · ${reviews.positivePercent}%` : '—'}
          hint={reviews?.description || t('home.steamReviewsHint')}
          href={g.steamStoreUrl ? `${g.steamStoreUrl}#app_reviews_hash` : undefined}
        />
        <MetricCell
          icon={<Star className="h-3.5 w-3.5 text-warning" aria-hidden />}
          label={critic ? (critic.provider === 'metacritic' ? 'Metacritic' : 'OpenCritic') : t('home.critics')}
          value={critic ? String(critic.score) : '—'}
          action={storefront.data && !storefront.data.criticUrl ? t('home.connect') : undefined}
          hint={storefront.data?.criticUrl ? t('home.criticHint') : t('home.criticConnectHint')}
          href={critic?.url ?? storefront.data?.criticUrl ?? undefined}
          onClick={
            storefront.data && !storefront.data.criticUrl
              ? () => navigate(`/?edit=${g.id}&addLink=metacritic`)
              : undefined
          }
        />
      </section>

      {(g.officialLinks?.length ?? 0) > 0 && (
        <nav aria-label={t('form.officialLinks')} className="flex flex-wrap gap-2">
          {g.officialLinks.map((link) => {
            const option = OFFICIAL_LINK_OPTIONS.find((item) => item.type === link.type)
            return (
              <a
                key={`${link.type}:${link.url}`}
                href={link.url}
                className="tap inline-flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] bg-surface px-3 text-xs text-muted shadow-[0_0_0_1px_var(--border)] transition-[scale,color,box-shadow] duration-150 hover:text-text hover:shadow-[0_0_0_1px_var(--border-strong)] active:scale-[0.96]"
              >
                {link.label || t(option?.labelKey ?? 'link.other')}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            )
          })}
        </nav>
      )}

      <section aria-labelledby="project-focus-heading">
        <h2 id="project-focus-heading" className="mb-2 t-section">
          {t('home.doNow')}
        </h2>
        {primaryTask ? (
          <TaskCard task={primaryTask} onOpen={openTask} />
        ) : primaryRisk ? (
          <button
            type="button"
            onClick={() => openDeadline(primaryRisk.m.id)}
            className="tactile flex w-full items-center gap-3 rounded-[10px] bg-surface p-4 text-left shadow-hard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', primaryRisk.alarm ? 'bg-alarm' : 'bg-warning')} />
            <div className="min-w-0 flex-1">
              <div className="break-words t-body font-medium text-pretty [overflow-wrap:anywhere]">
                {primaryRisk.m.name}
              </div>
              <div className="mt-0.5 t-hint">
                {t('home.deadlineFocus', { n: Math.abs(primaryRisk.dl), when: unit(primaryRisk.dl) })}
              </div>
            </div>
          </button>
        ) : (
          <div className="flex items-center gap-3 rounded-[10px] bg-surface p-4 text-success shadow-hard">
            <CircleCheck className="h-5 w-5" aria-hidden />
            <span className="t-body">{t('home.onTrack')}</span>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="t-section">{t('home.deadlines')}</h2>
          {!adding && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" />
              {t('home.deadline')}
            </Button>
          )}
        </div>

        {shiftMsg && <p className="text-xs text-accent">{shiftMsg}</p>}

        {adding && (
          <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius)] border border-border bg-surface p-3">
            <input
              autoFocus
              placeholder={t('form.name')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={cn(fieldCls, 'w-44')}
            />
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              className={cn(fieldCls, 'w-36')}
            >
              {DEADLINE_TYPES.map((mt) => (
                <option key={mt} value={mt}>
                  {t(`mtype.${mt}`)}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className={cn(fieldCls, 'w-40')}
            />
            <Button
              size="sm"
              onClick={() => form.name.trim() && form.date && createDeadline.mutate()}
              disabled={!form.name.trim() || !form.date || createDeadline.isPending}
            >
              {t('common.create')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        )}

        {dated.length === 0 && !g.releaseDate && !adding && (
          <p className="text-sm text-muted">{t('home.noDeadlines')}</p>
        )}

        {(g.releaseDate || sortedRisk.length > 0) && (
          <div className="overflow-hidden rounded-[var(--radius)] bg-surface shadow-hard">
            {g.releaseDate && (
              <button
                type="button"
                onClick={() => navigate(`/?edit=${g.id}`)}
                className="tap flex min-h-14 w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.color }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate t-body font-medium">{g.name}</div>
                  <div className="t-hint">{t('mtype.release')}</div>
                </div>
                <span className="nums t-body font-medium">{Math.abs(daysUntil(g.releaseDate))}</span>
                <span className="w-20 t-hint">{unit(daysUntil(g.releaseDate))}</span>
                <span className="nums w-24 text-right t-hint">{g.releaseDate}</span>
              </button>
            )}
            {sortedRisk.map(({ m, dl, alarm, warn }) => (
              <div
                key={m.id}
                className="flex min-h-14 items-stretch border-b border-border transition-colors duration-150 last:border-b-0 hover:bg-surface-2 focus-within:bg-surface-2"
              >
                <button
                  type="button"
                  onClick={() => openDeadline(m.id)}
                  className="tap flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                >
                  <span
                    className={cn(
                      'h-2.5 w-2.5 shrink-0 rounded-full',
                      alarm ? 'bg-alarm' : warn ? 'bg-warning' : 'bg-muted/40',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate t-body font-medium">{m.name}</span>
                    <span className="block t-hint">
                      {typeLabel(m.type)} · {t('home.tasks', { done: m.linkedDone, total: m.linkedTotal })}
                      {m.overdueCount > 0 && (
                        <span className="text-alarm"> · {t('home.overdue', { n: m.overdueCount })}</span>
                      )}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'nums t-body font-medium',
                      alarm ? 'text-alarm' : warn ? 'text-warning' : 'text-text',
                    )}
                  >
                    {Math.abs(dl)}
                  </span>
                  <span className="w-20 t-hint">{unit(dl)}</span>
                </button>
                <input
                  type="date"
                  value={m.targetDate!}
                  onChange={(e) => e.target.value && moveDeadline.mutate({ id: m.id, date: e.target.value })}
                  title={t('home.moveDate')}
                  aria-label={t('home.moveDate')}
                  className="my-auto mr-2 min-h-10 w-32 cursor-pointer rounded-[var(--radius)] bg-transparent px-2 t-hint hover:bg-bg/70 focus:bg-bg/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="t-section">{t('home.next')}</h2>
        {upcoming.filter((task) => task.id !== primaryTask?.id).length === 0 ? (
          <p className="text-sm text-muted">{t('home.noUpcoming')}</p>
        ) : (
          <div className="space-y-2">
            {upcoming
              .filter((task) => task.id !== primaryTask?.id)
              .map((task) => (
                <TaskCard key={task.id} task={task} onOpen={openTask} />
              ))}
          </div>
        )}
      </section>
    </div>
  )
}
