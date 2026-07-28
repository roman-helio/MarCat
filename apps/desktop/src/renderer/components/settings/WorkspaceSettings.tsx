import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, FolderCog, FolderOpen, RefreshCw, ShieldAlert } from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { useT } from '@/i18n/useT'
import { useSettings } from '@/store/settings'
import { confirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { QueryError } from '@/components/ui/QueryState'
import { cn } from '@/lib/utils'

type Game = { id: string; name: string; color: string }
type Issue = Awaited<ReturnType<typeof trpc.workspace.issues.query>>[number]

const statusKeys = ['synced', 'dirty', 'conflict', 'missing', 'invalid', 'quarantined'] as const

function issueDetails(issue: Issue): { entityType?: string; entityId?: string } {
  try {
    const value = JSON.parse(issue.detailsJson) as Record<string, unknown>
    return {
      entityType: typeof value.entityType === 'string' ? value.entityType : undefined,
      entityId: typeof value.entityId === 'string' ? value.entityId : undefined,
    }
  } catch {
    return {}
  }
}

function WorkspaceIssue({
  issue,
  gameId,
  workspaceRoot,
  onChanged,
}: {
  issue: Issue
  gameId: string
  workspaceRoot: string | null
  onChanged: () => void
}) {
  const t = useT()
  const details = issueDetails(issue)
  const isMissing = issue.kind === 'missing' && details.entityType && details.entityId
  const decideMissing = useMutation({
    mutationFn: (decision: 'restore' | 'quarantine') =>
      trpc.workspace.decideMissing.mutate({
        gameId,
        entityType: details.entityType as 'project' | 'insight' | 'task' | 'tag' | 'activity',
        entityId: details.entityId!,
        decision,
      }),
    onSuccess: () => {
      toast.success(t('workspace.issueUpdated'))
      onChanged()
    },
    onError: toast.fromError,
  })
  const resolve = useMutation({
    mutationFn: () => trpc.workspace.resolveIssue.mutate({ id: issue.id }),
    onSuccess: onChanged,
    onError: toast.fromError,
  })
  const openFolder = async () => {
    if (!workspaceRoot) return
    const result = await window.marcat?.openLocalPath(workspaceRoot)
    if (result && !result.ok) toast.error(result.error ?? t('workspace.openFailed'))
  }

  return (
    <li className="rounded-[10px] bg-bg p-2.5 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="flex items-start gap-2">
        {issue.severity === 'error' ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alarm" aria-hidden />
        ) : (
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-xs font-medium text-text">{t(`workspace.issue.${issue.kind}`)}</span>
            {issue.relativePath && (
              <span className="truncate font-mono text-[11px] text-muted" title={issue.relativePath}>
                {issue.relativePath}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{issue.message}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {isMissing && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => decideMissing.mutate('restore')}
                  disabled={decideMissing.isPending}
                >
                  {t('workspace.restoreFile')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => decideMissing.mutate('quarantine')}
                  disabled={decideMissing.isPending}
                >
                  {t('workspace.quarantineRecord')}
                </Button>
              </>
            )}
            {(issue.kind === 'conflict' || issue.kind === 'invalid_yaml' || issue.kind === 'invalid_document') && (
              <Button size="sm" variant="ghost" onClick={() => void openFolder()} disabled={!workspaceRoot}>
                <FolderOpen className="h-4 w-4" aria-hidden />
                {t('workspace.openFolder')}
              </Button>
            )}
            {(issue.kind === 'duplicate_id' || issue.kind === 'io') && (
              <Button size="sm" variant="ghost" onClick={() => resolve.mutate()} disabled={resolve.isPending}>
                {t('workspace.markResolved')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

function GameWorkspaceCard({ game }: { game: Game }) {
  const t = useT()
  const lang = useSettings((state) => state.lang)
  const qc = useQueryClient()
  const [chosenRoot, setChosenRoot] = useState<string | null>(null)
  const status = useQuery({
    queryKey: ['workspace', game.id, 'status'],
    queryFn: () => trpc.workspace.status.query({ gameId: game.id }),
    staleTime: 10_000,
  })
  const configured = status.data?.config ?? null
  const enabled = configured?.enabled ?? false
  const paths = useQuery({
    queryKey: ['workspace', game.id, 'paths'],
    queryFn: () => trpc.workspace.paths.query({ gameId: game.id }),
    enabled,
    staleTime: 10_000,
  })
  const issues = useQuery({
    queryKey: ['workspace', game.id, 'issues'],
    queryFn: () => trpc.workspace.issues.query({ gameId: game.id }),
    enabled: Boolean(configured),
    staleTime: 5_000,
  })
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['workspace', game.id] })
  }
  const configure = useMutation({
    mutationFn: (rootPath: string) =>
      trpc.workspace.configure.mutate({ gameId: game.id, rootPath, workspaceFolder: 'MarCat' }),
    onSuccess: () => {
      setChosenRoot(null)
      toast.success(t('workspace.enabledToast', { name: game.name }))
      invalidate()
    },
    onError: toast.fromError,
  })
  const rescan = useMutation({
    mutationFn: () => trpc.workspace.reconcile.mutate({ gameId: game.id }),
    onSuccess: (result) => {
      toast.success(t('workspace.scanDone', { scanned: result.scanned, issues: result.issues }))
      invalidate()
    },
    onError: toast.fromError,
  })
  const exportAll = useMutation({
    mutationFn: () => trpc.workspace.exportAll.mutate({ gameId: game.id }),
    onSuccess: (result) => {
      toast.success(t('workspace.exportDone', { n: result.exported }))
      invalidate()
    },
    onError: toast.fromError,
  })
  const disable = useMutation({
    mutationFn: () => trpc.workspace.disable.mutate({ gameId: game.id }),
    onSuccess: () => {
      toast.success(t('workspace.disabledToast', { name: game.name }))
      invalidate()
    },
    onError: toast.fromError,
  })
  const chooseFolder = async () => {
    if (!window.marcat?.chooseProjectFolder) {
      toast.error(t('workspace.folderUnavailable'))
      return
    }
    const selected = await window.marcat.chooseProjectFolder()
    if (selected) setChosenRoot(selected)
  }
  const openPath = async () => {
    const target = paths.data?.root ?? configured?.rootPath
    if (!target) return
    const result = await window.marcat?.openLocalPath(target)
    if (result && !result.ok) toast.error(result.error ?? t('workspace.openFailed'))
  }
  const askDisable = () =>
    void confirm({
      title: t('workspace.disableTitle', { name: game.name }),
      body: t('workspace.disableConfirm'),
      confirmLabel: t('workspace.disable'),
    }).then((ok) => ok && disable.mutate())

  const rootPath = chosenRoot ?? configured?.rootPath ?? null
  const busy = configure.isPending || rescan.isPending || exportAll.isPending || disable.isPending
  const pending = (status.data?.files.dirty ?? 0) + (status.data?.pendingWrites ?? 0)
  const counts = status.data
    ? {
        ...status.data.files,
        dirty: pending,
      }
    : null

  return (
    <article className="rounded-[12px] bg-surface-2 p-1 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="space-y-3 rounded-[8px] bg-surface p-3 shadow-hard">
        <header className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: game.color }} aria-hidden />
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-text">{game.name}</h3>
          <span
            className={cn(
              'inline-flex min-h-7 items-center rounded-full px-2.5 text-[11px] font-medium',
              enabled ? 'bg-success/10 text-success' : 'bg-bg text-muted',
            )}
            role="status"
          >
            {enabled ? t('workspace.enabled') : t('workspace.disabled')}
          </span>
        </header>

        {status.isError ? (
          <QueryError error={status.error} onRetry={() => void status.refetch()} />
        ) : status.isLoading ? (
          <p className="min-h-10 py-2 text-xs text-muted" role="status">
            {t('common.loading')}
          </p>
        ) : (
          <>
            <div className="grid gap-1.5 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="min-w-0">
                <span className="text-[11px] text-muted">{t('workspace.projectFolder')}</span>
                <div
                  className="mt-1 min-h-10 truncate rounded-[var(--radius)] bg-bg px-3 py-2.5 font-mono text-xs text-text shadow-[inset_0_0_0_1px_var(--border)]"
                  title={rootPath ?? t('workspace.notChosen')}
                >
                  {rootPath ?? t('workspace.notChosen')}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => void chooseFolder()} disabled={busy}>
                <FolderCog className="h-4 w-4" aria-hidden />
                {rootPath ? t('workspace.changeFolder') : t('workspace.chooseFolder')}
              </Button>
            </div>
            {configured && (
              <p className="text-[11px] text-muted">
                {t('workspace.managedFolder')}: <span className="font-mono">{configured.workspaceFolder}</span>
              </p>
            )}

            {counts && configured && (
              <dl className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" aria-label={t('workspace.syncCounts')}>
                {statusKeys.map((key) => (
                  <div key={key} className="rounded-[var(--radius)] bg-bg px-2 py-1.5 text-center">
                    <dt className="truncate text-[10px] text-muted">{t(`workspace.count.${key}`)}</dt>
                    <dd
                      className={cn(
                        'nums mt-0.5 text-sm font-medium',
                        key === 'conflict' || key === 'invalid'
                          ? 'text-alarm'
                          : key === 'missing'
                            ? 'text-warning'
                            : 'text-text',
                      )}
                    >
                      {counts[key]}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              {(!enabled || (chosenRoot && chosenRoot !== configured?.rootPath)) && rootPath && (
                <Button size="sm" onClick={() => configure.mutate(rootPath)} disabled={busy}>
                  {enabled ? t('workspace.changeAndExport') : t('workspace.enableAndExport')}
                </Button>
              )}
              {rootPath && (
                <Button size="sm" variant="outline" onClick={() => void openPath()} disabled={busy}>
                  <FolderOpen className="h-4 w-4" aria-hidden />
                  {t('workspace.openFolder')}
                </Button>
              )}
              {enabled && (
                <>
                  <Button size="sm" variant="outline" onClick={() => rescan.mutate()} disabled={busy}>
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    {t('workspace.rescan')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => exportAll.mutate()} disabled={busy}>
                    {t('workspace.exportAll')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={askDisable} disabled={busy} className="ml-auto text-muted">
                    {t('workspace.disable')}
                  </Button>
                </>
              )}
            </div>

            {configured && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted" aria-live="polite">
                {busy ? (
                  <span>{t('workspace.working')}</span>
                ) : (status.data?.openIssues ?? 0) > 0 ? (
                  <span className="inline-flex items-center gap-1 text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                    {t('workspace.needsAttention', { n: status.data?.openIssues ?? 0 })}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                    {t('workspace.upToDate')}
                  </span>
                )}
                <span className="nums">
                  {t('workspace.lastScan')}:{' '}
                  {configured?.lastScanAt
                    ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(
                        new Date(configured.lastScanAt),
                      )
                    : t('workspace.never')}
                </span>
              </div>
            )}

            {configured && (issues.data?.length ?? 0) > 0 && (
              <div className="space-y-2 border-t border-border pt-3">
                <div>
                  <h4 className="text-xs font-medium text-text">{t('workspace.issues')}</h4>
                  <p className="mt-0.5 text-xs text-muted">{t('workspace.noSilentDelete')}</p>
                </div>
                <ul className="space-y-1.5">
                  {issues.data?.map((issue) => (
                    <WorkspaceIssue
                      key={issue.id}
                      issue={issue}
                      gameId={game.id}
                      workspaceRoot={paths.data?.root ?? null}
                      onChanged={invalidate}
                    />
                  ))}
                </ul>
              </div>
            )}
            {configured && issues.isError && <QueryError error={issues.error} onRetry={() => void issues.refetch()} />}
          </>
        )}
      </div>
    </article>
  )
}

export function WorkspaceSettings() {
  const t = useT()
  const games = useQuery({ queryKey: ['games'], queryFn: () => trpc.games.list.query(), staleTime: 10_000 })

  return (
    <section className="space-y-3 rounded-[var(--radius)] border border-border bg-surface p-3.5">
      <div>
        <h2 className="t-section">{t('workspace.title')}</h2>
        <p className="mt-1 text-xs text-muted">{t('workspace.intro')}</p>
      </div>
      <div className="rounded-[var(--radius)] bg-info/8 px-3 py-2 text-xs leading-relaxed text-info shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--info)_25%,transparent)]">
        {t('workspace.ownership')}
      </div>
      {games.isError && <QueryError error={games.error} onRetry={() => void games.refetch()} />}
      {games.isLoading && (
        <p className="min-h-10 py-2 text-xs text-muted" role="status">
          {t('common.loading')}
        </p>
      )}
      <div className="space-y-2.5">
        {games.data?.map((game) => (
          <GameWorkspaceCard key={game.id} game={game} />
        ))}
      </div>
      {games.data?.length === 0 && <p className="text-xs text-muted">{t('workspace.noGames')}</p>}
    </section>
  )
}
