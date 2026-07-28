import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { useCompanion } from '@/store/companion'
import { confirm as askConfirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n/useT'
import { LoadingState, QueryError } from '@/components/ui/QueryState'

export function Sources() {
  const t = useT()
  const { gameId } = useParams<{ gameId: string }>()
  const [searchParams] = useSearchParams()
  const feedbackOnly = searchParams.get('kind') === 'feedback'
  const focusedSourceId = searchParams.get('source')
  const setCurrentGame = useUi((s) => s.setCurrentGame)
  const react = useCompanion((s) => s.react)
  const qc = useQueryClient()
  const [platform, setPlatform] = useState<string>(feedbackOnly ? 'steam_reviews' : 'steam')
  const [handle, setHandle] = useState('')
  const [confirm, setConfirm] = useState<{ sourceId: string; est: number } | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [historyFor, setHistoryFor] = useState<string | null>(null)

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
  }, [gameId, setCurrentGame])

  const sources = useQuery({
    queryKey: ['sources', gameId],
    queryFn: () => trpc.sources.list.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  useEffect(() => {
    if (!focusedSourceId || !sources.data) return
    window.requestAnimationFrame(() =>
      document.getElementById(`source-${focusedSourceId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    )
  }, [focusedSourceId, sources.data])
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => trpc.sources.platforms.query() })
  const keyStatus = useQuery({ queryKey: ['connector-keys'], queryFn: () => trpc.sources.keyStatus.query() })
  const history = useQuery({
    queryKey: ['sync-history', historyFor],
    queryFn: () => trpc.sources.history.query({ sourceId: historyFor! }),
    enabled: !!historyFor,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['sources', gameId] })
    qc.invalidateQueries({ queryKey: ['wishlist', gameId] })
    qc.invalidateQueries({ queryKey: ['events', gameId] })
    qc.invalidateQueries({ queryKey: ['spend'] })
    qc.invalidateQueries({ queryKey: ['comment-sources', gameId] })
    qc.invalidateQueries({ queryKey: ['comments', gameId] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
    if (historyFor) qc.invalidateQueries({ queryKey: ['sync-history', historyFor] })
  }
  const create = useMutation({
    mutationFn: () => trpc.sources.create.mutate({ gameId: gameId!, platform, handle: handle.trim() }),
    onSuccess: () => {
      setHandle('')
      qc.invalidateQueries({ queryKey: ['sources', gameId] })
    },
    onError: toast.fromError,
  })
  const remove = useMutation({
    mutationFn: (id: string) => trpc.sources.remove.mutate({ id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources', gameId] }),
    onError: toast.fromError,
  })
  const askDelete = (id: string, name: string) =>
    void askConfirm({ title: t('common.deleteQ', { name }), danger: true, confirmLabel: t('common.delete') }).then(
      (ok) => ok && remove.mutate(id),
    )
  const sync = useMutation({
    mutationFn: (v: { sourceId: string; confirm?: boolean }) => trpc.sources.sync.mutate(v),
    onSuccess: (res, v) => {
      if (res.dryRun) {
        setConfirm({ sourceId: v.sourceId, est: res.estCostUsd })
        return
      }
      setConfirm(null)
      setMsg((m) => ({
        ...m,
        [v.sourceId]: t('src.synced', { n: res.imported }) + (res.costUsd ? ` ($${res.costUsd.toFixed(3)})` : ''),
      }))
      invalidate()
      if (res.imported > 0) react('synced', { n: res.imported })
    },
    onError: (e, v) => {
      setConfirm(null)
      setMsg((m) => ({ ...m, [v.sourceId]: e instanceof Error ? e.message : String(e) }))
    },
  })

  if (!gameId) return null
  const platformInfo = (id: string) => platforms.data?.find((p) => p.id === id)
  const selectedInfo = platformInfo(platform)
  const availablePlatforms = (platforms.data ?? []).filter((item) => !feedbackOnly || item.kind === 'feedback')
  const missingKey = (provider: string | null | undefined) =>
    provider === 'twitterapi'
      ? !keyStatus.data?.twitterapi
      : provider === 'scrapecreators'
        ? !keyStatus.data?.scrapecreators
        : provider === 'youtube'
          ? !keyStatus.data?.youtube
          : false

  return (
    <div className="enter-stagger mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="t-title">{t('nav.sources')}</h1>
        <p className="mt-1 max-w-2xl t-body text-pretty text-muted">{t('src.subtitle')}</p>
      </header>

      {/* add source */}
      <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius)] border border-border bg-surface p-3">
        <label className="grid gap-1 t-hint">
          {t('src.platform')}
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={cn(fieldCls, 'w-40')}>
            {availablePlatforms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.paid ? ' · $' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="grid flex-1 gap-1 t-hint">
          {selectedInfo?.kind === 'feedback'
            ? t('src.pageUrl')
            : platform === 'steam'
              ? t('src.folder')
              : t('src.handle')}
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder={
              selectedInfo?.kind === 'feedback'
                ? t('src.feedbackPlaceholder')
                : platform === 'steam'
                  ? 'C:\\…\\wishlist-exports'
                  : '@handle'
            }
            className={fieldCls}
          />
        </label>
        <Button
          size="sm"
          onClick={() => handle.trim() && create.mutate()}
          disabled={!handle.trim() || create.isPending}
        >
          <Plus className="h-4 w-4" />
          {t('common.add')}
        </Button>
      </div>

      {platforms.data?.some((p) => p.paid) && (
        <p className="text-xs text-muted">
          {t('src.keysHint')}{' '}
          <Link to="/settings" className="text-accent hover:underline">
            {t('nav.settings')}
          </Link>
        </p>
      )}

      {sources.isError && <QueryError error={sources.error} onRetry={() => void sources.refetch()} />}
      {sources.isLoading && <LoadingState />}
      {sources.data && sources.data.length === 0 && <p className="text-sm text-muted">{t('src.empty')}</p>}

      <div className="space-y-2">
        {(sources.data ?? []).map((s) => {
          const info = platformInfo(s.platform)
          const noKey = info?.needsKey && missingKey(info.provider)
          const pending = confirm?.sourceId === s.id
          return (
            <div
              key={s.id}
              id={`source-${s.id}`}
              className={cn(
                'rounded-[var(--radius)] border bg-surface p-3 transition-[border-color,box-shadow] duration-150',
                focusedSourceId === s.id
                  ? 'border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]'
                  : 'border-border',
              )}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{info?.label ?? s.platform}</span>
                    {info?.paid && (
                      <span
                        className="rounded bg-warning/15 px-1.5 text-xs text-warning"
                        title={t('src.paid')}
                        aria-label={t('src.paid')}
                      >
                        $
                      </span>
                    )}
                    {s.lastStatus === 'error' && <span className="text-xs text-alarm">{t('src.error')}</span>}
                    {s.lastStatus === 'ok' && <span className="text-xs text-success">{t('src.ok')}</span>}
                  </div>
                  <div className="truncate text-xs text-muted">{s.handle}</div>
                </div>
                <button
                  onClick={() => setHistoryFor(historyFor === s.id ? null : s.id)}
                  className="tap nums rounded-[var(--radius)] px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
                >
                  {s.lastSyncedAt ? s.lastSyncedAt.slice(0, 10) : t('src.never')}
                </button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sync.mutate({ sourceId: s.id })}
                  disabled={sync.isPending || !!noKey}
                  title={noKey ? t('src.noKey') : undefined}
                >
                  <RefreshCw
                    className={cn('h-4 w-4', sync.isPending && sync.variables?.sourceId === s.id && 'animate-spin')}
                  />
                  {t('src.sync')}
                </Button>
                <button
                  onClick={() => askDelete(s.id, info?.label ?? s.platform)}
                  disabled={remove.isPending}
                  className="tap inline-flex items-center justify-center rounded-[var(--radius)] p-1.5 text-muted hover:bg-surface-2 hover:text-alarm"
                  aria-label={t('common.delete')}
                  title={t('common.delete')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {noKey && <p className="mt-1 text-xs text-warning">{t('src.noKey')}</p>}

              {pending && (
                <div className="mt-2 flex items-center gap-2 rounded-[var(--radius)] border border-warning/40 bg-warning/5 px-2 py-1.5 text-xs">
                  <span className="nums flex-1">{t('src.confirmCost', { n: confirm!.est.toFixed(3) })}</span>
                  <Button
                    size="sm"
                    onClick={() => sync.mutate({ sourceId: s.id, confirm: true })}
                    disabled={sync.isPending}
                  >
                    {t('src.confirm')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              )}

              {msg[s.id] && !pending && <p className="mt-1 text-xs text-muted">{msg[s.id]}</p>}

              {historyFor === s.id && (
                <div className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted">
                  {(history.data ?? []).length === 0 && <p>{t('src.noHistory')}</p>}
                  {(history.data ?? []).map((r) => (
                    <div key={r.id} className="flex items-center gap-2">
                      <span
                        className={cn(
                          r.status === 'error' ? 'text-alarm' : r.status === 'ok' ? 'text-accent' : 'text-muted',
                        )}
                      >
                        {t(`src.${r.status}`)}
                      </span>
                      <span className="nums">{r.startedAt.slice(0, 16).replace('T', ' ')}</span>
                      <span className="nums">· {t('src.imported', { n: r.imported })}</span>
                      {r.costUsd > 0 && <span className="nums">· ${r.costUsd.toFixed(3)}</span>}
                      {r.error && <span className="truncate text-alarm">· {r.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
