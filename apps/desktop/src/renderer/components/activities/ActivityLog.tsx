import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  CheckSquare2,
  Clipboard,
  FolderKanban,
  Pencil,
  Search,
  Send,
  Trash2,
  UserRound,
} from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { confirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { EVENT_TYPES, PLATFORMS, PLATFORM_META, type EventType, type Platform } from '@/components/events/meta'
import { useT } from '@/i18n/useT'

export type ActivitySubject = 'project' | 'task' | 'festival' | 'creator'
type Direction = '' | 'outbound' | 'inbound'
type Channel = 'email' | 'dm' | 'form' | 'call' | 'meeting' | 'other'
type Activity = Awaited<ReturnType<typeof trpc.activities.list.query>>[number]

export interface ActivityStatusOption {
  value: string
  label: string
}

interface ActivityDraft {
  body: string
  occurredAt: string
  direction: Direction
  channel: Channel
  statusAfter: string
  showOnWishlist: boolean
  type: EventType
  platform: '' | Platform
  placement: string
  url: string
  views: string
}

const today = () => new Date().toISOString().slice(0, 10)
const CHANNELS: readonly Channel[] = ['email', 'dm', 'form', 'call', 'meeting', 'other']
const emptyDraft = (): ActivityDraft => ({
  body: '',
  occurredAt: today(),
  direction: '',
  channel: 'email',
  statusAfter: '',
  showOnWishlist: false,
  type: 'other',
  platform: '',
  placement: '',
  url: '',
  views: '',
})

function draftFrom(row: Activity): ActivityDraft {
  return {
    body: row.body || row.title,
    occurredAt: row.occurredAt,
    direction: (row.direction as Direction) || '',
    channel: CHANNELS.includes(row.channel as Channel) ? (row.channel as Channel) : 'other',
    statusAfter: row.statusAfter || '',
    showOnWishlist: row.showOnWishlist,
    type: EVENT_TYPES.includes(row.type as EventType) ? (row.type as EventType) : 'other',
    platform: PLATFORMS.includes(row.platform as Platform) ? (row.platform as Platform) : '',
    placement: row.placement || '',
    url: row.url || '',
    views: row.views == null ? '' : String(row.views),
  }
}

function subjectIcon(type: string) {
  if (type === 'task') return CheckSquare2
  if (type === 'festival') return CalendarDays
  if (type === 'creator') return UserRound
  return FolderKanban
}

function invalidateActivityQueries(qc: ReturnType<typeof useQueryClient>, gameId: string) {
  qc.invalidateQueries({ queryKey: ['activities', gameId] })
  qc.invalidateQueries({ queryKey: ['events', gameId] })
  qc.invalidateQueries({ queryKey: ['impact', gameId] })
  qc.invalidateQueries({ queryKey: ['creator-funnel', gameId] })
}

function ActivityFields({
  value,
  onChange,
  statusOptions,
  compact = false,
}: {
  value: ActivityDraft
  onChange: (next: ActivityDraft) => void
  statusOptions?: ActivityStatusOption[]
  compact?: boolean
}) {
  const t = useT()
  const set = <K extends keyof ActivityDraft>(key: K, next: ActivityDraft[K]) => onChange({ ...value, [key]: next })
  return (
    <>
      <textarea
        rows={compact ? 4 : 3}
        value={value.body}
        onChange={(e) => set('body', e.target.value)}
        placeholder={t('activity.placeholder')}
        className={cn(fieldCls, 'min-h-20 resize-y bg-surface px-3 py-2.5 leading-relaxed')}
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          aria-label={t('activity.date')}
          value={value.occurredAt}
          onChange={(e) => set('occurredAt', e.target.value)}
          className={cn(fieldCls, 'nums h-10 w-[142px] bg-surface text-xs')}
        />
        <select
          aria-label={t('activity.direction')}
          value={value.direction}
          onChange={(e) => set('direction', e.target.value as Direction)}
          className={cn(fieldCls, 'h-10 w-[138px] bg-surface text-xs')}
        >
          <option value="">{t('activity.note')}</option>
          <option value="outbound">{t('activity.outbound')}</option>
          <option value="inbound">{t('activity.inbound')}</option>
        </select>
        {value.direction && (
          <select
            aria-label={t('activity.channel')}
            value={value.channel}
            onChange={(e) => set('channel', e.target.value as Channel)}
            className={cn(fieldCls, 'h-10 w-[110px] bg-surface text-xs')}
          >
            {CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {t(`activity.channel.${channel}`)}
              </option>
            ))}
          </select>
        )}
        {statusOptions && (
          <select
            aria-label={t('activity.statusAfter')}
            value={value.statusAfter}
            onChange={(e) => set('statusAfter', e.target.value)}
            className={cn(fieldCls, 'h-10 min-w-[150px] flex-1 bg-surface text-xs')}
          >
            <option value="">{t('activity.keepStatus')}</option>
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          aria-pressed={value.showOnWishlist}
          onClick={() => set('showOnWishlist', !value.showOnWishlist)}
          className={cn(
            'tap inline-flex h-10 items-center gap-2 rounded-[var(--radius)] px-3 text-xs transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]',
            value.showOnWishlist
              ? 'bg-accent text-accent-fg shadow-hard'
              : 'bg-surface text-muted shadow-[0_0_0_1px_var(--border)] hover:text-text',
          )}
        >
          <BarChart3 className="h-4 w-4" />
          {t('activity.onChart')}
        </button>
      </div>

      {value.showOnWishlist && (
        <div className="enter grid grid-cols-2 gap-2 sm:grid-cols-3">
          <select
            value={value.type}
            onChange={(e) => set('type', e.target.value as EventType)}
            className={cn(fieldCls, 'h-10 bg-surface text-xs')}
          >
            {EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`etype.${type}`)}
              </option>
            ))}
          </select>
          <select
            value={value.platform}
            onChange={(e) => set('platform', e.target.value as '' | Platform)}
            className={cn(fieldCls, 'h-10 bg-surface text-xs')}
          >
            <option value="">{t('activity.noPlatform')}</option>
            {PLATFORMS.map((platform) => (
              <option key={platform} value={platform}>
                {PLATFORM_META[platform].label || t('plat.other')}
              </option>
            ))}
          </select>
          <input
            value={value.placement}
            onChange={(e) => set('placement', e.target.value)}
            placeholder={t('activity.placement')}
            className={cn(fieldCls, 'col-span-2 h-10 bg-surface text-xs sm:col-span-1')}
          />
          <input
            value={value.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="https://…"
            className={cn(fieldCls, 'col-span-2 h-10 bg-surface text-xs sm:col-span-1')}
          />
          <input
            type="number"
            min={0}
            value={value.views}
            onChange={(e) => set('views', e.target.value)}
            placeholder={t('ev.views')}
            className={cn(fieldCls, 'h-10 bg-surface text-xs')}
          />
        </div>
      )}
    </>
  )
}

