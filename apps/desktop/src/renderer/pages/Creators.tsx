import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { Mail, Plus, Search, Send, Sparkles, Star, Trash2 } from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { useCompanion } from '@/store/companion'
import { confirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { IconToggle, Segmented } from '@/components/ui/Toggle'
import { useT } from '@/i18n/useT'
import { ActivityLog } from '@/components/activities/ActivityLog'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { DetailDrawer } from '@/components/ui/DetailDrawer'
import { compareListValues, SortableHeader, StatusSelect, type SortDirection } from '@/components/ui/DataList'
import { TaskCard } from '@/components/tasks/TaskCard'
import { TaskDrawer } from '@/components/tasks/TaskDrawer'
import { GmassCampaignDialog } from '@/components/creators/GmassCampaignDialog'

type Creator = Awaited<ReturnType<typeof trpc.creators.list.query>>[number]
type Contact = { type?: string; value?: string; sourceUrl?: string; verified?: boolean; gated?: boolean }

const STATUSES = ['prospect', 'contacted', 'replied', 'agreed', 'published', 'closed'] as const
type CreatorStatus = (typeof STATUSES)[number]
type CreatorSortKey = 'name' | 'platform' | 'audience' | 'cost' | 'fit' | 'status'
type CreatorSort = { key: CreatorSortKey; direction: SortDirection }
const emptyForm = { name: '', handle: '', kind: 'youtuber', primaryPlatform: 'youtube' }

const creatorDefaultSort = (gameId?: string): CreatorSort =>
  gameId ? { key: 'fit', direction: 'desc' } : { key: 'audience', direction: 'desc' }

function creatorStatusTone(status: CreatorStatus): string {
  if (status === 'contacted') return 'border-info/25 bg-info/10 text-info'
  if (status === 'replied') return 'border-warning/25 bg-warning/10 text-warning'
  if (status === 'agreed') return 'border-accent/25 bg-accent/10 text-accent'
  if (status === 'published') return 'border-success/25 bg-success/10 text-success'
  if (status === 'closed') return 'border-border bg-bg text-muted'
  return 'border-border bg-surface-2 text-muted'
}

function parseContacts(json?: string | null): Contact[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
function parseTopics(json?: string | null): string[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

function parseStringList(json?: string | null): string[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr)
      ? arr
          .map(String)
          .map((value) => value.trim())
          .filter(Boolean)
      : []
  } catch {
    return []
  }
}

function listFromText(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

export function Creators() {
  const t = useT()
  const { gameId } = useParams<{ gameId?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const setCurrentGame = useUi((s) => s.setCurrentGame)
  const react = useCompanion((s) => s.react)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [gmassOpen, setGmassOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [onlyPicked, setOnlyPicked] = useState(!!gameId)
  const [openId, setOpenId] = useState<string | null>(() => searchParams.get('creator'))
  const [view, setView] = useState<'list' | 'board'>('list')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<CreatorSort>(() => creatorDefaultSort(gameId))

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
    setOnlyPicked(!!gameId)
    setSort(creatorDefaultSort(gameId))
  }, [gameId, setCurrentGame])

  useEffect(() => {
    setOpenId(searchParams.get('creator'))
  }, [searchParams])

  const openCreator = (id: string) => {
    setOpenId(id)
    const next = new URLSearchParams(searchParams)
    next.set('creator', id)
    setSearchParams(next, { replace: true })
  }
  const closeCreator = () => {
    setOpenId(null)
    const next = new URLSearchParams(searchParams)
    next.delete('creator')
    setSearchParams(next, { replace: true })
  }

  const list = useQuery({ queryKey: ['creators'], queryFn: () => trpc.creators.list.query() })
  const picks = useQuery({
    queryKey: ['creator-picks', gameId],
    queryFn: () => trpc.creators.picks.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const participation = useQuery({
    queryKey: ['creator-participation'],
    queryFn: () => trpc.creators.participation.query(),
    enabled: !gameId,
  })
  const fit = useQuery({
    queryKey: ['creator-fit', gameId],
    queryFn: () => trpc.creators.fit.query({ gameId: gameId! }),
    enabled: !!gameId,
  })

  // Nudge on entry when creators are awaiting a reply (contacted but no answer yet).
  useEffect(() => {
    if (!gameId || !picks.data) return
    const awaiting = picks.data.filter((p) => p.pipelineStatus === 'contacted').length
    if (awaiting > 0) react('outreachDue', { n: awaiting })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, picks.data])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['creators'] })
    qc.invalidateQueries({ queryKey: ['creator-picks', gameId] })
    qc.invalidateQueries({ queryKey: ['creator-participation'] })
    qc.invalidateQueries({ queryKey: ['creator-fit', gameId] })
  }
  const pickMut = useMutation({
    mutationFn: (v: { creatorId: string; on: boolean }) =>
      v.on
        ? trpc.creators.pick.mutate({ gameId: gameId!, creatorId: v.creatorId })
        : trpc.creators.unpick.mutate({ gameId: gameId!, creatorId: v.creatorId }),
    onSuccess: invalidate,
  })
  const create = useMutation({
    mutationFn: () =>
      trpc.creators.create.mutate({
        name: form.name.trim(),
        handle: form.handle.trim() || undefined,
        kind: form.kind,
        primaryPlatform: form.primaryPlatform || undefined,
      }),
    onSuccess: (row) => {
      setForm(emptyForm)
      setAdding(false)
      invalidate()
      if (gameId && row) pickMut.mutate({ creatorId: row.id, on: true })
    },
    onError: toast.fromError,
  })
  const remove = useMutation({
    mutationFn: (id: string) => trpc.creators.remove.mutate({ id }),
    onSuccess: invalidate,
    onError: toast.fromError,
  })
  const setStatus = useMutation({
    mutationFn: (v: { creatorId: string; status: (typeof STATUSES)[number]; name: string }) =>
      trpc.creators.setStatus.mutate({ gameId: gameId!, creatorId: v.creatorId, pipelineStatus: v.status }),
    onSuccess: (_data, v) => {
      qc.invalidateQueries({ queryKey: ['creator-picks', gameId] })
      qc.invalidateQueries({ queryKey: ['creator-fit', gameId] })
      // Cat reacts to meaningful pipeline moves (deterministic, no LLM).
      if (v.status === 'replied') react('creatorReplied', { name: v.name })
      else if (v.status === 'published') react('creatorPublished', { name: v.name })
    },
  })

  const pickBy = useMemo(() => new Map((picks.data ?? []).map((p) => [p.creatorId, p])), [picks.data])
  useEffect(() => {
    const linkedCreator = searchParams.get('creator')
    if (linkedCreator && picks.data && !pickBy.has(linkedCreator)) setOnlyPicked(false)
  }, [pickBy, picks.data, searchParams])
  const fitBy = useMemo(() => new Map((fit.data ?? []).map((f) => [f.creatorId, f])), [fit.data])
  const participantsBy = useMemo(() => {
    const m = new Map<string, { gameName: string; color: string; status: string }[]>()
    for (const p of participation.data ?? []) {
      const arr = m.get(p.creatorId) ?? []
      arr.push({ gameName: p.gameName, color: p.color, status: p.status })
      m.set(p.creatorId, arr)
    }
    return m
  }, [participation.data])

  const rows = useMemo(() => {
    const filtered = (list.data ?? []).filter((c) => {
      if (gameId && onlyPicked && !pickBy.has(c.id)) return false
      const needle = search.trim().toLocaleLowerCase()
      if (
        needle &&
        ![
          c.name,
          c.handle,
          c.kind,
          c.primaryPlatform,
          c.language,
          c.region,
          ...parseTopics(c.topicsJson),
          ...parseStringList(c.playedGamesJson),
        ].some((value) => value?.toLocaleLowerCase().includes(needle))
      )
        return false
      return true
    })
    const value = (creator: Creator): string | number | null | undefined => {
      if (sort.key === 'name') return creator.name
      if (sort.key === 'platform') return creator.primaryPlatform || creator.kind
      if (sort.key === 'audience') return creator.audience
      if (sort.key === 'cost') return creator.costUsd ?? (creator.acceptsKeysOnly ? 0 : null)
      if (sort.key === 'fit') return fitBy.get(creator.id)?.score
      if (gameId) {
        const status = pickBy.get(creator.id)?.pipelineStatus as CreatorStatus | undefined
        return status ? STATUSES.indexOf(status) : null
      }
      return participantsBy.get(creator.id)?.length ?? 0
    }
    return [...filtered].sort((a, b) => {
      const compared = compareListValues(value(a), value(b), sort.direction)
      return compared || a.name.localeCompare(b.name)
    })
  }, [list.data, gameId, onlyPicked, pickBy, fitBy, participantsBy, search, sort])

  // Board = the picked creators grouped by pipeline stage (always shows picks, ignores the star filter).
  const boardItems = useMemo(
    () =>
      (list.data ?? [])
        .filter((c) => pickBy.has(c.id))
        .map((c) => ({ creator: c, status: pickBy.get(c.id)!.pipelineStatus, fitScore: fitBy.get(c.id)?.score })),
    [list.data, pickBy, fitBy],
  )
  const selectedCreator = openId ? (list.data ?? []).find((creator) => creator.id === openId) : undefined
  const statusOptions = STATUSES.map((status) => ({ value: status, label: t(`creators.st.${status}`) }))

  const changeSort = (key: CreatorSortKey) =>
    setSort((current) => ({
      key,
      direction:
        current.key === key
          ? current.direction === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'name' || key === 'platform'
            ? 'asc'
            : 'desc',
    }))

  const askCat = () => {
    navigate(`/g/${gameId}/ai`)
  }

  return (
    <div className="enter mx-auto max-w-6xl space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="t-title">{gameId ? t('nav.creators') : t('creators.global')}</h1>
        <div className="flex items-center gap-1.5">
          {gameId && (
            <Segmented
              ariaLabel={t('creators.view')}
              value={view}
              onChange={setView}
              items={[
                { value: 'list', label: t('creators.view.list') },
                { value: 'board', label: t('creators.view.board') },
              ]}
            />
          )}
          {gameId && view === 'list' && (
            <IconToggle active={onlyPicked} onClick={() => setOnlyPicked((v) => !v)} title={t('creators.onlyPicked')}>
              <Star className={cn('h-4 w-4', onlyPicked && 'fill-current')} />
            </IconToggle>
          )}
          {gameId && (
            <Button size="sm" variant="outline" onClick={() => setGmassOpen(true)}>
              <Send className="h-3.5 w-3.5" />
              {t('gmass.organize')}
            </Button>
          )}
          {gameId && (
            <Button size="sm" variant="outline" onClick={askCat}>
              <Sparkles className="h-3.5 w-3.5" />
              {t('creators.askCatFind')}
            </Button>
          )}
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" />
            {t('common.add')}
          </Button>
        </div>
      </div>

      {view === 'list' && (
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
      )}

      {gameId && <Funnel gameId={gameId} />}

      {adding && (
        <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius)] border border-border bg-surface p-3">
          <label className="flex flex-col gap-1 t-hint">
            {t('creators.name')}
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={cn(fieldCls, 'w-52')}
            />
          </label>
          <label className="flex flex-col gap-1 t-hint">
            {t('creators.handle')}
            <input
              placeholder="https://youtube.com/@…"
              value={form.handle}
              onChange={(e) => setForm({ ...form, handle: e.target.value })}
              className={cn(fieldCls, 'w-56')}
            />
          </label>
          <label className="flex flex-col gap-1 t-hint">
            {t('creators.kind')}
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              className={cn(fieldCls, 'w-36')}
            >
              {['youtuber', 'streamer', 'tiktoker', 'journalist', 'podcaster', 'steam_curator', 'other'].map((k) => (
                <option key={k} value={k}>
                  {t(`creators.kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            onClick={() => form.name.trim() && create.mutate()}
            disabled={!form.name.trim() || create.isPending}
          >
            {t('common.create')}
          </Button>
        </div>
      )}

      {list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <LoadingState />
      ) : gameId && view === 'board' ? (
        boardItems.length === 0 ? (
          <p className="text-sm text-muted">{t('creators.boardEmpty')}</p>
        ) : (
          <CreatorBoard
            items={boardItems}
            onMove={(creatorId, status, name) => setStatus.mutate({ creatorId, status, name })}
            onSelect={openCreator}
          />
        )
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{t('creators.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-[10px] bg-surface shadow-hard">
          <div className="min-w-[900px]">
            <div className="flex h-9 items-center gap-x-2 border-b border-border bg-surface-2 px-3">
              {gameId && <span className="w-10 shrink-0" />}
              <SortableHeader
                label={t('creators.col.name')}
                active={sort.key === 'name'}
                direction={sort.direction}
                onClick={() => changeSort('name')}
                className="min-w-0 flex-1"
              />
              <SortableHeader
                label={t('creators.platform')}
                active={sort.key === 'platform'}
                direction={sort.direction}
                onClick={() => changeSort('platform')}
                className="w-28"
              />
              <SortableHeader
                label={t('creators.col.audience')}
                active={sort.key === 'audience'}
                direction={sort.direction}
                onClick={() => changeSort('audience')}
                align="right"
                className="w-24"
              />
              <SortableHeader
                label={t('common.costUsd')}
                active={sort.key === 'cost'}
                direction={sort.direction}
                onClick={() => changeSort('cost')}
                align="right"
                className="w-24"
              />
              {gameId && (
                <SortableHeader
                  label={t('creators.col.fit')}
                  active={sort.key === 'fit'}
                  direction={sort.direction}
                  onClick={() => changeSort('fit')}
                  align="right"
                  className="w-14"
                />
              )}
              <SortableHeader
                label={gameId ? t('creators.col.status') : t('creators.col.participants')}
                active={sort.key === 'status'}
                direction={sort.direction}
                onClick={() => changeSort('status')}
                align="right"
                className="w-40"
              />
            </div>

            {rows.map((c) => {
              const picked = pickBy.has(c.id)
              const pick = pickBy.get(c.id)
              const parts = participantsBy.get(c.id) ?? []
              const f = fitBy.get(c.id)
              const contacts = parseContacts(c.contactsJson)
              return (
                <div
                  key={c.id}
                  className="render-skip border-b border-border bg-surface transition-colors last:border-b-0 hover:bg-surface-2/60"
                >
                  <div className="flex min-h-10 items-center gap-x-2 px-3 text-sm">
                    {gameId && (
                      <button
                        onClick={() => pickMut.mutate({ creatorId: c.id, on: !picked })}
                        title={t('creators.pick')}
                        className={cn(
                          'tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] transition-colors',
                          picked ? 'text-accent' : 'text-muted hover:text-text',
                        )}
                      >
                        <Star className={cn('h-4 w-4', picked && 'fill-current')} />
                      </button>
                    )}
                    <button
                      onClick={() => openCreator(c.id)}
                      className="tap flex h-10 min-w-0 flex-1 items-center rounded-[var(--radius)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{c.name}</span>
                        <span className="shrink-0 rounded-[5px] bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                          {t(`creators.kind.${c.kind}`)}
                        </span>
                        {contacts.some((contact) => contact.value) && (
                          <span title={t('creators.correspondence')} className="shrink-0 text-info">
                            <Mail className="h-3.5 w-3.5" />
                          </span>
                        )}
                        {c.doNotContact && (
                          <span className="shrink-0 rounded-[5px] bg-alarm/10 px-1.5 py-0.5 text-[11px] text-alarm">
                            {t('creators.dnc')}
                          </span>
                        )}
                      </span>
                    </button>
                    <span className="w-28 shrink-0 truncate text-xs text-muted">
                      {c.primaryPlatform || <span className="opacity-50">—</span>}
                      {c.language && <span className="opacity-70"> · {c.language}</span>}
                    </span>
                    <span className="nums w-24 shrink-0 text-right text-xs text-muted">
                      {c.audience != null ? c.audience.toLocaleString('ru-RU') : <span className="opacity-50">—</span>}
                    </span>
                    <span className="nums w-24 shrink-0 text-right text-xs text-muted">
                      {c.costUsd != null ? (
                        c.costUsd === 0 ? (
                          <span className="text-success">{t('common.free')}</span>
                        ) : (
                          `$${c.costUsd.toLocaleString('en-US')}`
                        )
                      ) : c.acceptsKeysOnly ? (
                        <span className="text-success">{t('common.free')}</span>
                      ) : (
                        <span className="opacity-50">—</span>
                      )}
                    </span>
                    {gameId && (
                      <span className="flex w-14 shrink-0 justify-end">
                        <span
                          className={cn(
                            'nums inline-flex min-w-7 justify-center rounded-[5px] px-1.5 py-0.5 text-xs font-medium',
                            fitBadgeTone(f?.score),
                          )}
                        >
                          {f ? f.score : <span className="opacity-40">—</span>}
                        </span>
                      </span>
                    )}
                    <div className="flex w-40 shrink-0 items-center justify-end">
                      {gameId && picked ? (
                        <StatusSelect
                          value={(pick?.pipelineStatus ?? 'prospect') as CreatorStatus}
                          options={statusOptions}
                          onChange={(status) =>
                            setStatus.mutate({
                              creatorId: c.id,
                              status,
                              name: c.name,
                            })
                          }
                          toneClassName={creatorStatusTone((pick?.pipelineStatus ?? 'prospect') as CreatorStatus)}
                          ariaLabel={t('creators.col.status')}
                          className="w-full"
                        />
                      ) : !gameId ? (
                        parts.length ? (
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            {parts.map((p, i) => (
                              <span
                                key={i}
                                title={`${p.gameName} — ${t(`creators.st.${p.status}` as 'creators.st.prospect')}`}
                                className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs"
                              >
                                <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                                <span className="max-w-[72px] truncate">{p.gameName}</span>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-muted opacity-60">{t('creators.noParticipants')}</span>
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

      {selectedCreator && (
        <CreatorDrawer
          key={selectedCreator.id}
          c={selectedCreator}
          gameId={gameId}
          fit={fitBy.get(selectedCreator.id)}
          status={pickBy.get(selectedCreator.id)?.pipelineStatus as (typeof STATUSES)[number] | undefined}
          keysSentJson={pickBy.get(selectedCreator.id)?.keysSentJson}
          onStatusChange={(status) =>
            setStatus.mutate({ creatorId: selectedCreator.id, status, name: selectedCreator.name })
          }
          onSaved={invalidate}
          onClose={closeCreator}
          onDelete={() =>
            void confirm({
              title: t('common.deleteQ', { name: selectedCreator.name }),
              danger: true,
              confirmLabel: t('common.delete'),
            }).then((ok) => {
              if (ok) {
                remove.mutate(selectedCreator.id)
                closeCreator()
              }
            })
          }
        />
      )}
      {gameId && (
        <GmassCampaignDialog
          open={gmassOpen}
          gameId={gameId}
          creatorIds={(picks.data ?? []).map((pick) => pick.creatorId)}
          onClose={() => setGmassOpen(false)}
        />
      )}
    </div>
  )
}

function fitColor(score?: number): string {
  if (score == null) return 'text-muted'
  if (score >= 66) return 'text-accent'
  if (score >= 40) return 'text-warning'
  return 'text-muted'
}

function fitBadgeTone(score?: number): string {
  if (score == null) return 'bg-surface-2 text-muted'
  if (score >= 66) return 'bg-accent/10 text-accent'
  if (score >= 40) return 'bg-warning/10 text-warning'
  return 'bg-surface-2 text-muted'
}

function Funnel({ gameId }: { gameId: string }) {
  const t = useT()
  const funnel = useQuery({
    queryKey: ['creator-funnel', gameId],
    queryFn: () => trpc.creators.funnel.query({ gameId }),
  })
  const d = funnel.data
  if (!d || d.total === 0) return null
  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-xs text-muted">
      <span>
        {t('creators.funnel.total')}: <span className="nums text-text">{d.total}</span>
      </span>
      <span>
        {t('creators.funnel.response')}: <span className="nums text-text">{pct(d.responseRate)}</span>
      </span>
      <span>
        {t('creators.funnel.conversion')}: <span className="nums text-text">{pct(d.conversionRate)}</span>
      </span>
      <span>
        {t('creators.funnel.touches')}:{' '}
        <span className="nums text-text">
          {d.outbound}↑ / {d.inbound}↓
        </span>
      </span>
    </div>
  )
}

function CreatorDrawer({
  c,
  gameId,
  fit,
  status,
  keysSentJson,
  onStatusChange,
  onSaved,
  onClose,
  onDelete,
}: {
  c: Creator
  gameId?: string
  fit?: { score: number; reasons: string[] }
  status?: (typeof STATUSES)[number]
  keysSentJson?: string | null
  onStatusChange: (status: (typeof STATUSES)[number]) => void
  onSaved: () => void
  onClose: () => void
  onDelete: () => void
}) {
  const t = useT()
  const contacts = parseContacts(c.contactsJson)
  const topics = parseTopics(c.topicsJson)
  const [s, setS] = useState({
    name: c.name,
    handle: c.handle ?? '',
    primaryPlatform: c.primaryPlatform ?? '',
    audience: c.audience == null ? '' : String(c.audience),
    language: c.language ?? '',
    region: c.region ?? '',
    costUsd: c.costUsd == null ? '' : String(c.costUsd),
    acceptsKeysOnly: !!c.acceptsKeysOnly,
    doNotContact: !!c.doNotContact,
    notes: c.notes ?? '',
    playedGames: parseStringList(c.playedGamesJson).join('\n'),
    keysSent: parseStringList(keysSentJson).join('\n'),
  })
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: async () => {
      const playedGames = listFromText(s.playedGames)
      const updateCreator = trpc.creators.update.mutate({
        id: c.id,
        name: s.name.trim() || c.name,
        handle: s.handle.trim() || null,
        primaryPlatform: s.primaryPlatform.trim() || null,
        audience: s.audience.trim() === '' ? null : Number(s.audience) || 0,
        language: s.language.trim() || null,
        region: s.region.trim() || null,
        costUsd: s.costUsd.trim() === '' ? null : Number(s.costUsd) || 0,
        acceptsKeysOnly: s.acceptsKeysOnly,
        doNotContact: s.doNotContact,
        notes: s.notes.trim() || null,
        playedGamesJson: playedGames.length ? JSON.stringify(playedGames) : null,
      })
      if (gameId && status) {
        const keysSent = listFromText(s.keysSent)
        await Promise.all([
          updateCreator,
          trpc.creators.updatePick.mutate({
            gameId,
            creatorId: c.id,
            keysSentJson: keysSent.length ? JSON.stringify(keysSent) : null,
          }),
        ])
      } else {
        await updateCreator
      }
    },
    onSuccess: () => {
      setSaved(true)
      onSaved()
      setTimeout(() => setSaved(false), 1500)
    },
    onError: toast.fromError,
  })

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label className="flex flex-col gap-1 t-hint">
      {label}
      {children}
    </label>
  )

  return (
    <DetailDrawer
      label={t(`creators.kind.${c.kind}`)}
      meta={fit && <span className={cn('nums text-xs font-medium', fitColor(fit.score))}>{fit.score}</span>}
      onClose={onClose}
    >
      <input
        value={s.name}
        onChange={(e) => setS({ ...s, name: e.target.value })}
        aria-label={t('creators.name')}
        className={cn(fieldCls, 'text-base font-medium')}
      />

      {/* Fit reasons (per-game). */}
      {gameId && fit && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn('nums t-hint', fitColor(fit.score))}>
            {t('creators.fit')}: {fit.score}
          </span>
          {fit.reasons.slice(0, 5).map((r, i) => (
            <span key={i} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">
              {r}
            </span>
          ))}
        </div>
      )}

      {/* Contacts. */}
      {contacts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {contacts.map((ct, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs">
              <Mail className="h-3 w-3 text-muted" />
              <span className="nums">{ct.value}</span>
              {ct.gated && (
                <span className="text-warning" title={t('creators.gatedHint')}>
                  ⚠
                </span>
              )}
              {ct.verified && (
                <span className="text-accent" title={t('creators.verified')}>
                  ✓
                </span>
              )}
            </span>
          ))}
        </div>
      )}
      {topics.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {topics.map((tp, i) => (
            <span key={i} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">
              #{tp}
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {status && (
          <Field label={t('creators.col.status')}>
            <select
              value={status}
              onChange={(e) => onStatusChange(e.target.value as (typeof STATUSES)[number])}
              className={fieldCls}
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`creators.st.${value}`)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('creators.handle')}>
          <input value={s.handle} onChange={(e) => setS({ ...s, handle: e.target.value })} className={fieldCls} />
        </Field>
        <Field label={t('creators.platform')}>
          <input
            value={s.primaryPlatform}
            onChange={(e) => setS({ ...s, primaryPlatform: e.target.value })}
            className={fieldCls}
          />
        </Field>
        <Field label={t('creators.audience')}>
          <input
            type="number"
            min={0}
            value={s.audience}
            onChange={(e) => setS({ ...s, audience: e.target.value })}
            className={fieldCls}
          />
        </Field>
        <Field label={t('creators.language')}>
          <input
            placeholder="en, ru…"
            value={s.language}
            onChange={(e) => setS({ ...s, language: e.target.value })}
            className={fieldCls}
          />
        </Field>
        <Field label={t('creators.region')}>
          <input value={s.region} onChange={(e) => setS({ ...s, region: e.target.value })} className={fieldCls} />
        </Field>
        <Field label={t('common.costUsd')}>
          <input
            type="number"
            min={0}
            placeholder={t('creators.rateFree')}
            value={s.costUsd}
            onChange={(e) => setS({ ...s, costUsd: e.target.value })}
            className={fieldCls}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-h-10 items-center gap-2 rounded-[var(--radius)] px-2.5 t-hint hover:bg-surface-2">
          <input
            type="checkbox"
            checked={s.acceptsKeysOnly}
            onChange={(e) => setS({ ...s, acceptsKeysOnly: e.target.checked })}
          />
          {t('creators.keysOnly')}
        </label>
        <label className="flex min-h-10 items-center gap-2 rounded-[var(--radius)] px-2.5 t-hint hover:bg-surface-2">
          <input
            type="checkbox"
            checked={s.doNotContact}
            onChange={(e) => setS({ ...s, doNotContact: e.target.checked })}
          />
          {t('creators.dnc')}
        </label>
      </div>

      <Field label={t('creators.playedGames')}>
        <textarea
          rows={3}
          value={s.playedGames}
          onChange={(e) => setS({ ...s, playedGames: e.target.value })}
          placeholder={t('creators.playedGamesHint')}
          className={cn(fieldCls, 'resize-y leading-relaxed')}
        />
      </Field>

      {gameId && status && (
        <Field label={t('creators.keysSent')}>
          <textarea
            rows={3}
            value={s.keysSent}
            onChange={(e) => setS({ ...s, keysSent: e.target.value })}
            placeholder={t('creators.keysSentHint')}
            autoComplete="off"
            spellCheck={false}
            className={cn(fieldCls, 'resize-y font-mono text-xs leading-relaxed')}
          />
        </Field>
      )}

      <Field label={t('creators.notes')}>
        <textarea
          rows={2}
          value={s.notes}
          onChange={(e) => setS({ ...s, notes: e.target.value })}
          className={cn(fieldCls, 'resize-y leading-relaxed')}
        />
      </Field>

      <div className="mt-2 flex items-center justify-between border-t border-border pt-3">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {saved ? t('common.save') + ' ✓' : t('common.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete}>
          <Trash2 className="h-4 w-4 text-alarm" />
          {t('common.delete')}
        </Button>
      </div>

      {/* Correspondence CRM (per game only). */}
      {gameId && <Correspondence gameId={gameId} creator={c} />}
    </DetailDrawer>
  )
}

type BoardItem = { creator: Creator; status: string; fitScore?: number }

function BoardCard({ item, onSelect }: { item: BoardItem; onSelect: (id: string) => void }) {
  const t = useT()
  const { creator: c, fitScore } = item
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: c.id })
  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      className={cn(
        'cursor-grab rounded-[var(--radius)] border border-border bg-surface p-2.5 text-sm shadow-hard hover:bg-surface-2 active:cursor-grabbing',
        isDragging && 'opacity-50',
      )}
      {...listeners}
      {...attributes}
      onClick={() => onSelect(c.id)}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate">{c.name}</span>
        {fitScore != null && (
          <span className={cn('nums shrink-0 text-xs font-medium', fitColor(fitScore))}>{fitScore}</span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted">
        <span className="rounded bg-surface-2 px-1">{t(`creators.kind.${c.kind}`)}</span>
        {c.audience != null && <span className="nums">{c.audience.toLocaleString('ru-RU')}</span>}
        {c.doNotContact && <span className="text-alarm">{t('creators.dnc')}</span>}
      </div>
    </div>
  )
}

function CreatorBoard({
  items,
  onMove,
  onSelect,
}: {
  items: BoardItem[]
  onMove: (creatorId: string, status: (typeof STATUSES)[number], name: string) => void
  onSelect: (id: string) => void
}) {
  const t = useT()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return
    const status = e.over.id as (typeof STATUSES)[number]
    const item = items.find((i) => i.creator.id === e.active.id)
    if (item && item.status !== status) onMove(item.creator.id, status, item.creator.name)
  }
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STATUSES.map((status) => {
          const col = items.filter((i) => i.status === status)
          return (
            <BoardColumn
              key={status}
              status={status}
              items={col}
              onSelect={onSelect}
              label={`${t(`creators.st.${status}`)}`}
            />
          )
        })}
      </div>
    </DndContext>
  )
}

function BoardColumn({
  status,
  items,
  onSelect,
  label,
}: {
  status: string
  items: BoardItem[]
  onSelect: (id: string) => void
  label: string
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <div className="flex min-w-[150px] flex-1 flex-col">
      <div className="mb-1.5 flex items-center gap-2 t-hint">
        {label}
        <span className="nums text-muted/60">{items.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-24 flex-1 flex-col gap-2 rounded-[var(--radius)] border border-dashed border-border p-2 transition-colors',
          isOver && 'border-accent bg-accent/5',
        )}
      >
        {items.map((i) => (
          <BoardCard key={i.creator.id} item={i} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

function Correspondence({ gameId, creator }: { gameId: string; creator: Creator }) {
  const t = useT()
  const qc = useQueryClient()
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const tasks = useQuery({
    queryKey: ['creator-tasks', gameId, creator.id],
    queryFn: () => trpc.creators.tasksFor.query({ gameId, creatorId: creator.id }),
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['creator-funnel', gameId] })
    qc.invalidateQueries({ queryKey: ['creator-picks', gameId] })
    qc.invalidateQueries({ queryKey: ['creator-fit', gameId] })
  }
  return (
    <div className="space-y-3">
      <ActivityLog
        gameId={gameId}
        subjectType="creator"
        subjectId={creator.id}
        statusOptions={STATUSES.map((status) => ({ value: status, label: t(`creators.st.${status}`) }))}
        onChanged={invalidate}
      />
      {(tasks.data ?? []).length > 0 && (
        <div className="space-y-2">
          <div className="t-hint">{t('creators.linkedTasks')}</div>
          {(tasks.data ?? []).map((task) => (
            <TaskCard key={task.id} task={task} onOpen={setSelectedTaskId} />
          ))}
        </div>
      )}
      {selectedTaskId && <TaskDrawer taskId={selectedTaskId} gameId={gameId} onClose={() => setSelectedTaskId(null)} />}
    </div>
  )
}
