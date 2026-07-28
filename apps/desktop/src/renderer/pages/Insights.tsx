import { useEffect, useState, type MouseEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Cat,
  Eye,
  FilePenLine,
  Lightbulb,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Save,
  Search,
  Trash2,
} from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { insightFilePath } from '@/lib/insightFilePath'
import { cn, fieldCls } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { toast } from '@/store/toast'
import { confirm } from '@/store/confirm'
import { useT } from '@/i18n/useT'
import { Button } from '@/components/ui/Button'
import { LoadingState, QueryError } from '@/components/ui/QueryState'

type Draft = { title: string; body: string }

export function Insights() {
  const t = useT()
  const navigate = useNavigate()
  const { gameId } = useParams<{ gameId: string }>()
  const [params, setParams] = useSearchParams()
  const setCurrentGame = useUi((state) => state.setCurrentGame)
  const setSeedPrompt = useUi((state) => state.setSeedPrompt)
  const setSectionViewState = useUi((state) => state.setSectionViewState)
  const qc = useQueryClient()
  const viewStateKey = `insights:${gameId ?? 'unknown'}`
  const initialViewState = useUi.getState().sectionViewStates?.[viewStateKey] ?? {}
  const [search, setSearch] = useState(() =>
    typeof initialViewState.search === 'string' ? initialViewState.search : '',
  )
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const fromUrl = params.get('insight')
    if (fromUrl) return fromUrl
    return typeof initialViewState.selectedId === 'string' ? initialViewState.selectedId : null
  })
  const [creating, setCreating] = useState(false)
  const [preview, setPreview] = useState(() => initialViewState.preview !== false)
  const [catalogCollapsed, setCatalogCollapsed] = useState(() => initialViewState.catalogCollapsed === true)
  const [draft, setDraft] = useState<Draft>({ title: '', body: '' })

  const remember = (patch: Record<string, string | number | boolean | null>) => setSectionViewState(viewStateKey, patch)

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
  }, [gameId, setCurrentGame])

  const catalog = useQuery({
    queryKey: ['insights', gameId, search],
    queryFn: () =>
      trpc.insights.catalog.query({ gameId: gameId!, ...(search.trim() ? { search: search.trim() } : {}) }),
    enabled: !!gameId,
  })
  const detail = useQuery({
    queryKey: ['insight', selectedId],
    queryFn: () => trpc.insights.get.query({ id: selectedId! }),
    enabled: !!selectedId && !creating,
  })

  useEffect(() => {
    if (!creating && detail.data) setDraft({ title: detail.data.title, body: detail.data.body })
  }, [creating, detail.data])

  useEffect(() => {
    if (creating || selectedId || !catalog.data?.length) return
    const first = catalog.data[0]!.id
    setSelectedId(first)
    setSectionViewState(viewStateKey, { selectedId: first })
    const next = new URLSearchParams(params)
    next.set('insight', first)
    setParams(next, { replace: true })
  }, [catalog.data, creating, params, selectedId, setParams, setSectionViewState, viewStateKey])

  const refresh = () => qc.invalidateQueries({ queryKey: ['insights', gameId] })
  const createInsight = useMutation({
    mutationFn: () => trpc.insights.create.mutate({ gameId: gameId!, ...draft, createdBy: 'manual' }),
    onSuccess: (created) => {
      refresh()
      setCreating(false)
      select(created.id)
      toast.success(t('insights.created'))
    },
    onError: toast.fromError,
  })
  const updateInsight = useMutation({
    mutationFn: () => trpc.insights.update.mutate({ id: selectedId!, ...draft, updatedBy: 'manual' }),
    onSuccess: (updated) => {
      refresh()
      if (updated) qc.setQueryData(['insight', selectedId], updated)
      toast.success(t('insights.saved'))
    },
    onError: toast.fromError,
  })
  const removeInsight = useMutation({
    mutationFn: (id: string) => trpc.insights.remove.mutate({ id }),
    onSuccess: async () => {
      await refresh()
      setSelectedId(null)
      remember({ selectedId: null })
      setDraft({ title: '', body: '' })
      const next = new URLSearchParams(params)
      next.delete('insight')
      setParams(next, { replace: true })
    },
    onError: toast.fromError,
  })

  const select = (id: string) => {
    setCreating(false)
    setSelectedId(id)
    remember({ selectedId: id })
    setDraft({ title: '', body: '' })
    const next = new URLSearchParams(params)
    next.set('insight', id)
    setParams(next, { replace: true })
  }
  const startCreating = () => {
    setCreating(true)
    setPreview(false)
    remember({ preview: false })
    setSelectedId(null)
    setDraft({ title: '', body: '' })
    const next = new URLSearchParams(params)
    next.delete('insight')
    setParams(next, { replace: true })
  }
  const askCat = () => {
    setSeedPrompt(detail.data?.kind === 'project_card' ? t('insights.projectCardCatPrompt') : t('insights.catPrompt'))
    navigate(`/g/${gameId}/ai`)
  }
  const showInsightContextMenu = async (event: MouseEvent, id: string) => {
    event.preventDefault()
    try {
      const insight = detail.data?.id === id ? detail.data : await trpc.insights.get.query({ id })
      window.marcat?.showFileContextMenu({
        path: insight ? insightFilePath(insight.body) : null,
        openLabel: t('insights.openFileLocation'),
        missingLabel: t('insights.noFileLocation'),
      })
    } catch (error) {
      toast.fromError(error)
    }
  }
  const togglePreview = () => {
    const next = !preview
    setPreview(next)
    remember({ preview: next })
  }
  const toggleCatalog = () => {
    const next = !catalogCollapsed
    setCatalogCollapsed(next)
    remember({ catalogCollapsed: next })
  }
  const remove = async () => {
    if (!selectedId || !detail.data) return
    const ok = await confirm({ title: t('common.deleteQ', { name: detail.data.title }), danger: true })
    if (ok) removeInsight.mutate(selectedId)
  }

  const queryError = catalog.error ?? detail.error
  if (queryError) {
    return <QueryError error={queryError} onRetry={() => void Promise.all([catalog.refetch(), detail.refetch()])} />
  }
  if (catalog.isLoading) return <LoadingState />

  const selected = detail.data
  const isProjectCard = selected?.kind === 'project_card'
  const hasEditor = creating || !!selectedId
  const canSave = !!draft.title.trim() && !!draft.body.trim()
  const dirty = creating || (!!selected && (draft.title !== selected.title || draft.body !== selected.body))
  const busy = createInsight.isPending || updateInsight.isPending

  return (
    <div className="enter-stagger w-full min-w-0 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-accent" aria-hidden />
            <h1 className="t-title text-balance">{t('insights.title')}</h1>
          </div>
          <p className="mt-1 max-w-2xl t-hint text-pretty">{t('insights.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={askCat}>
            <Cat className="h-4 w-4" aria-hidden />
            {t('insights.askCat')}
          </Button>
          <Button size="sm" onClick={startCreating}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('insights.new')}
          </Button>
        </div>
      </header>

      <div
        className={cn(
          'grid min-h-[520px] min-w-0 gap-4',
          catalogCollapsed ? 'grid-cols-[48px_minmax(0,1fr)]' : 'lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]',
        )}
        style={{ minHeight: 'clamp(520px, calc(100vh - 12rem), 780px)' }}
      >
        <aside
          className={cn(
            'flex min-h-0 flex-col overflow-hidden rounded-[14px] bg-surface shadow-hard',
            catalogCollapsed ? 'h-12 p-1' : 'max-h-80 p-2 lg:max-h-none',
          )}
        >
          {catalogCollapsed ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={toggleCatalog}
              aria-label={t('insights.showCatalog')}
              aria-pressed
            >
              <PanelLeftOpen className="h-4 w-4" aria-hidden />
            </Button>
          ) : (
            <>
              <div className="flex items-center gap-1">
                <label className="relative min-w-0 flex-1">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                    aria-hidden
                  />
                  <input
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value)
                      remember({ search: event.target.value })
                    }}
                    placeholder={t('insights.search')}
                    className={cn(fieldCls, 'pl-9')}
                  />
                </label>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={toggleCatalog}
                  aria-label={t('insights.hideCatalog')}
                  aria-pressed={false}
                >
                  <PanelLeftClose className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
                {catalog.data?.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => select(item.id)}
                    onContextMenu={(event) => void showInsightContextMenu(event, item.id)}
                    className={cn(
                      'tap min-h-14 w-full rounded-[10px] px-3 py-2 text-left transition-[background-color,box-shadow,scale] duration-150 active:scale-[0.96]',
                      selectedId === item.id && !creating
                        ? 'bg-accent/10 text-text shadow-[inset_2px_0_0_var(--color-accent)]'
                        : 'text-muted hover:bg-surface-2 hover:text-text',
                    )}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="block text-sm font-medium text-pretty">{item.title}</span>
                      {item.required && (
                        <span className="shrink-0 rounded-full bg-accent/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                          {item.filled ? t('insights.required') : t('insights.needsFilling')}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block t-hint nums">
                      {t(`insights.source.${item.createdBy}`)} · {item.updatedAt.slice(0, 10)}
                    </span>
                  </button>
                ))}
                {!catalog.data?.length && (
                  <div className="px-3 py-8 text-center">
                    <Lightbulb className="mx-auto h-6 w-6 text-muted/50" aria-hidden />
                    <p className="mt-2 text-sm text-pretty text-muted">
                      {search.trim() ? t('insights.noResults') : t('insights.empty')}
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </aside>

        <section className="min-h-0 min-w-0 overflow-hidden rounded-[14px] bg-surface p-2 shadow-hard">
          {!creating && selectedId && detail.isLoading ? (
            <div className="flex h-full min-h-[504px] items-center justify-center rounded-[10px] bg-bg">
              <LoadingState />
            </div>
          ) : hasEditor ? (
            <div className="flex h-full min-h-[504px] min-w-0 flex-col overflow-hidden rounded-[10px] bg-bg p-4 sm:p-5">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="t-hint">
                  {creating
                    ? t('insights.new')
                    : selected
                      ? `${t(`insights.source.${selected.createdBy}`)} · ${selected.updatedAt.slice(0, 10)}`
                      : t('common.loading')}
                </span>
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {isProjectCard && (
                    <span className="mr-1 rounded-full bg-accent/12 px-2.5 py-1 text-xs font-medium text-accent">
                      {draft.body.trim() ? t('insights.required') : t('insights.needsFilling')}
                    </span>
                  )}
                  {!creating && selected && !isProjectCard && (
                    <Button size="icon" variant="ghost" onClick={remove} aria-label={t('common.delete')}>
                      <Trash2 className="h-4 w-4 text-alarm" aria-hidden />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={togglePreview} aria-pressed={preview}>
                    {preview ? (
                      <FilePenLine className="h-4 w-4" aria-hidden />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden />
                    )}
                    {preview ? t('common.edit') : t('common.preview')}
                  </Button>
                  {!preview && dirty && (
                    <Button
                      size="sm"
                      onClick={() => (creating ? createInsight.mutate() : updateInsight.mutate())}
                      disabled={!canSave || busy}
                    >
                      <Save className="h-4 w-4" aria-hidden />
                      {t('common.save')}
                    </Button>
                  )}
                </div>
              </div>

              {preview ? (
                <div
                  className="mt-5 min-h-0 min-w-0 flex-1 overflow-y-auto pr-1"
                  onContextMenu={(event) => selectedId && void showInsightContextMenu(event, selectedId)}
                >
                  <h2 className="break-words text-balance text-2xl font-semibold leading-tight text-text [overflow-wrap:anywhere]">
                    {draft.title || t('insights.titlePlaceholder')}
                  </h2>
                  <div className="markdown-content mt-5 min-w-0 break-words text-sm text-pretty [overflow-wrap:anywhere]">
                    {draft.body ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          a: ({ children, ...props }) => (
                            <a {...props} target="_blank" rel="noreferrer" className="break-all">
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {draft.body}
                      </ReactMarkdown>
                    ) : (
                      <p className="text-muted">{t('insights.bodyPlaceholder')}</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-5 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  {isProjectCard ? (
                    <div>
                      <h2 className="text-balance text-2xl font-semibold leading-tight text-text">{draft.title}</h2>
                      <p className="mt-1 max-w-2xl t-hint text-pretty">{t('insights.projectCardHelp')}</p>
                    </div>
                  ) : (
                    <textarea
                      autoFocus={creating}
                      value={draft.title}
                      onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                      placeholder={t('insights.titlePlaceholder')}
                      maxLength={240}
                      rows={1}
                      className="max-h-32 w-full resize-none overflow-y-auto bg-transparent text-2xl font-semibold leading-tight text-text outline-none [field-sizing:content] placeholder:text-muted/55"
                    />
                  )}
                  <textarea
                    autoFocus={isProjectCard}
                    value={draft.body}
                    onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                    placeholder={
                      isProjectCard ? t('insights.projectCardBodyPlaceholder') : t('insights.bodyPlaceholder')
                    }
                    className="mt-5 min-h-64 w-full flex-1 resize-none overflow-y-auto bg-transparent font-mono text-sm leading-relaxed text-text outline-none placeholder:text-muted/55"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full min-h-[504px] items-center justify-center rounded-[10px] bg-bg p-8 text-center">
              <div className="max-w-sm">
                <Lightbulb className="mx-auto h-8 w-8 text-accent/60" aria-hidden />
                <h2 className="mt-3 t-section text-balance">{t('insights.emptyTitle')}</h2>
                <p className="mt-1 t-hint text-pretty">{t('insights.emptyBody')}</p>
                <Button size="sm" className="mt-4" onClick={startCreating}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {t('insights.new')}
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