function ActivityRow({
  row,
  statusOptions,
  onChanged,
  onOpenSubject,
  focused = false,
}: {
  row: Activity
  statusOptions?: ActivityStatusOption[]
  onChanged: () => void
  onOpenSubject?: (type: ActivitySubject, id: string) => void
  focused?: boolean
}) {
  const t = useT()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => draftFrom(row))
  const SubjectIcon = subjectIcon(row.subjectType)
  const text = row.body || row.title
  const long = text.length > 260 || text.split(/\r?\n/).length > 4
  const edited = row.updatedAt.slice(0, 19) !== row.createdAt.slice(0, 19)

  const update = useMutation({
    mutationFn: () =>
      trpc.activities.update.mutate({
        id: row.id,
        patch: {
          occurredAt: draft.occurredAt,
          body: draft.body,
          direction: draft.direction || null,
          channel: draft.direction ? draft.channel : null,
          statusAfter: draft.statusAfter || null,
          showOnWishlist: draft.showOnWishlist,
          type: draft.type,
          platform: draft.platform || null,
          placement: draft.placement.trim() || null,
          url: draft.url.trim() || null,
          views: draft.views.trim() ? Number(draft.views) : null,
        },
      }),
    onSuccess: () => {
      setEditing(false)
      invalidateActivityQueries(qc, row.gameId)
      onChanged()
    },
    onError: toast.fromError,
  })
  const remove = useMutation({
    mutationFn: () => trpc.activities.remove.mutate({ id: row.id }),
    onSuccess: () => {
      invalidateActivityQueries(qc, row.gameId)
      onChanged()
    },
    onError: toast.fromError,
  })
  const toggleChart = useMutation({
    mutationFn: () => trpc.activities.update.mutate({ id: row.id, patch: { showOnWishlist: !row.showOnWishlist } }),
    onSuccess: () => {
      invalidateActivityQueries(qc, row.gameId)
      onChanged()
    },
    onError: toast.fromError,
  })
  const askDelete = () =>
    void confirm({
      title: t('activity.deleteQ'),
      danger: true,
      confirmLabel: t('common.delete'),
    }).then((ok) => ok && remove.mutate())

  if (editing) {
    return (
      <div className="enter space-y-2 rounded-[var(--radius)] bg-surface p-3 shadow-[0_0_0_1px_var(--border)]">
        <ActivityFields value={draft} onChange={setDraft} statusOptions={statusOptions} compact />
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(draftFrom(row))
              setEditing(false)
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={() => update.mutate()} disabled={!draft.body.trim() || update.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <article
      id={`activity-${row.id}`}
      className="group relative grid grid-cols-[20px_minmax(0,1fr)] gap-3 pb-4 last:pb-0"
    >
      <div className="relative flex justify-center">
        <span
          className={cn(
            'relative z-10 mt-1 h-2.5 w-2.5 rounded-full',
            row.showOnWishlist ? 'bg-accent' : 'bg-border-strong',
          )}
        />
        <span className="activity-line absolute bottom-[-16px] top-3 w-px bg-border" />
      </div>
      <div
        className={cn(
          'min-w-0 rounded-[var(--radius)] bg-surface px-3 py-2.5 transition-[box-shadow] duration-150 ease-out',
          focused
            ? 'shadow-[0_0_0_2px_var(--accent)]'
            : 'shadow-[0_0_0_1px_var(--border)] hover:shadow-[0_0_0_1px_var(--border-strong)]',
        )}
      >
        <div className="flex min-h-10 items-center gap-2">
          <span className="nums shrink-0 text-xs text-muted">{row.occurredAt}</span>
          {row.direction && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs',
                row.direction === 'inbound' ? 'bg-accent/10 text-accent' : 'bg-info/10 text-info',
              )}
            >
              {row.direction === 'inbound' ? (
                <ArrowDownLeft className="h-3 w-3" />
              ) : (
                <ArrowUpRight className="h-3 w-3" />
              )}
              {row.channel ? t(`activity.channel.${row.channel}`) : t(`activity.${row.direction}`)}
            </span>
          )}
          {row.subjectLabel && (
            <button
              type="button"
              disabled={!row.subjectId || row.subjectType === 'project' || !onOpenSubject}
              onClick={() => row.subjectId && onOpenSubject?.(row.subjectType as ActivitySubject, row.subjectId)}
              className="inline-flex min-w-0 items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted transition-colors enabled:hover:text-text disabled:cursor-default"
            >
              <SubjectIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{row.subjectLabel}</span>
            </button>
          )}
          {edited && <span className="text-xs text-muted/70">{t('activity.edited')}</span>}
          <div className="ml-auto flex shrink-0 items-center">
            <button
              onClick={() => toggleChart.mutate()}
              title={t('activity.onChart')}
              aria-pressed={row.showOnWishlist}
              className={cn(
                'tap inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96]',
                row.showOnWishlist ? 'text-accent' : 'text-muted hover:bg-surface-2 hover:text-text',
              )}
            >
              <BarChart3 className="h-4 w-4" />
            </button>
            <div className="flex opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(text)
                  toast.success(t('activity.copied'))
                }}
                title={t('activity.copy')}
                className="tap inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted transition-[scale,background-color,color] duration-150 ease-out hover:bg-surface-2 hover:text-text active:scale-[0.96]"
              >
                <Clipboard className="h-4 w-4" />
              </button>
              <button
                onClick={() => setEditing(true)}
                title={t('common.edit')}
                className="tap inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted transition-[scale,background-color,color] duration-150 ease-out hover:bg-surface-2 hover:text-text active:scale-[0.96]"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={askDelete}
                title={t('common.delete')}
                className="tap inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted transition-[scale,background-color,color] duration-150 ease-out hover:bg-alarm/10 hover:text-alarm active:scale-[0.96]"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => long && setExpanded((value) => !value)}
          className={cn(
            'block w-full whitespace-pre-wrap text-left text-sm leading-relaxed text-text',
            long && 'cursor-pointer',
            !expanded && long && 'line-clamp-4',
          )}
        >
          {text}
        </button>
        {row.showOnWishlist && (row.platform || row.placement || row.url) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            {row.platform && (
              <span>{PLATFORM_META[row.platform as keyof typeof PLATFORM_META]?.label || row.platform}</span>
            )}
            {row.placement && <span>{row.placement}</span>}
            {row.url && <span className="max-w-full truncate">{row.url}</span>}
          </div>
        )}
      </div>
    </article>
  )
}

