import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref as ReactRef,
  type ReactNode,
} from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ChevronRight, ExternalLink, Mail, Plus, Search, Send, Star, Trash2 } from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { EMPTY_SECTION_VIEW_STATE, useUi } from '@/store/ui'
import { useCompanion } from '@/store/companion'
import { confirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { IconToggle, Segmented } from '@/components/ui/Toggle'
import { PageHeader } from '@/components/ui/Screen'
import { useT } from '@/i18n/useT'
import { ActivityLog } from '@/components/activities/ActivityLog'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { DetailDrawer } from '@/components/ui/DetailDrawer'
import { compareListValues, SortableHeader, StatusSelect, type SortDirection } from '@/components/ui/DataList'
import { CARD_STATE_STYLES, CardStateBadge, CardSurface, type CardStateTone } from '@/components/ui/CardState'
import { TaskCard } from '@/components/tasks/TaskCard'
import { TaskDrawer } from '@/components/tasks/TaskDrawer'
import { GmassCampaignDialog } from '@/components/creators/GmassCampaignDialog'
import { CreatorDiscovery } from '@/components/creators/CreatorDiscovery'
import { LanguageBadge } from '@/components/creators/LanguageBadge'

type Creator = Awaited<ReturnType<typeof trpc.creators.list.query>>[number]
type Contact = { type?: string; value?: string; sourceUrl?: string; verified?: boolean; gated?: boolean }
type CreatorEntityType = 'person' | 'media'
type CreatorChannel = { platform?: string; [key: string]: unknown }

const STATUSES = ['prospect', 'contacted', 'replied', 'agreed', 'published', 'closed'] as const
type CreatorStatus = (typeof STATUSES)[number]
type CreatorSortKey = 'name' | 'platform' | 'audience' | 'cost' | 'fit' | 'status'
type CreatorSort = { key: CreatorSortKey; direction: SortDirection }
const CREATOR_SORT_KEYS: CreatorSortKey[] = ['name', 'platform', 'audience', 'cost', 'fit', 'status']
type CreatorBoardSortKey = 'fit' | 'audience' | 'name' | 'cost'
const CREATOR_BOARD_SORT_KEYS: CreatorBoardSortKey[] = ['fit', 'audience', 'name', 'cost']
const BOARD_CARD_PITCH = 96
const BOARD_OVERSCAN_ROWS = 12
const BOARD_RANGE_BUFFER_ROWS = 6
const BOARD_INITIAL_ROWS = 24
const PLATFORM_OPTIONS = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'twitch', label: 'Twitch' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'twitter', label: 'X' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'vk', label: 'VK' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'steam', label: 'Steam' },
  { value: 'podcast', label: 'Podcast' },
  { value: 'website', label: 'Website' },
] as const
const PLATFORM_LABELS = new Map<string, string>(PLATFORM_OPTIONS.map((option) => [option.value, option.label]))
const STANDARD_METRIC_FORMATTER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const COMPACT_METRIC_FORMATTER = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const emptyForm = {
  name: '',
  handle: '',
  kind: 'youtuber',
  entityType: 'person' as CreatorEntityType,
  platforms: ['youtube'],
}

const creatorDefaultSort = (gameId?: string): CreatorSort =>
  gameId ? { key: 'fit', direction: 'desc' } : { key: 'audience', direction: 'desc' }

const creatorBoardDefaultDirection = (key: CreatorBoardSortKey): SortDirection => (key === 'name' ? 'asc' : 'desc')

const CREATOR_STATUS_TONES: Record<CreatorStatus, CardStateTone> = {
  prospect: 'neutral',
  contacted: 'neutral',
  replied: 'warning',
  agreed: 'success',
  published: 'success',
  closed: 'danger',
}
const drawerPanel = 'rounded-[12px] bg-bg/55 p-3 shadow-hard'
const drawerSectionLabel = 't-hint font-medium text-text'

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

function parseChannels(json?: string | null): CreatorChannel[] {
  if (!json) return []
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value)
      ? value.filter((channel): channel is CreatorChannel => !!channel && typeof channel === 'object')
      : []
  } catch {
    return []
  }
}

function creatorPlatforms(creator: Pick<Creator, 'channelsJson' | 'primaryPlatform'>): string[] {
  const platforms = [creator.primaryPlatform, ...parseChannels(creator.channelsJson).map((channel) => channel.platform)]
  return [...new Set(platforms.map((platform) => platform?.trim().toLowerCase()).filter(Boolean) as string[])]
}

function channelsWithPlatforms(json: string | null | undefined, platforms: string[]): string | null {
  if (!platforms.length) return null
  const existing = new Map(
    parseChannels(json)
      .filter((channel) => channel.platform)
      .map((channel) => [channel.platform!.trim().toLowerCase(), channel]),
  )
  return JSON.stringify(platforms.map((platform) => existing.get(platform) ?? { platform }))
}

function platformLabel(platform: string): string {
  return PLATFORM_LABELS.get(platform) ?? platform
}

function creatorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0] ?? ''}` : parts[0]?.slice(0, 2) || '?').toUpperCase()
}

function CreatorAvatar({ name, src }: { name: string; src?: string | null }) {
  const [imageFailed, setImageFailed] = useState(false)

  return (
    <span
      className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/10 text-base font-semibold text-accent shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06),0_2px_6px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
      aria-hidden
    >
      {creatorInitials(name)}
      {src && !imageFailed && (
        <img
          src={src}
          alt=""
          onError={() => setImageFailed(true)}
          className="absolute inset-0 h-full w-full rounded-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        />
      )}
    </span>
  )
}

function PlatformPicker({ value, onChange }: { value: string[]; onChange: (platforms: string[]) => void }) {
  const options = [
    ...PLATFORM_OPTIONS,
    ...value
      .filter((platform) => !PLATFORM_LABELS.has(platform))
      .map((platform) => ({ value: platform, label: platform })),
  ]
  const toggle = (platform: string) =>
    onChange(value.includes(platform) ? value.filter((item) => item !== platform) : [...value, platform])
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const selected = value.includes(option.value)
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => toggle(option.value)}
            className={cn(
              'inline-flex min-h-10 items-center rounded-full px-3 text-xs font-medium transition-[background-color,color,box-shadow,scale] duration-150 ease-out active:scale-[0.96]',
              selected
                ? 'bg-accent/10 text-accent shadow-[inset_0_0_0_1px_currentColor]'
                : 'bg-surface-2 text-muted shadow-[inset_0_0_0_1px_var(--color-border)] hover:text-text',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function FormPlatformPicker({ initialValue }: { initialValue: string[] }) {
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <input type="hidden" name="platforms" value={value.join(',')} />
      <PlatformPicker value={value} onChange={setValue} />
    </>
  )
}

function FormEntityTypePicker({ initialValue }: { initialValue: CreatorEntityType }) {
  const t = useT()
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <input type="hidden" name="entityType" value={value} />
      <Segmented
        ariaLabel={t('creators.entityType')}
        value={value}
        onChange={setValue}
        items={[
          { value: 'person', label: t('creators.entityType.person') },
          { value: 'media', label: t('creators.entityType.media') },
        ]}
      />
    </>
  )
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
  const sectionKey = `creators:${gameId ?? 'global'}`
  const sectionState = useUi((state) => state.sectionViewStates?.[sectionKey] ?? EMPTY_SECTION_VIEW_STATE)
  const setSectionState = useUi((state) => state.setSectionViewState)
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedArea = gameId && searchParams.get('area') === 'discovery' ? 'discovery' : null
  const requestedRunId = requestedArea ? searchParams.get('run') : null
  const requestedPromotionId = requestedArea ? searchParams.get('promotion') : null
  const area = requestedArea ?? (gameId && sectionState.area === 'discovery' ? 'discovery' : 'crm')
  const crmActive = area === 'crm'
  const setCurrentGame = useUi((s) => s.setCurrentGame)
  const react = useCompanion((s) => s.react)
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [gmassOpen, setGmassOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const openId = searchParams.get('creator')
  const onlyPicked = typeof sectionState.onlyPicked === 'boolean' ? sectionState.onlyPicked : !!gameId
  const view: 'list' | 'board' = sectionState.view === 'board' ? 'board' : 'list'
  const search = typeof sectionState.search === 'string' ? sectionState.search : ''
  const sort = useMemo<CreatorSort>(() => {
    const fallback = creatorDefaultSort(gameId)
    return {
      key:
        typeof sectionState.sortKey === 'string' && CREATOR_SORT_KEYS.includes(sectionState.sortKey as CreatorSortKey)
          ? (sectionState.sortKey as CreatorSortKey)
          : fallback.key,
      direction:
        sectionState.sortDirection === 'asc' || sectionState.sortDirection === 'desc'
          ? sectionState.sortDirection
          : fallback.direction,
    }
  }, [gameId, sectionState.sortDirection, sectionState.sortKey])
  const boardSort = useMemo<{ key: CreatorBoardSortKey; direction: SortDirection }>(() => {
    const key =
      typeof sectionState.boardSortKey === 'string' &&
      CREATOR_BOARD_SORT_KEYS.includes(sectionState.boardSortKey as CreatorBoardSortKey)
        ? (sectionState.boardSortKey as CreatorBoardSortKey)
        : 'fit'
    return {
      key,
      direction:
        sectionState.boardSortDirection === 'asc' || sectionState.boardSortDirection === 'desc'
          ? sectionState.boardSortDirection
          : creatorBoardDefaultDirection(key),
    }
  }, [sectionState.boardSortDirection, sectionState.boardSortKey])

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
  }, [gameId, setCurrentGame])

  useEffect(() => {
    if (!gameId || requestedArea !== 'discovery') return
    setSectionState(sectionKey, { area: 'discovery' })
    if (requestedRunId || requestedPromotionId) {
      setSectionState(`creator-discovery:${gameId}`, {
        ...(requestedRunId ? { runId: requestedRunId } : {}),
        ...(requestedPromotionId ? { trackedPromotionOperationId: requestedPromotionId } : {}),
      })
    }
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete('area')
        next.delete('run')
        next.delete('promotion')
        return next
      },
      { replace: true },
    )
  }, [gameId, requestedArea, requestedPromotionId, requestedRunId, sectionKey, setSearchParams, setSectionState])

  const openCreator = useCallback(
    (id: string) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          next.set('creator', id)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  const closeCreator = useCallback(() => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete('creator')
        return next
      },
      { replace: true },
    )
  }, [setSearchParams])

  const list = useQuery({
    queryKey: ['creators'],
    queryFn: () => trpc.creators.list.query(),
    enabled: crmActive,
  })
  const picks = useQuery({
    queryKey: ['creator-picks', gameId],
    queryFn: () => trpc.creators.picks.query({ gameId: gameId! }),
    enabled: !!gameId && crmActive,
  })
  const participation = useQuery({
    queryKey: ['creator-participation'],
    queryFn: () => trpc.creators.participation.query(),
    enabled: !gameId && crmActive,
  })
  const fit = useQuery({
    queryKey: ['creator-fit', gameId],
    queryFn: () => trpc.creators.fit.query({ gameId: gameId! }),
    enabled: !!gameId && crmActive,
  })

  // Nudge on entry when creators are awaiting a reply (contacted but no answer yet).
  useEffect(() => {
    if (!crmActive || !gameId || !picks.data) return
    const awaiting = picks.data.filter((p) => p.pipelineStatus === 'contacted').length
    if (awaiting > 0) react('outreachDue', { n: awaiting })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crmActive, gameId, picks.data])

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
        entityType: form.entityType,
        handle: form.handle.trim() || undefined,
        kind: form.kind,
        primaryPlatform: form.platforms[0] || undefined,
        channelsJson: channelsWithPlatforms(null, form.platforms),
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
  const setCreatorStatus = setStatus.mutate
  const moveBoardCreator = useCallback(
    (creatorId: string, status: CreatorStatus, name: string) => setCreatorStatus({ creatorId, status, name }),
    [setCreatorStatus],
  )

  const pickBy = useMemo(() => new Map((picks.data ?? []).map((p) => [p.creatorId, p])), [picks.data])
  useEffect(() => {
    const linkedCreator = searchParams.get('creator')
    if (linkedCreator && picks.data && !pickBy.has(linkedCreator)) {
      setSectionState(sectionKey, { onlyPicked: false })
    }
  }, [pickBy, picks.data, searchParams, sectionKey, setSectionState])
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
          ...creatorPlatforms(c),
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
  const boardItems = useMemo(() => {
    const items = (list.data ?? [])
      .filter((creator) => pickBy.has(creator.id))
      .map((creator) => ({
        creator,
        status: pickBy.get(creator.id)!.pipelineStatus as CreatorStatus,
        fitScore: fitBy.get(creator.id)?.score,
      }))
    const value = (item: (typeof items)[number]): string | number | null | undefined => {
      if (boardSort.key === 'fit') return item.fitScore
      if (boardSort.key === 'audience') return item.creator.audience
      if (boardSort.key === 'cost') return item.creator.costUsd ?? (item.creator.acceptsKeysOnly ? 0 : null)
      return item.creator.name
    }
    return items.sort((a, b) => {
      const compared = compareListValues(value(a), value(b), boardSort.direction)
      return compared || a.creator.name.localeCompare(b.creator.name)
    })
  }, [boardSort, fitBy, list.data, pickBy])
  const selectedCreator = openId ? (list.data ?? []).find((creator) => creator.id === openId) : undefined
  const statusOptions = STATUSES.map((status) => ({ value: status, label: t(`creators.st.${status}`) }))

  const changeSort = (key: CreatorSortKey) => {
    const next: CreatorSort = {
      key,
      direction:
        sort.key === key
          ? sort.direction === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'name' || key === 'platform'
            ? 'asc'
            : 'desc',
    }
    setSectionState(sectionKey, { sortKey: next.key, sortDirection: next.direction })
  }

  const workspaceNavigation = gameId ? (
    <Segmented
      ariaLabel={t('creators.area')}
      value={area}
      onChange={(value) => {
        setSectionState(sectionKey, { area: value })
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current)
            next.delete('area')
            next.delete('run')
            next.delete('promotion')
            return next
          },
          { replace: true },
        )
      }}
      items={[
        { value: 'crm', label: t('creators.area.crm') },
        { value: 'discovery', label: t('creators.area.discovery') },
      ]}
    />
  ) : null

  if (gameId && area === 'discovery') {
    return (
      <div className="page-stack-compact w-full">
        <PageHeader title={t('nav.creators')} actions={workspaceNavigation} />
        <CreatorDiscovery gameId={gameId} />
      </div>
    )
  }

  return (
    <div className="page-stack-compact w-full">
      <PageHeader title={gameId ? t('nav.creators') : t('creators.global')} actions={workspaceNavigation} />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {view === 'list' ? (
          <label className="relative block w-full max-w-sm">
            <span className="sr-only">{t('common.search')}</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSectionState(sectionKey, { search: event.target.value })}
              placeholder={t('common.search')}
              className={cn(fieldCls, 'pl-9')}
            />
          </label>
        ) : gameId ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <label className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 t-hint">{t('creators.boardSort')}</span>
              <select
                value={boardSort.key}
                onChange={(event) => {
                  const key = event.target.value as CreatorBoardSortKey
                  setSectionState(sectionKey, {
                    boardSortKey: key,
                    boardSortDirection: creatorBoardDefaultDirection(key),
                  })
                }}
                className={cn(fieldCls, 'w-36')}
              >
                {CREATOR_BOARD_SORT_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {t(`creators.boardSort.${key}`)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() =>
                setSectionState(sectionKey, {
                  boardSortDirection: boardSort.direction === 'asc' ? 'desc' : 'asc',
                })
              }
              title={t(boardSort.direction === 'asc' ? 'tasks.sortAscending' : 'tasks.sortDescending')}
              aria-label={t(boardSort.direction === 'asc' ? 'tasks.sortAscending' : 'tasks.sortDescending')}
              className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] border border-border bg-surface text-muted hover:bg-surface-2 hover:text-text"
            >
              {boardSort.direction === 'asc' ? (
                <ArrowUp className="h-4 w-4" aria-hidden />
              ) : (
                <ArrowDown className="h-4 w-4" aria-hidden />
              )}
            </button>
          </div>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
          {gameId && (
            <Segmented
              ariaLabel={t('creators.view')}
              value={view}
              onChange={(value) => setSectionState(sectionKey, { view: value })}
              items={[
                { value: 'list', label: t('creators.view.list') },
                { value: 'board', label: t('creators.view.board') },
              ]}
            />
          )}
          {gameId && view === 'list' && (
            <IconToggle
              active={onlyPicked}
              onClick={() => setSectionState(sectionKey, { onlyPicked: !onlyPicked })}
              title={t('creators.onlyPicked')}
            >
              <Star className={cn('h-4 w-4', onlyPicked && 'fill-current')} />
            </IconToggle>
          )}
          {gameId && (
            <Button size="sm" variant="outline" onClick={() => setGmassOpen(true)}>
              <Send className="h-3.5 w-3.5" />
              {t('gmass.organize')}
            </Button>
          )}
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" />
            {t('common.add')}
          </Button>
        </div>
      </div>

      {gameId && <Funnel gameId={gameId} />}

      {adding && (
        <div className="space-y-3 rounded-[var(--radius)] border border-border bg-surface p-3">
          <div className="flex flex-wrap items-end gap-2">
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
            <div className="flex flex-col gap-1 t-hint">
              {t('creators.entityType')}
              <Segmented
                ariaLabel={t('creators.entityType')}
                value={form.entityType}
                onChange={(entityType) => setForm({ ...form, entityType })}
                items={[
                  { value: 'person', label: t('creators.entityType.person') },
                  { value: 'media', label: t('creators.entityType.media') },
                ]}
              />
            </div>
            <Button
              size="sm"
              onClick={() => form.name.trim() && create.mutate()}
              disabled={!form.name.trim() || create.isPending}
            >
              {t('common.create')}
            </Button>
          </div>
          <div className="space-y-1 t-hint">
            <span>{t('creators.platforms')}</span>
            <PlatformPicker value={form.platforms} onChange={(platforms) => setForm({ ...form, platforms })} />
          </div>
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
          <CreatorBoard items={boardItems} onMove={moveBoardCreator} onSelect={openCreator} />
        )
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{t('creators.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-[10px] bg-surface shadow-hard">
          <div className="min-w-[900px] 2xl:min-w-[1060px]">
            <div className="flex h-9 items-center gap-x-2 border-b border-border bg-surface-2 px-3">
              {gameId && <span className="w-10 shrink-0" />}
              {gameId && (
                <SortableHeader
                  label={t('creators.col.status')}
                  active={sort.key === 'status'}
                  direction={sort.direction}
                  onClick={() => changeSort('status')}
                  className="w-32"
                />
              )}
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
                className="w-36"
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
                className="hidden w-24 2xl:flex"
              />
              {gameId && (
                <SortableHeader
                  label={t('creators.col.fit')}
                  active={sort.key === 'fit'}
                  direction={sort.direction}
                  onClick={() => changeSort('fit')}
                  align="right"
                  className="w-20"
                />
              )}
              {!gameId && (
                <SortableHeader
                  label={t('creators.col.participants')}
                  active={sort.key === 'status'}
                  direction={sort.direction}
                  onClick={() => changeSort('status')}
                  align="right"
                  className="w-40"
                />
              )}
              <span className="w-10 shrink-0" />
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
                  className={cn(
                    'render-skip border-b border-l-[4px] border-b-border bg-surface transition-colors last:border-b-0 hover:bg-surface-2/60',
                    gameId && picked
                      ? CARD_STATE_STYLES[CREATOR_STATUS_TONES[(pick?.pipelineStatus ?? 'prospect') as CreatorStatus]]
                          .spine
                      : 'border-l-transparent',
                  )}
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
                    {gameId && (
                      <div className="flex w-32 shrink-0 items-center">
                        {picked && (
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
                            toneClassName={
                              CARD_STATE_STYLES[
                                CREATOR_STATUS_TONES[(pick?.pipelineStatus ?? 'prospect') as CreatorStatus]
                              ].control
                            }
                            ariaLabel={t('creators.col.status')}
                            className="w-full"
                          />
                        )}
                      </div>
                    )}
                    <button
                      onClick={() => openCreator(c.id)}
                      className="tap flex h-10 min-w-0 flex-1 items-center rounded-[var(--radius)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{c.name}</span>
                        <span className="shrink-0 t-caption text-muted">
                          {t(`creators.entityType.${c.entityType}`)}
                        </span>
                        <span className="shrink-0 rounded-[5px] bg-surface-2 px-1.5 py-0.5 t-caption text-muted">
                          {t(`creators.kind.${c.kind}`)}
                        </span>
                        {contacts.some((contact) => contact.value) && (
                          <span title={t('creators.correspondence')} className="shrink-0 text-info">
                            <Mail className="h-3.5 w-3.5" />
                          </span>
                        )}
                        {c.doNotContact && (
                          <span className="shrink-0 rounded-[5px] bg-alarm/10 px-1.5 py-0.5 t-caption text-alarm">
                            {t('creators.dnc')}
                          </span>
                        )}
                      </span>
                    </button>
                    <span className="flex w-36 shrink-0 items-center gap-1.5 text-xs text-muted">
                      <span className="min-w-0 flex-1 truncate">
                        {creatorPlatforms(c).map(platformLabel).join(', ') || <span className="opacity-50">—</span>}
                      </span>
                      <LanguageBadge language={c.language} region={c.region} label={t('creators.language')} compact />
                    </span>
                    <span className="nums w-24 shrink-0 text-right text-xs text-muted">
                      {c.audience != null ? c.audience.toLocaleString('ru-RU') : <span className="opacity-50">—</span>}
                    </span>
                    <span className="nums hidden w-24 shrink-0 text-right text-xs text-muted 2xl:block">
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
                      <span className="flex w-20 shrink-0 justify-end">
                        <FitScore score={f?.score} />
                      </span>
                    )}
                    {!gameId && (
                      <div className="flex w-40 shrink-0 items-center justify-end">
                        {parts.length ? (
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
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => openCreator(c.id)}
                      aria-label={`${t('common.open')}: ${c.name}`}
                      className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text"
                    >
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </button>
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

function fitBadgeTone(score?: number): string {
  if (score == null) return 'bg-surface-2 text-muted'
  if (score >= 66) return 'bg-accent/10 text-accent'
  if (score >= 40) return 'bg-warning/10 text-warning'
  return 'bg-surface-2 text-muted'
}

function formatCompactMetric(value: number): string {
  return (value >= 10_000 ? COMPACT_METRIC_FORMATTER : STANDARD_METRIC_FORMATTER).format(value)
}

function FitScore({ score, labelled = false }: { score?: number; labelled?: boolean }) {
  const t = useT()
  return (
    <span
      className={cn(
        'nums inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 py-0.5 text-xs font-semibold',
        fitBadgeTone(score),
      )}
      title={`${t('creators.fit')}: ${score ?? '—'}`}
    >
      {labelled && <span className="font-medium opacity-75">{t('creators.fit')}</span>}
      <span>{score ?? '—'}</span>
    </span>
  )
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
  const formRef = useRef<HTMLFormElement>(null)
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: async () => {
      const form = formRef.current
      if (!form) throw new Error('Creator form is unavailable')
      const data = new FormData(form)
      const value = (name: string) => String(data.get(name) ?? '')
      const name = value('name')
      const handle = value('handle')
      const audience = value('audience')
      const avgViews = value('avgViews')
      const cadencePerMonth = value('cadencePerMonth')
      const language = value('language')
      const region = value('region')
      const costUsd = value('costUsd')
      const notes = value('notes')
      const entityType = (value('entityType') || c.entityType) as CreatorEntityType
      const platforms = value('platforms').split(',').filter(Boolean)
      const playedGames = listFromText(value('playedGames'))
      const updateCreator = trpc.creators.update.mutate({
        id: c.id,
        name: name.trim() || c.name,
        entityType,
        handle: handle.trim() || null,
        primaryPlatform:
          (c.primaryPlatform && platforms.includes(c.primaryPlatform) ? c.primaryPlatform : platforms[0]) ?? null,
        channelsJson: channelsWithPlatforms(c.channelsJson, platforms),
        audience: audience.trim() === '' ? null : Number(audience) || 0,
        avgViews: avgViews.trim() === '' ? null : Number(avgViews) || 0,
        cadencePerMonth: cadencePerMonth.trim() === '' ? null : Number(cadencePerMonth) || 0,
        language: language.trim() || null,
        region: region.trim() || null,
        costUsd: costUsd.trim() === '' ? null : Number(costUsd) || 0,
        acceptsKeysOnly: data.has('acceptsKeysOnly'),
        doNotContact: data.has('doNotContact'),
        notes: notes.trim() || null,
        playedGamesJson: playedGames.length ? JSON.stringify(playedGames) : null,
      })
      if (gameId && status) {
        const keysSent = listFromText(value('keysSent'))
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

  const Field = ({ label, children }: { label: string; children: ReactNode }) => (
    <label className="flex flex-col gap-1 t-hint">
      {label}
      {children}
    </label>
  )

  return (
    <DetailDrawer
      label={t(`creators.kind.${c.kind}`)}
      meta={
        <>
          {status && <CardStateBadge tone={CREATOR_STATUS_TONES[status]}>{t(`creators.st.${status}`)}</CardStateBadge>}
          {fit && <FitScore score={fit.score} labelled />}
        </>
      }
      onClose={onClose}
      width="wide"
    >
      <form
        ref={formRef}
        className="contents"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-[14px] bg-bg/55 p-3 shadow-hard sm:grid-cols-[auto_minmax(0,1fr)_auto]">
          <CreatorAvatar name={c.name} src={c.thumbnailUrl} />
          <div className="min-w-0 flex-1">
            <input
              name="name"
              defaultValue={c.name}
              aria-label={t('creators.name')}
              className="w-full min-w-0 bg-transparent t-subtitle text-text outline-none focus-visible:ring-0"
            />
            <div className="mt-1.5 flex min-h-7 flex-wrap items-center gap-1.5">
              <LanguageBadge language={c.language} region={c.region} label={t('creators.language')} />
              {c.handle && <span className="min-w-0 truncate t-caption text-muted">{c.handle}</span>}
            </div>
          </div>
          <div className="col-start-2 flex items-center gap-1.5 sm:col-start-auto">
            <Button type="submit" size="sm" disabled={save.isPending}>
              {saved ? `${t('common.save')} ✓` : t('common.save')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onDelete}
              aria-label={t('common.delete')}
              title={t('common.delete')}
            >
              <Trash2 className="h-4 w-4 text-alarm" />
            </Button>
          </div>
        </div>

        <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_272px]">
          <main className="min-w-0 space-y-4">
            {gameId && fit && (
              <section className={drawerPanel}>
                <div className="flex items-center justify-between gap-2">
                  <h2 className={drawerSectionLabel}>{t('creators.fit')}</h2>
                  <FitScore score={fit.score} labelled />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {fit.reasons.slice(0, 5).map((reason, index) => (
                    <span key={index} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">
                      {reason}
                    </span>
                  ))}
                </div>
              </section>
            )}

            <section className={drawerPanel}>
              <h2 className={drawerSectionLabel}>{t('creators.section.profile')}</h2>
              <div className="mt-3 space-y-3">
                {contacts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {contacts.map((contact, index) => (
                      <span
                        key={index}
                        className="inline-flex min-h-7 items-center gap-1 rounded bg-surface-2 px-2 text-xs"
                      >
                        <Mail className="h-3 w-3 text-muted" />
                        <span className="nums">{contact.value}</span>
                        {contact.gated && (
                          <span className="text-warning" title={t('creators.gatedHint')}>
                            ⚠
                          </span>
                        )}
                        {contact.verified && (
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
                    {topics.map((topic, index) => (
                      <span key={index} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">
                        #{topic}
                      </span>
                    ))}
                  </div>
                )}
                <Field label={t('creators.handle')}>
                  <input name="handle" defaultValue={c.handle ?? ''} className={fieldCls} />
                </Field>
                <div className="flex flex-col gap-1 t-hint">
                  {t('creators.platforms')}
                  <FormPlatformPicker initialValue={creatorPlatforms(c)} />
                </div>
              </div>
            </section>

            <section className={cn(drawerPanel, 'drawer-secondary-skip')}>
              <h2 className={drawerSectionLabel}>{t('creators.section.details')}</h2>
              <div className="mt-3 space-y-3">
                <Field label={t('creators.playedGames')}>
                  <textarea
                    name="playedGames"
                    rows={3}
                    defaultValue={parseStringList(c.playedGamesJson).join('\n')}
                    placeholder={t('creators.playedGamesHint')}
                    className={cn(fieldCls, 'resize-y leading-relaxed')}
                  />
                </Field>
                {gameId && status && (
                  <Field label={t('creators.keysSent')}>
                    <textarea
                      name="keysSent"
                      rows={2}
                      defaultValue={parseStringList(keysSentJson).join('\n')}
                      placeholder={t('creators.keysSentHint')}
                      autoComplete="off"
                      spellCheck={false}
                      className={cn(fieldCls, 'resize-y font-mono text-xs leading-relaxed')}
                    />
                  </Field>
                )}
                <Field label={t('creators.notes')}>
                  <textarea
                    name="notes"
                    rows={3}
                    defaultValue={c.notes ?? ''}
                    className={cn(fieldCls, 'resize-y leading-relaxed')}
                  />
                </Field>
                {c.youtubeChannelId && (
                  <div className="flex flex-wrap gap-1.5 pt-1 t-caption text-muted">
                    <span className="rounded bg-surface-2 px-2 py-1 font-mono">{c.youtubeChannelId}</span>
                    {c.dataRefreshedAt && (
                      <span className="rounded bg-surface-2 px-2 py-1 tabular-nums">
                        {t('creators.dataFresh')}: {new Date(c.dataRefreshedAt).toLocaleDateString()}
                      </span>
                    )}
                    {c.dataExpiresAt && (
                      <span className="rounded bg-warning/10 px-2 py-1 text-warning tabular-nums">
                        {t('creators.dataExpires')}: {new Date(c.dataExpiresAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </section>
          </main>

          <aside className="space-y-4">
            <section className={drawerPanel}>
              <h2 className={drawerSectionLabel}>{t('creators.section.status')}</h2>
              <div className="mt-3 space-y-3">
                <div className="flex flex-col gap-1 t-hint">
                  {t('creators.entityType')}
                  <FormEntityTypePicker initialValue={c.entityType as CreatorEntityType} />
                </div>
                {status && (
                  <Field label={t('creators.col.status')}>
                    <StatusSelect
                      value={status}
                      options={STATUSES.map((value) => ({ value, label: t(`creators.st.${value}`) }))}
                      onChange={onStatusChange}
                      toneClassName={CARD_STATE_STYLES[CREATOR_STATUS_TONES[status]].control}
                      ariaLabel={t('creators.col.status')}
                      className="w-full"
                    />
                  </Field>
                )}
              </div>
            </section>

            <section className={drawerPanel}>
              <h2 className={drawerSectionLabel}>{t('creators.section.metrics')}</h2>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label={t('creators.audience')}>
                  <input
                    name="audience"
                    type="number"
                    min={0}
                    defaultValue={c.audience == null ? '' : String(c.audience)}
                    className={fieldCls}
                  />
                </Field>
                <Field label={t('creators.avgViews')}>
                  <input
                    name="avgViews"
                    type="number"
                    min={0}
                    defaultValue={c.avgViews == null ? '' : String(c.avgViews)}
                    className={fieldCls}
                  />
                </Field>
                <Field label={t('creators.cadence')}>
                  <input
                    name="cadencePerMonth"
                    type="number"
                    min={0}
                    step="0.1"
                    defaultValue={c.cadencePerMonth == null ? '' : String(c.cadencePerMonth)}
                    className={fieldCls}
                  />
                </Field>
                <Field label={t('creators.language')}>
                  <input name="language" placeholder="en, ru…" defaultValue={c.language ?? ''} className={fieldCls} />
                </Field>
                <Field label={t('creators.region')}>
                  <input name="region" defaultValue={c.region ?? ''} className={fieldCls} />
                </Field>
                <Field label={t('common.costUsd')}>
                  <input
                    name="costUsd"
                    type="number"
                    min={0}
                    placeholder={t('creators.rateFree')}
                    defaultValue={c.costUsd == null ? '' : String(c.costUsd)}
                    className={fieldCls}
                  />
                </Field>
              </div>
            </section>

            <section className={drawerPanel}>
              <h2 className={drawerSectionLabel}>{t('creators.section.conditions')}</h2>
              <div className="mt-2 space-y-1">
                <label className="flex min-h-10 items-center gap-2 rounded-[var(--radius)] px-2 t-hint hover:bg-surface-2">
                  <input name="acceptsKeysOnly" type="checkbox" defaultChecked={!!c.acceptsKeysOnly} />
                  {t('creators.keysOnly')}
                </label>
                <label className="flex min-h-10 items-center gap-2 rounded-[var(--radius)] px-2 t-hint hover:bg-surface-2">
                  <input name="doNotContact" type="checkbox" defaultChecked={!!c.doNotContact} />
                  {t('creators.dnc')}
                </label>
              </div>
            </section>
          </aside>
        </div>
      </form>
      {gameId && (
        <DeferredDrawerSection minHeight={96}>
          <CreatorDiscoveryEvidence gameId={gameId} creatorId={c.id} />
        </DeferredDrawerSection>
      )}
      {gameId && (
        <DeferredDrawerSection minHeight={120}>
          <Correspondence gameId={gameId} creator={c} />
        </DeferredDrawerSection>
      )}
    </DetailDrawer>
  )
}

function DeferredDrawerSection({ children, minHeight }: { children: ReactNode; minHeight: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (ready) return
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setReady(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setReady(true)
        observer.disconnect()
      },
      { rootMargin: '0px', threshold: 0.25 },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ready])

  return (
    <div ref={ref} className="drawer-secondary-skip" style={ready ? undefined : { minHeight }}>
      {ready ? children : null}
    </div>
  )
}

function CreatorDiscoveryEvidence({ gameId, creatorId }: { gameId: string; creatorId: string }) {
  const t = useT()
  const discoveryEvidence = useQuery({
    queryKey: ['creator-discovery-promoted-evidence', gameId, creatorId],
    queryFn: () => trpc.creatorDiscovery.promotedEvidence.query({ gameId, creatorId, limit: 5 }),
  })
  const latestDiscovery = discoveryEvidence.data?.[0]
  if (!latestDiscovery) return null

  return (
    <section className={drawerPanel}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={drawerSectionLabel}>{t('creators.discoveryEvidence')}</h2>
        <span className="nums text-xs text-muted">
          {t('creators.discoveryFit')} {latestDiscovery.result.fitScore} · {latestDiscovery.result.matchedVideoCount}{' '}
          {t('discovery.matches')}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {latestDiscovery.matchedReferences.map((reference) => (
          <span key={reference} className="rounded-full bg-accent/10 px-2 py-0.5 t-caption text-accent">
            {reference}
          </span>
        ))}
      </div>
      {latestDiscovery.evidence.length > 0 && (
        <div className="mt-2 space-y-1">
          {latestDiscovery.evidence.slice(0, 6).map((item) => (
            <a
              key={item.id}
              href={item.videoUrl}
              target="_blank"
              rel="noreferrer"
              className="group flex min-h-10 items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-xs transition-colors hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-text group-hover:text-accent">{item.videoTitle}</span>
                <span className="block truncate text-muted">{item.referenceLabel}</span>
              </span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
            </a>
          ))}
        </div>
      )}
    </section>
  )
}

type BoardItem = { creator: Creator; status: CreatorStatus; fitScore?: number }

const BoardCard = memo(function BoardCard({
  item,
  onSelect,
  dragging,
}: {
  item: BoardItem
  onSelect: (id: string) => void
  dragging: boolean
}) {
  const t = useT()
  const { creator: c, fitScore } = item
  const platformText = creatorPlatforms(c).map(platformLabel).join(', ')
  return (
    <CardSurface
      tone={CREATOR_STATUS_TONES[item.status]}
      dragging={dragging}
      data-creator-card-id={c.id}
      className="h-[88px] cursor-grab touch-pan-y select-none overflow-hidden text-sm active:cursor-grabbing"
      onClick={() => onSelect(c.id)}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <CardStateBadge tone={CREATOR_STATUS_TONES[item.status]}>{t(`creators.st.${item.status}`)}</CardStateBadge>
        <span className="rounded-[5px] bg-surface-2 px-1.5 py-0.5 t-caption text-muted">
          {t(`creators.entityType.${c.entityType}`)}
        </span>
        {c.doNotContact && <span className="shrink-0 t-caption text-alarm">{t('creators.dnc')}</span>}
        <span className="ml-auto">
          <FitScore score={fitScore} labelled />
        </span>
      </div>
      <div className="mt-1.5 truncate font-medium" title={c.name}>
        {c.name}
      </div>
      <div className="mt-1 grid min-w-0 grid-cols-[minmax(0,1fr)_20px_64px] items-center gap-x-2 text-xs text-muted">
        <span className="min-w-0 truncate" title={platformText}>
          {platformText || '—'}
        </span>
        <span className="flex w-5 justify-center">
          <LanguageBadge language={c.language} region={c.region} label={t('creators.language')} compact />
        </span>
        <span className="nums w-16 whitespace-nowrap text-right">
          {c.audience != null ? formatCompactMetric(c.audience) : '—'}
        </span>
      </div>
    </CardSurface>
  )
})

const CreatorBoard = memo(function CreatorBoard({
  items,
  onMove,
  onSelect,
}: {
  items: BoardItem[]
  onMove: (creatorId: string, status: (typeof STATUSES)[number], name: string) => void
  onSelect: (id: string) => void
}) {
  const t = useT()
  const boardBodyRef = useRef<HTMLDivElement>(null)
  const pointerDrag = useRef<{
    creatorId: string
    pointerId: number
    startX: number
    startY: number
    active: boolean
    over: CreatorStatus | null
  } | null>(null)
  const suppressClick = useRef(false)
  const [dragState, setDragState] = useState<{ creatorId: string; over: CreatorStatus | null } | null>(null)
  const columns = useMemo(() => {
    const grouped = new Map<CreatorStatus, BoardItem[]>(STATUSES.map((status) => [status, []]))
    for (const item of items) grouped.get(item.status)!.push(item)
    return grouped
  }, [items])
  const maxRows = useMemo(() => Math.max(0, ...STATUSES.map((status) => columns.get(status)!.length)), [columns])
  const [virtualRange, setVirtualRange] = useState({ start: 0, end: BOARD_INITIAL_ROWS })

  useEffect(() => {
    let frame = 0
    const body = boardBodyRef.current
    const scrollport = body?.closest<HTMLElement>('#main-content')
    if (!body || !scrollport) return

    const updateRange = () => {
      frame = 0
      const bodyRect = body.getBoundingClientRect()
      const viewportRect = scrollport.getBoundingClientRect()
      const firstVisible = Math.min(
        maxRows,
        Math.max(0, Math.floor((viewportRect.top - bodyRect.top) / BOARD_CARD_PITCH)),
      )
      const lastVisible = Math.min(
        maxRows,
        Math.max(firstVisible, Math.ceil((viewportRect.bottom - bodyRect.top) / BOARD_CARD_PITCH)),
      )

      setVirtualRange((current) => {
        const rangeOutOfBounds = current.start > maxRows || current.end > maxRows
        const nearingStart = current.start > 0 && firstVisible < current.start + BOARD_RANGE_BUFFER_ROWS
        const nearingEnd = current.end < maxRows && lastVisible > current.end - BOARD_RANGE_BUFFER_ROWS
        if (!rangeOutOfBounds && !nearingStart && !nearingEnd) return current

        const start = Math.max(0, firstVisible - BOARD_OVERSCAN_ROWS)
        const end = Math.min(maxRows, lastVisible + BOARD_OVERSCAN_ROWS)
        return current.start === start && current.end === end ? current : { start, end }
      })
    }
    const scheduleRangeUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateRange)
    }
    scrollport.addEventListener('scroll', scheduleRangeUpdate, { passive: true })
    window.addEventListener('resize', scheduleRangeUpdate)
    updateRange()
    return () => {
      scrollport.removeEventListener('scroll', scheduleRangeUpdate)
      window.removeEventListener('resize', scheduleRangeUpdate)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [maxRows])

  const itemsById = useMemo(() => new Map(items.map((item) => [item.creator.id, item])), [items])
  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = pointerDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (!cancelled && drag.active && drag.over) {
      const item = itemsById.get(drag.creatorId)
      if (item && item.status !== drag.over) onMove(item.creator.id, drag.over, item.creator.name)
    }
    if (drag.active) {
      suppressClick.current = true
      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
    pointerDrag.current = null
    setDragState(null)
  }
  return (
    <div
      className="flex gap-3 overflow-x-auto pb-2"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const card = (event.target as HTMLElement).closest<HTMLElement>('[data-creator-card-id]')
        const creatorId = card?.dataset.creatorCardId
        if (!creatorId || !itemsById.has(creatorId)) return
        pointerDrag.current = {
          creatorId,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          over: null,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const drag = pointerDrag.current
        if (!drag || drag.pointerId !== event.pointerId) return
        if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
        const column = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-creator-column]')
        const statusValue = column?.dataset.creatorColumn
        const over = STATUSES.includes(statusValue as CreatorStatus) ? (statusValue as CreatorStatus) : null
        if (!drag.active || drag.over !== over) {
          drag.active = true
          drag.over = over
          setDragState({ creatorId: drag.creatorId, over })
        }
        event.preventDefault()
      }}
      onPointerUp={(event) => finishPointerDrag(event)}
      onPointerCancel={(event) => finishPointerDrag(event, true)}
      onClickCapture={(event) => {
        if (!suppressClick.current) return
        event.preventDefault()
        event.stopPropagation()
        suppressClick.current = false
      }}
    >
      {STATUSES.map((status) => {
        const col = columns.get(status)!
        return (
          <BoardColumn
            key={status}
            status={status}
            items={col}
            onSelect={onSelect}
            bodyRef={status === STATUSES[0] ? boardBodyRef : undefined}
            virtualStart={virtualRange.start}
            virtualEnd={virtualRange.end}
            draggingId={dragState?.creatorId ?? null}
            isOver={dragState?.over === status}
            label={`${t(`creators.st.${status}`)}`}
          />
        )
      })}
    </div>
  )
})

const BoardColumn = memo(function BoardColumn({
  status,
  items,
  onSelect,
  bodyRef,
  virtualStart,
  virtualEnd,
  draggingId,
  isOver,
  label,
}: {
  status: CreatorStatus
  items: BoardItem[]
  onSelect: (id: string) => void
  bodyRef?: ReactRef<HTMLDivElement>
  virtualStart: number
  virtualEnd: number
  draggingId: string | null
  isOver: boolean
  label: string
}) {
  const state = CARD_STATE_STYLES[CREATOR_STATUS_TONES[status]]
  const start = Math.min(items.length, virtualStart)
  const end = Math.min(items.length, Math.max(start, virtualEnd))
  const visibleItems = items.slice(start, end)
  return (
    <div className="flex w-60 min-w-56 flex-none flex-col 2xl:w-auto 2xl:min-w-[220px] 2xl:flex-1">
      <div className="mb-1.5 flex items-center gap-2 px-1 t-hint">
        <span className={cn('h-2 w-2 rounded-full', state.dot)} />
        <span className={cn('font-medium', state.text)}>{label}</span>
        <span className="nums text-muted/60">{items.length}</span>
      </div>
      <div
        ref={bodyRef}
        data-creator-column={status}
        className={cn(
          'flex min-h-24 flex-1 flex-col rounded-[10px] border border-dashed p-2 transition-[background-color,border-color] duration-150 ease-out',
          state.column,
          state.columnBorder,
          isOver && 'border-accent bg-accent/5',
        )}
      >
        {start > 0 && <div aria-hidden className="shrink-0" style={{ height: start * BOARD_CARD_PITCH }} />}
        {visibleItems.map((item) => (
          <div key={item.creator.id} className="h-24 shrink-0">
            <BoardCard item={item} onSelect={onSelect} dragging={draggingId === item.creator.id} />
          </div>
        ))}
        {end < items.length && (
          <div aria-hidden className="shrink-0" style={{ height: (items.length - end) * BOARD_CARD_PITCH }} />
        )}
      </div>
    </div>
  )
})

const Correspondence = memo(function Correspondence({ gameId, creator }: { gameId: string; creator: Creator }) {
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
})
