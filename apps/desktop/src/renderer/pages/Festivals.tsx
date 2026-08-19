import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Plus, Search, Sparkles, Star, Trash2 } from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { confirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { IconToggle } from '@/components/ui/Toggle'
import { PageHeader } from '@/components/ui/Screen'
import { useT } from '@/i18n/useT'
import { ActivityLog } from '@/components/activities/ActivityLog'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { DetailDrawer } from '@/components/ui/DetailDrawer'
import { compareListValues, SortableHeader, StatusSelect, type SortDirection } from '@/components/ui/DataList'
import { CARD_STATE_STYLES, type CardStateTone } from '@/components/ui/CardState'

type Festival = Awaited<ReturnType<typeof trpc.festivals.list.query>>[number]

const emptyForm = { name: '', type: 'festival', startDate: '', applyDeadline: '', url: '' }
const STATUSES = ['none', 'materials', 'submitted', 'replied', 'approved', 'rejected'] as const
type FestivalStatus = (typeof STATUSES)[number]
type FestivalSortKey = 'name' | 'organizer' | 'date' | 'deadline' | 'cost' | 'status'
type FestivalSort = { key: FestivalSortKey; direction: SortDirection }

const FESTIVAL_STATUS_TONES: Record<FestivalStatus, CardStateTone> = {
  none: 'neutral',
  materials: 'info',
  submitted: 'info',
  replied: 'warning',
  approved: 'success',
  rejected: 'danger',
}

const festivalDrawerPanel = 'rounded-[12px] bg-bg/55 p-3 shadow-hard'
const festivalDrawerSectionLabel = 't-hint font-medium text-text'

/** A festival is "past" once its last day (end, else start) is before today. */
function isPastFest(f: { startDate?: string | null; endDate?: string | null }, today: string): boolean {
  const end = f.endDate || f.startDate
  return !!end && end < today
}

/** Days from today to an ISO date (negative = past). null if no date. */
function dday(iso?: string | null): number | null {
  if (!iso) return null
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - now.getTime()) / 86_400_000)
}