export function ActivityLog({
  gameId,
  subjectType,
  subjectId,
  statusOptions,
  showFilters = false,
  focusId,
  onChanged = () => undefined,
}: {
  gameId: string
  subjectType?: ActivitySubject
  subjectId?: string
  statusOptions?: ActivityStatusOption[]
  showFilters?: boolean
  focusId?: string
  onChanged?: () => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [draft, setDraft] = useState(emptyDraft)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [wishlistOnly, setWishlistOnly] = useState(false)
  const [kind, setKind] = useState<'all' | ActivitySubject>('all')
  const effectiveSubject = subjectType ?? (kind === 'all' ? undefined : kind)
  const activities = useQuery({
    queryKey: ['activities', gameId, effectiveSubject, subjectId, wishlistOnly, deferredSearch],
    queryFn: () =>
      trpc.activities.list.query({
        gameId,
        subjectType: effectiveSubject,
        subjectId: subjectType ? subjectId : undefined,
        wishlistOnly,
        search: deferredSearch.trim() || undefined,
      }),
  })
  const create = useMutation({
    mutationFn: () =>
      trpc.activities.create.mutate({
        gameId,
        subjectType: subjectType ?? 'project',
        subjectId: subjectId ?? null,
        occurredAt: draft.occurredAt,
        body: draft.body,
        direction: draft.direction || null,
        channel: draft.direction ? draft.channel : null,
        statusAfter: draft.statusAfter || null,
        showOnWishlist: draft.showOnWishlist,
        type: draft.type,
        platform: draft.platform || null,
        placement: draft.placement.trim() || null,
        url: draft.url.trim() || null,
        views: draft.views.trim() ? Number(draft.views) : null,
      }),
    onSuccess: () => {
      setDraft(emptyDraft())
      invalidateActivityQueries(qc, gameId)
      onChanged()
    },
    onError: toast.fromError,
  })
  const save = () => draft.body.trim() && create.mutate()
  const rows = useMemo(() => activities.data ?? [], [activities.data])
  const statusLabels = useMemo(() => statusOptions, [statusOptions])
  const openSubject = (type: ActivitySubject, id: string) => {
    const page = type === 'task' ? 'tasks' : type === 'festival' ? 'festivals' : type === 'creator' ? 'creators' : null
    const key = type === 'task' ? 'task' : type
    if (page) navigate(`/g/${gameId}/${page}?${key}=${encodeURIComponent(id)}`)
  }

  useEffect(() => {
    if (!focusId || !rows.some((row) => row.id === focusId)) return
    window.setTimeout(
      () => document.getElementById(`activity-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      60,
    )
  }, [focusId, rows])

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="t-section text-text">{t('activity.history')}</h3>
        {rows.length > 0 && <span className="nums text-xs text-muted">{rows.length}</span>}
      </div>

      {showFilters && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('activity.search')}
              className={cn(fieldCls, 'h-10 bg-surface pl-9')}
            />
          </label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'all' | ActivitySubject)}
            className={cn(fieldCls, 'h-10 w-40 bg-surface text-xs')}
          >
            <option value="all">{t('activity.all')}</option>
            {(['project', 'task', 'festival', 'creator'] as const).map((type) => (
              <option key={type} value={type}>
                {t(`activity.subject.${type}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-pressed={wishlistOnly}
            onClick={() => setWishlistOnly((value) => !value)}
            className={cn(
              'tap inline-flex h-10 items-center gap-2 rounded-[var(--radius)] px-3 text-xs transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96]',
              wishlistOnly
                ? 'bg-accent text-accent-fg'
                : 'bg-surface text-muted shadow-[0_0_0_1px_var(--border)] hover:text-text',
            )}
          >
            <BarChart3 className="h-4 w-4" />
            {t('activity.onChart')}
          </button>
        </div>
      )}

      <div
        className="space-y-2 rounded-[calc(var(--radius)+8px)] bg-surface-2/70 p-3 shadow-[0_0_0_1px_var(--border)]"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
        }}
      >
        <ActivityFields value={draft} onChange={setDraft} statusOptions={statusLabels} />
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={!draft.body.trim() || create.isPending}>
            <Send className="h-4 w-4" />
            {t('activity.add')}
          </Button>
        </div>
      </div>

      {activities.isLoading ? (
        <div className="h-16 animate-pulse rounded-[var(--radius)] bg-surface-2" />
      ) : rows.length === 0 ? (
        <p className="py-3 text-center text-xs text-muted">{t('activity.empty')}</p>
      ) : (
        <div className="[&>article:last-child_.activity-line]:hidden">
          {rows.map((row) => (
            <ActivityRow
              key={row.id}
              row={row}
              statusOptions={statusLabels}
              onChanged={onChanged}
              onOpenSubject={showFilters ? openSubject : undefined}
              focused={row.id === focusId}
            />
          ))}
        </div>
      )}
    </section>
  )
}
