import { useEffect, useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, MessageSquarePlus, RefreshCw, Sparkles, Star } from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { useT } from '@/i18n/useT'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { LoadingState, QueryError } from '@/components/ui/QueryState'

type CommentStatus = 'unread' | 'open' | 'replied' | 'ignored'
type CommentFilter = 'all' | 'needs_reply' | CommentStatus

const FILTERS: CommentFilter[] = ['all', 'needs_reply', 'unread', 'open', 'replied', 'ignored']

const statusTone: Record<CommentStatus, string> = {
  unread: 'bg-accent/12 text-accent',
  open: 'bg-warning/12 text-warning',
  replied: 'bg-success/12 text-success',
  ignored: 'bg-surface-2 text-muted',
}

export function Comments() {
  const t = useT()
  const lang = useSettings((state) => state.lang)
  const { gameId } = useParams<{ gameId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setCurrentGame = useUi((state) => state.setCurrentGame)
  const setSeedPrompt = useUi((state) => state.setSeedPrompt)
  const viewKey = `comments:${gameId ?? ''}`
  const storedView = useUi((state) => state.sectionViewStates?.[viewKey])
  const remembered = storedView ?? {}
  const selectedSourceId = typeof remembered.sourceId === 'string' ? remembered.sourceId : ''
  const filter = FILTERS.includes(remembered.filter as CommentFilter)
    ? (remembered.filter as CommentFilter)
    : 'needs_reply'
  const setView = useUi((state) => state.setSectionViewState)

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
  }, [gameId, setCurrentGame])

  const sourceQuery = useQuery({
    queryKey: ['comment-sources', gameId],
    queryFn: () => trpc.comments.sources.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const activeSource =
    sourceQuery.data?.find((source) => source.id === selectedSourceId) ?? sourceQuery.data?.[0] ?? null

  useEffect(() => {
    if (activeSource && activeSource.id !== selectedSourceId) setView(viewKey, { sourceId: activeSource.id })
  }, [activeSource, selectedSourceId, setView, viewKey])

  const commentsQuery = useQuery({
    queryKey: ['comments', gameId, activeSource?.id],
    queryFn: () => trpc.comments.list.query({ gameId: gameId!, sourceId: activeSource!.id }),
    enabled: !!gameId && !!activeSource,
  })

  const sync = useMutation({
    mutationFn: (sourceId: string) => trpc.sources.sync.mutate({ sourceId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['comment-sources', gameId] })
      void queryClient.invalidateQueries({ queryKey: ['comments', gameId] })
      void queryClient.invalidateQueries({ queryKey: ['sources', gameId] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: toast.fromError,
  })

  const setStatus = useMutation({
    mutationFn: (value: { id: string; status: CommentStatus }) => trpc.comments.setStatus.mutate(value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['comment-sources', gameId] })
      void queryClient.invalidateQueries({ queryKey: ['comments', gameId] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: toast.fromError,
  })

  const visibleComments = useMemo(() => {
    const rows = commentsQuery.data ?? []
    if (filter === 'all') return rows
    if (filter === 'needs_reply')
      return rows.filter((comment) => comment.status === 'unread' || comment.status === 'open')
    return rows.filter((comment) => comment.status === filter)
  }, [commentsQuery.data, filter])

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    [lang],
  )

  if (!gameId) return null

  const askMarCat = (comment: NonNullable<typeof commentsQuery.data>[number]) => {
    const prompt =
      lang === 'ru'
        ? `Проанализируй отзыв игрока и подготовь короткий, человеческий ответ от разработчика. Не публикуй его автоматически.\n\nПлощадка: ${activeSource?.label ?? comment.platform}\nАвтор: ${comment.authorName ?? 'неизвестен'}\nОценка: ${comment.rating ?? 'не указана'}\nТекст: ${comment.body}\nСсылка: ${comment.url}`
        : `Analyze this player feedback and draft a short, human developer reply. Do not publish it automatically.\n\nPlatform: ${activeSource?.label ?? comment.platform}\nAuthor: ${comment.authorName ?? 'unknown'}\nRating: ${comment.rating ?? 'not provided'}\nText: ${comment.body}\nURL: ${comment.url}`
    setSeedPrompt(prompt)
    navigate(`/g/${gameId}/ai`)
  }

  return (
    <div className="enter-stagger mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="t-title text-balance">{t('nav.comments')}</h1>
        <p className="mt-1 max-w-2xl t-body text-pretty text-muted">{t('comments.subtitle')}</p>
      </header>

      {sourceQuery.isError && <QueryError error={sourceQuery.error} onRetry={() => void sourceQuery.refetch()} />}
      {sourceQuery.isLoading && <LoadingState />}

      {sourceQuery.data && (
        <section aria-label={t('nav.comments')}>
          {sourceQuery.data.length > 0 && (
            <div className="overflow-x-auto border-b border-border">
              <div className="flex min-w-max gap-1" role="tablist">
                {sourceQuery.data.map((source) => {
                  const active = source.id === activeSource?.id
                  return (
                    <button
                      key={source.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setView(viewKey, { sourceId: source.id })}
                      className={cn(
                        'relative inline-flex min-h-10 items-center gap-2 rounded-t-[var(--radius)] px-3 text-sm transition-[color,background-color,scale] duration-150 ease-out active:scale-[0.96]',
                        active ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2/60 hover:text-text',
                      )}
                    >
                      <span>{source.displayName || source.label}</span>
                      {source.needsReply > 0 && (
                        <span className="min-w-5 rounded-full bg-accent-fill px-1.5 text-center text-[11px] font-medium leading-5 text-accent-fg tabular-nums">
                          {Math.min(source.needsReply, 99)}
                        </span>
                      )}
                      {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Link
              to={`/g/${gameId}/sources?kind=feedback`}
              className="tap inline-flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] px-3 text-sm font-medium text-accent transition-[scale,background-color] duration-150 ease-out hover:bg-accent/10 active:scale-[0.96]"
            >
              <MessageSquarePlus className="h-4 w-4" aria-hidden />
              {t('comments.addPlatforms')}
            </Link>
            {activeSource && (
              <>
                <select
                  value={filter}
                  onChange={(event) => setView(viewKey, { filter: event.target.value })}
                  className={cn(fieldCls, 'ml-auto w-auto min-w-40')}
                  aria-label={t('comments.needsReply')}
                >
                  {FILTERS.map((value) => (
                    <option key={value} value={value}>
                      {t(`comments.${value === 'needs_reply' ? 'needsReply' : value}`)}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sync.mutate(activeSource.id)}
                  disabled={sync.isPending}
                >
                  <RefreshCw className={cn('h-4 w-4', sync.isPending && 'animate-spin')} aria-hidden />
                  {t('comments.sync')}
                </Button>
              </>
            )}
          </div>
        </section>
      )}

      {sourceQuery.data?.length === 0 && (
        <p className="max-w-xl text-pretty text-sm text-muted">{t('comments.noPlatforms')}</p>
      )}
      {activeSource?.lastStatus === 'error' && (
        <p className="text-pretty text-sm text-alarm">{t('comments.sourceError')}</p>
      )}
      {commentsQuery.isError && <QueryError error={commentsQuery.error} onRetry={() => void commentsQuery.refetch()} />}
      {commentsQuery.isLoading && <LoadingState />}

      {activeSource && commentsQuery.data && visibleComments.length === 0 && (
        <p className="py-8 text-center text-sm text-muted">{t('comments.noItems')}</p>
      )}

      <div className="space-y-2">
        {visibleComments.map((comment) => (
          <article
            key={comment.id}
            className="rounded-[calc(var(--radius)+4px)] bg-surface p-4 shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-border)_82%,transparent),0_2px_8px_rgba(0,0,0,0.04)]"
          >
            <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{comment.authorName || t('comments.unknownAuthor')}</span>
                  <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', statusTone[comment.status])}>
                    {t(`comments.${comment.status}`)}
                  </span>
                  {comment.rating != null && (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-warning tabular-nums"
                      title={t('comments.rating', { n: comment.rating })}
                    >
                      <Star className="h-3.5 w-3.5 fill-current" aria-hidden />
                      {comment.rating}
                    </span>
                  )}
                </div>
                <time className="mt-0.5 block text-xs text-muted tabular-nums" dateTime={comment.publishedAt}>
                  {dateFormatter.format(new Date(comment.publishedAt))}
                </time>
              </div>
            </div>

            <p className="mt-3 whitespace-pre-wrap text-pretty text-sm leading-6 text-text">{comment.body}</p>

            {comment.developerReply && (
              <div className="mt-3 rounded-[var(--radius)] bg-surface-2 px-3 py-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  {t('comments.developerReply')}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-pretty text-sm leading-5">{comment.developerReply}</p>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2">
              <a
                href={comment.url}
                target="_blank"
                rel="noreferrer"
                className="tap inline-flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] px-2 text-sm text-muted transition-[scale,background-color,color] duration-150 ease-out hover:bg-surface-2 hover:text-text active:scale-[0.96]"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                {t('common.open')}
              </a>
              <button
                type="button"
                onClick={() => askMarCat(comment)}
                className="tap inline-flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] px-2 text-sm text-muted transition-[scale,background-color,color] duration-150 ease-out hover:bg-surface-2 hover:text-accent active:scale-[0.96]"
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                {t('comments.askCat')}
              </button>
              <select
                value={comment.status}
                onChange={(event) => setStatus.mutate({ id: comment.id, status: event.target.value as CommentStatus })}
                disabled={setStatus.isPending && setStatus.variables?.id === comment.id}
                className={cn(fieldCls, 'ml-auto w-auto min-w-36 text-xs')}
                aria-label={t(`comments.${comment.status}`)}
              >
                {(['unread', 'open', 'replied', 'ignored'] as const).map((status) => (
                  <option key={status} value={status}>
                    {t(`comments.${status}`)}
                  </option>
                ))}
              </select>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