export function Festivals() {
  const t = useT()
  const { gameId } = useParams<{ gameId?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const setCurrentGame = useUi((s) => s.setCurrentGame)
  const setSeedPrompt = useUi((s) => s.setSeedPrompt)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState(emptyForm)
  // Inside a project, default to showing only the favorited festivals.
  const [onlyPicked, setOnlyPicked] = useState(!!gameId)
  const [sort, setSort] = useState<FestivalSort>({ key: 'deadline', direction: 'asc' })
  const [showPast, setShowPast] = useState(true)
  const [search, setSearch] = useState('')
  const [openId, setOpenId] = useState<string | null>(() => searchParams.get('festival'))
  const todayStr = new Date().toISOString().slice(0, 10)

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
    // Project view defaults to favorites-only; global view shows everything.
    setOnlyPicked(!!gameId)
    setSort({ key: 'deadline', direction: 'asc' })
  }, [gameId, setCurrentGame])

  useEffect(() => {
    setOpenId(searchParams.get('festival'))
  }, [searchParams])

  const openFestival = (id: string) => {
    setOpenId(id)
    const next = new URLSearchParams(searchParams)
    next.set('festival', id)
    setSearchParams(next, { replace: true })
  }
  const closeFestival = () => {
    setOpenId(null)
    const next = new URLSearchParams(searchParams)
    next.delete('festival')
    setSearchParams(next, { replace: true })
  }

  const list = useQuery({ queryKey: ['festivals'], queryFn: () => trpc.festivals.list.query() })
  const picks = useQuery({
    queryKey: ['festival-picks', gameId],
    queryFn: () => trpc.festivals.picks.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const participation = useQuery({
    queryKey: ['festival-participation'],
    queryFn: () => trpc.festivals.participation.query(),
    enabled: !gameId,
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['festivals'] })
    qc.invalidateQueries({ queryKey: ['festival-picks', gameId] })
    qc.invalidateQueries({ queryKey: ['festival-participation'] })
  }
  const pickMut = useMutation({
    mutationFn: (v: { industryEventId: string; on: boolean }) =>
      v.on
        ? trpc.festivals.pick.mutate({ gameId: gameId!, industryEventId: v.industryEventId })
        : trpc.festivals.unpick.mutate({ gameId: gameId!, industryEventId: v.industryEventId }),
    onSuccess: invalidate,
  })
  const create = useMutation({
    mutationFn: () =>
      trpc.festivals.create.mutate({
        name: form.name.trim(),
        type: form.type,
        startDate: form.startDate,
        applyDeadline: form.applyDeadline || undefined,
        url: form.url.trim() || undefined,
      }),
    onSuccess: (row) => {
      setForm(emptyForm)
      setAdding(false)
      invalidate()
      if (gameId && row) pickMut.mutate({ industryEventId: row.id, on: true })
    },
    onError: toast.fromError,
  })
  const remove = useMutation({
    mutationFn: (id: string) => trpc.festivals.remove.mutate({ id }),
    onSuccess: invalidate,
    onError: toast.fromError,
  })
  const setStatus = useMutation({
    mutationFn: (v: { industryEventId: string; status: string }) =>
      trpc.festivals.setStatus.mutate({ gameId: gameId!, industryEventId: v.industryEventId, status: v.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['festival-picks', gameId] }),
  })

  const statusOf = useMemo(() => new Map((picks.data ?? []).map((p) => [p.industryEventId, p.status])), [picks.data])
  useEffect(() => {
    const linkedFestival = searchParams.get('festival')
    if (linkedFestival && picks.data && !statusOf.has(linkedFestival)) setOnlyPicked(false)
  }, [picks.data, searchParams, statusOf])
  const participantsBy = useMemo(() => {
    const m = new Map<string, { gameId: string; gameName: string; color: string; status: string }[]>()
    for (const p of participation.data ?? []) {
      const arr = m.get(p.industryEventId) ?? []
      arr.push({ gameId: p.gameId, gameName: p.gameName, color: p.color, status: p.status })
      m.set(p.industryEventId, arr)
    }
    return m
  }, [participation.data])

  const rows = useMemo(() => {
    const filtered = (list.data ?? []).filter((f) => {
      if (gameId && onlyPicked && !statusOf.has(f.id)) return false
      if (!showPast && isPastFest(f, todayStr)) return false
      const needle = search.trim().toLocaleLowerCase()
      if (
        needle &&
        ![f.name, f.organizer, f.type, f.description].some((value) => value?.toLocaleLowerCase().includes(needle))
      )
        return false
      return true
    })
    const value = (festival: Festival): string | number | null | undefined => {
      if (sort.key === 'name') return festival.name
      if (sort.key === 'organizer') return festival.organizer
      if (sort.key === 'date') return festival.startDate
      if (sort.key === 'deadline') return festival.applyDeadline
      if (sort.key === 'cost') return festival.costUsd
      if (gameId) {
        const status = statusOf.get(festival.id) as FestivalStatus | undefined
        return status ? STATUSES.indexOf(status) : null
      }
      return participantsBy.get(festival.id)?.length ?? 0
    }
    return [...filtered].sort((a, b) => {
      const compared = compareListValues(value(a), value(b), sort.direction)
      return compared || a.name.localeCompare(b.name)
    })
  }, [list.data, gameId, onlyPicked, statusOf, participantsBy, sort, showPast, todayStr, search])
  const selectedFestival = openId ? (list.data ?? []).find((festival) => festival.id === openId) : undefined
  const statusOptions = STATUSES.map((status) => ({ value: status, label: t(`fest.st.${status}`) }))

  const changeSort = (key: FestivalSortKey) =>
    setSort((current) => ({
      key,
      direction:
        current.key === key
          ? current.direction === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'status' && !gameId
            ? 'desc'
            : 'asc',
    }))

  const askCat = (f: Festival) => {
    setSeedPrompt(`${t('fest.askSeed', { name: f.name, date: f.startDate })}${f.url ? ` (${f.url})` : ''} `)
    navigate(`/g/${gameId}/ai`)
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={gameId ? t('nav.festivals') : t('fest.global')}
        actions={
          <>
            {gameId && (
              <IconToggle active={onlyPicked} onClick={() => setOnlyPicked((v) => !v)} title={t('fest.onlyPicked')}>
                <Star className={cn('h-4 w-4', onlyPicked && 'fill-current')} />
              </IconToggle>
            )}
            <IconToggle active={!showPast} onClick={() => setShowPast((v) => !v)} title={t('fest.showPast')}>
              {showPast ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </IconToggle>
            <Button size="sm" onClick={() => setAdding((v) => !v)}>
              <Plus className="h-4 w-4" />
              {t('common.add')}
            </Button>
          </>
        }
      />

      <label className="relative block max-w-sm">
        <span className="sr-only">{t('common.search')}</span>
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('common.search')}
          className={cn(fieldCls, 'pl-9')}
        />
      </label>

      {adding && (
        <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius)] border border-border bg-surface p-3">
          <label className="flex flex-col gap-1 t-hint">
            {t('fest.name')}
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={cn(fieldCls, 'w-52')}
            />
          </label>
          <label className="flex flex-col gap-1 t-hint">
            {t('fest.festDate')}
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              className={cn(fieldCls, 'w-36')}
            />
          </label>
          <label className="flex flex-col gap-1 t-hint">
            {t('fest.deadline')}
            <input
              type="date"
              value={form.applyDeadline}
              onChange={(e) => setForm({ ...form, applyDeadline: e.target.value })}
              className={cn(fieldCls, 'w-36')}
            />
          </label>
          <label className="flex flex-col gap-1 t-hint">
            {t('fest.url')}
            <input
              placeholder="https://…"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              className={cn(fieldCls, 'w-48')}
            />
          </label>
          <Button
            size="sm"
            onClick={() => form.name.trim() && form.startDate && create.mutate()}
            disabled={!form.name.trim() || !form.startDate || create.isPending}
          >
            {t('common.create')}
          </Button>
        </div>
      )}

      {list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{t('fest.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-[10px] bg-surface shadow-hard">
          <div className="min-w-[1000px]">
            <div className="flex h-9 items-center gap-x-2 border-b border-border bg-surface-2 px-3">
              {gameId && <span className="w-10 shrink-0" />}
              <SortableHeader
                label={t('fest.col.name')}
                active={sort.key === 'name'}
                direction={sort.direction}
                onClick={() => changeSort('name')}
                className="min-w-0 flex-1"
              />
              <SortableHeader
                label={t('fest.organizer')}
                active={sort.key === 'organizer'}
                direction={sort.direction}
                onClick={() => changeSort('organizer')}
                className="w-32"
              />
              <SortableHeader
                label={t('fest.col.date')}
                active={sort.key === 'date'}
                direction={sort.direction}
                onClick={() => changeSort('date')}
                className="w-36"
              />
              <SortableHeader
                label={t('fest.col.deadline')}
                active={sort.key === 'deadline'}
                direction={sort.direction}
                onClick={() => changeSort('deadline')}
                className="w-28"
              />
              <SortableHeader
                label={t('common.costUsd')}
                active={sort.key === 'cost'}
                direction={sort.direction}
                onClick={() => changeSort('cost')}
                align="right"
                className="w-24"
              />
              <SortableHeader
                label={gameId ? t('fest.col.status') : t('fest.col.participants')}
                active={sort.key === 'status'}
                direction={sort.direction}
                onClick={() => changeSort('status')}
                align="right"
                className="w-40"
              />
            </div>

            {rows.map((f) => {
              const picked = statusOf.has(f.id)
              const parts = participantsBy.get(f.id) ?? []
              const past = isPastFest(f, todayStr)
              const d = dday(f.applyDeadline)
              return (
                <div
                  key={f.id}
                  className={cn(
                    'render-skip border-b border-l-[4px] border-b-border bg-surface transition-colors last:border-b-0 hover:bg-surface-2/60',
                    gameId && picked
                      ? CARD_STATE_STYLES[FESTIVAL_STATUS_TONES[(statusOf.get(f.id) ?? 'none') as FestivalStatus]].spine
                      : 'border-l-transparent',
                    past && 'text-muted',
                  )}
                >
                  <div className="flex min-h-10 items-center gap-x-2 px-3 text-sm">
                    {gameId && (
                      <button
                        onClick={() => pickMut.mutate({ industryEventId: f.id, on: !picked })}
                        title={t('fest.pick')}
                        className={cn(
                          'tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] transition-colors',
                          picked ? 'text-accent' : 'text-muted hover:text-text',
                        )}
                      >
                        <Star className={cn('h-4 w-4', picked && 'fill-current')} />
                      </button>
                    )}
                    <button
                      onClick={() => openFestival(f.id)}
                      title={t('fest.details')}
                      className="tap flex h-10 min-w-0 flex-1 items-center rounded-[var(--radius)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{f.name}</span>
                        <span className="shrink-0 rounded-[5px] bg-surface-2 px-1.5 py-0.5 t-caption text-muted">
                          {f.type}
                        </span>
                      </span>
                    </button>
                    <span className="w-32 shrink-0 truncate text-xs text-muted">
                      {f.organizer || <span className="opacity-50">—</span>}
                    </span>
                    <span
                      className="nums w-36 shrink-0 whitespace-nowrap text-xs text-muted"
                      title={f.endDate ?? undefined}
                    >
                      {f.startDate || <span className="opacity-50">{t('fest.noDate')}</span>}
                      {f.endDate && f.endDate !== f.startDate && (
                        <span className="opacity-70"> – {f.endDate.slice(5)}</span>
                      )}
                    </span>
                    <span className="nums w-28 shrink-0 text-xs">
                      {f.applyDeadline ? (
                        <span
                          className={cn(
                            d != null && d < 0 && 'text-muted line-through',
                            d != null && d >= 0 && d <= 14 && 'font-medium text-alarm',
                            d != null && d > 14 && d <= 30 && 'text-warning',
                            (d == null || d > 30) && 'text-muted',
                          )}
                        >
                          {f.applyDeadline}
                        </span>
                      ) : (
                        <span className="text-muted opacity-50">{t('fest.noDeadline')}</span>
                      )}
                    </span>
                    <span className="nums w-24 shrink-0 text-right text-xs text-muted">
                      {f.costUsd == null ? (
                        <span className="opacity-50">—</span>
                      ) : f.costUsd === 0 ? (
                        <span className="text-success">{t('common.free')}</span>
                      ) : (
                        `$${f.costUsd.toLocaleString('en-US')}`
                      )}
                    </span>
                    <div className="flex w-40 shrink-0 items-center justify-end">
                      {gameId && picked ? (
                        <StatusSelect
                          value={(statusOf.get(f.id) ?? 'none') as FestivalStatus}
                          options={statusOptions}
                          onChange={(status) => setStatus.mutate({ industryEventId: f.id, status })}
                          toneClassName={
                            CARD_STATE_STYLES[FESTIVAL_STATUS_TONES[(statusOf.get(f.id) ?? 'none') as FestivalStatus]]
                              .control
                          }
                          ariaLabel={t('fest.statusHint')}
                          className="w-full"
                        />
                      ) : !gameId ? (
                        parts.length ? (
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            {parts.map((p) => (
                              <span
                                key={p.gameId}
                                title={`${p.gameName} — ${t(`fest.st.${p.status}` as 'fest.st.none')}`}
                                className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs"
                              >
                                <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                                <span className="max-w-[72px] truncate">{p.gameName}</span>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-muted opacity-60">{t('fest.noParticipants')}</span>
                        )
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {selectedFestival && (
        <FestivalDrawer
          key={selectedFestival.id}
          f={selectedFestival}
          gameId={gameId}
          status={statusOf.get(selectedFestival.id)}
          onStatusChange={(status) => setStatus.mutate({ industryEventId: selectedFestival.id, status })}
          onAskCat={() => askCat(selectedFestival)}
          onSaved={invalidate}
          onClose={closeFestival}
          onDelete={() =>
            void confirm({
              title: t('common.deleteQ', { name: selectedFestival.name }),
              danger: true,
              confirmLabel: t('common.delete'),
            }).then((ok) => {
              if (ok) {
                remove.mutate(selectedFestival.id)
                closeFestival()
              }
            })
          }
        />
      )}
    </div>
  )
}

const TRI = ['', 'yes', 'maybe', 'no'] as const
const boolToSel = (v: boolean | null | undefined) => (v === true ? 'yes' : v === false ? 'no' : '')
const selToBool = (s: string): boolean | null => (s === 'yes' ? true : s === 'no' ? false : null)

function FestivalDrawer({
  f,
  gameId,
  status,
  onStatusChange,
  onAskCat,
  onSaved,
  onClose,
  onDelete,
}: {
  f: Festival
  gameId?: string
  status?: string
  onStatusChange: (status: string) => void
  onAskCat: () => void
  onSaved: () => void
  onClose: () => void
  onDelete: () => void
}) {
  const t = useT()
  const [s, setS] = useState({
    name: f.name,
    type: f.type ?? 'festival',
    startDate: f.startDate ?? '',
    endDate: f.endDate ?? '',
    applyDeadline: f.applyDeadline ?? '',
    url: f.url ?? '',
    applyUrl: f.applyUrl ?? '',
    organizer: f.organizer ?? '',
    description: f.description ?? '',
    notes: f.notes ?? '',
    steamEvent: f.steamEvent ?? '',
    steamFeature: f.steamFeature ?? '',
    media: boolToSel(f.media),
    offline: boolToSel(f.offline),
    costUsd: f.costUsd == null ? '' : String(f.costUsd),
  })
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: () =>
      trpc.festivals.update.mutate({
        id: f.id,
        name: s.name.trim() || f.name,
        type: s.type.trim() || 'festival',
        startDate: s.startDate || f.startDate,
        endDate: s.endDate || null,
        applyDeadline: s.applyDeadline || null,
        url: s.url.trim() || null,
        applyUrl: s.applyUrl.trim() || null,
        organizer: s.organizer.trim() || null,
        description: s.description.trim() || null,
        notes: s.notes.trim() || null,
        steamEvent: s.steamEvent || null,
        steamFeature: s.steamFeature || null,
        media: selToBool(s.media),
        offline: selToBool(s.offline),
        costUsd: s.costUsd.trim() === '' ? null : Number(s.costUsd) || 0,
      }),
    onSuccess: () => {
      setSaved(true)
      onSaved()
      setTimeout(() => setSaved(false), 1500)
    },
    onError: toast.fromError,
  })

  const triLabel = (v: string) => t(`fest.tri.${v || 'unknown'}` as 'fest.tri.unknown')
  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label className="grid min-w-0 gap-1 t-hint">
      {label}
      {children}
    </label>
  )

  return (
    <DetailDrawer
      label={t('mtype.festival')}
      meta={<span className="text-xs text-muted">{f.type}</span>}
      onClose={onClose}
      width="wide"
    >
      <textarea
        value={s.name}
        onChange={(e) => setS({ ...s, name: e.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
        rows={1}
        aria-label={t('fest.name')}
        className="block w-full resize-none overflow-hidden bg-transparent t-subtitle text-balance text-text outline-none [field-sizing:content] focus-visible:ring-0"
      />

      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_272px]">
        <main className="min-w-0 space-y-4">
          <section className={festivalDrawerPanel}>
            <h2 className={festivalDrawerSectionLabel}>{t('fest.description')}</h2>
            <textarea
              rows={6}
              value={s.description}
              onChange={(e) => setS({ ...s, description: e.target.value })}
              className={cn(fieldCls, 'mt-2 resize-y leading-relaxed')}
            />
          </section>

          <section className={festivalDrawerPanel}>
            <h2 className={festivalDrawerSectionLabel}>{t('fest.notes')}</h2>
            <textarea
              rows={4}
              value={s.notes}
              onChange={(e) => setS({ ...s, notes: e.target.value })}
              className={cn(fieldCls, 'mt-2 resize-y leading-relaxed')}
            />
          </section>

          {gameId && (
            <section className={festivalDrawerPanel}>
              <ActivityLog
                gameId={gameId}
                subjectType="festival"
                subjectId={f.id}
                statusOptions={STATUSES.map((status) => ({ value: status, label: t(`fest.st.${status}`) }))}
                onChanged={onSaved}
              />
            </section>
          )}
        </main>

        <aside className="min-w-0 space-y-3 md:sticky md:top-0">
          <section className={festivalDrawerPanel}>
            <div className="grid gap-3">
              {status && (
                <Field label={t('fest.col.status')}>
                  <StatusSelect
                    value={status as FestivalStatus}
                    options={STATUSES.map((value) => ({ value, label: t(`fest.st.${value}`) }))}
                    onChange={onStatusChange}
                    toneClassName={CARD_STATE_STYLES[FESTIVAL_STATUS_TONES[status as FestivalStatus]].control}
                    ariaLabel={t('fest.col.status')}
                    className="w-full"
                  />
                </Field>
              )}
              <Field label={t('fest.type')}>
                <input value={s.type} onChange={(e) => setS({ ...s, type: e.target.value })} className={fieldCls} />
              </Field>
              <Field label={t('common.costUsd')}>
                <input
                  type="number"
                  min={0}
                  placeholder={t('fest.feeFree')}
                  value={s.costUsd}
                  onChange={(e) => setS({ ...s, costUsd: e.target.value })}
                  className={fieldCls}
                />
              </Field>
              <Field label={t('fest.festDate')}>
                <input
                  type="date"
                  value={s.startDate}
                  onChange={(e) => setS({ ...s, startDate: e.target.value })}
                  className={fieldCls}
                />
              </Field>
              <Field label={t('fest.endDate')}>
                <input
                  type="date"
                  value={s.endDate}
                  onChange={(e) => setS({ ...s, endDate: e.target.value })}
                  className={fieldCls}
                />
              </Field>
              <Field label={t('fest.deadline')}>
                <input
                  type="date"
                  value={s.applyDeadline}
                  onChange={(e) => setS({ ...s, applyDeadline: e.target.value })}
                  className={fieldCls}
                />
              </Field>
            </div>
          </section>

          <section className={festivalDrawerPanel}>
            <div className="grid gap-3">
              <Field label={t('fest.organizer')}>
                <input
                  value={s.organizer}
                  onChange={(e) => setS({ ...s, organizer: e.target.value })}
                  className={fieldCls}
                />
              </Field>
              <Field label={t('fest.url')}>
                <input
                  placeholder="https://…"
                  value={s.url}
                  onChange={(e) => setS({ ...s, url: e.target.value })}
                  className={fieldCls}
                />
              </Field>
              <Field label={t('fest.applyUrl')}>
                <input
                  placeholder="https://…"
                  value={s.applyUrl}
                  onChange={(e) => setS({ ...s, applyUrl: e.target.value })}
                  className={fieldCls}
                />
              </Field>
            </div>
          </section>

          <section className={festivalDrawerPanel}>
            <div className="grid gap-3">
              <Field label={t('fest.steamEvent')}>
                <select
                  value={s.steamEvent}
                  onChange={(e) => setS({ ...s, steamEvent: e.target.value })}
                  className={fieldCls}
                >
                  {TRI.map((v) => (
                    <option key={v} value={v}>
                      {triLabel(v)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('fest.steamFeature')}>
                <select
                  value={s.steamFeature}
                  onChange={(e) => setS({ ...s, steamFeature: e.target.value })}
                  className={fieldCls}
                >
                  {TRI.map((v) => (
                    <option key={v} value={v}>
                      {triLabel(v)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('fest.media')}>
                <select value={s.media} onChange={(e) => setS({ ...s, media: e.target.value })} className={fieldCls}>
                  <option value="">{t('fest.tri.unknown')}</option>
                  <option value="yes">{t('fest.tri.yes')}</option>
                  <option value="no">{t('fest.tri.no')}</option>
                </select>
              </Field>
              <Field label={t('fest.offline')}>
                <select
                  value={s.offline}
                  onChange={(e) => setS({ ...s, offline: e.target.value })}
                  className={fieldCls}
                >
                  <option value="">{t('fest.tri.unknown')}</option>
                  <option value="yes">{t('fest.tri.yes')}</option>
                  <option value="no">{t('fest.tri.no')}</option>
                </select>
              </Field>
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-1 pt-1">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {saved ? t('fest.saved') : t('fest.save')}
            </Button>
            {gameId && (
              <Button size="sm" variant="ghost" onClick={onAskCat}>
                <Sparkles className="h-3.5 w-3.5 text-accent" />
                {t('fest.askCat')}
              </Button>
            )}
            <Button size="icon" variant="ghost" className="ml-auto" onClick={onDelete}>
              <Trash2 className="h-4 w-4 text-alarm" />
            </Button>
          </div>
        </aside>
      </div>
    </DetailDrawer>
  )
}
