import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  Gamepad2,
  Lightbulb,
  ListTodo,
  Loader2,
  PartyPopper,
  Plug,
  ScrollText,
  Search,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { matchesCombo } from '@/store/settings'
import { useT } from '@/i18n/useT'

type SearchScope = 'all' | 'games' | 'tasks' | 'creators' | 'festivals' | 'insights' | 'activities' | 'sources'
type SearchResult = Awaited<ReturnType<typeof trpc.search.run.query>>[number]

const kindIcons: Record<SearchResult['kind'], LucideIcon> = {
  game: Gamepad2,
  tasks: ListTodo,
  creators: Users,
  festivals: PartyPopper,
  insights: Lightbulb,
  activities: ScrollText,
  sources: Plug,
}

function scopeForPath(pathname: string): Exclude<SearchScope, 'all' | 'games'> | null {
  if (/^\/g\/[^/]+\/tasks$/.test(pathname)) return 'tasks'
  if (pathname === '/creators' || /^\/g\/[^/]+\/creators$/.test(pathname)) return 'creators'
  if (pathname === '/festivals' || /^\/g\/[^/]+\/festivals$/.test(pathname)) return 'festivals'
  if (/^\/g\/[^/]+\/insights$/.test(pathname)) return 'insights'
  if (/^\/g\/[^/]+\/events$/.test(pathname)) return 'activities'
  if (/^\/g\/[^/]+\/sources$/.test(pathname)) return 'sources'
  return null
}

function pathForResult(result: SearchResult, activeProjectId: string | null): string {
  const detailPath = (path: string, key: string) => `${path}?${new URLSearchParams({ [key]: result.id })}`
  if (result.kind === 'game') return `/g/${result.id}`
  if (result.kind === 'tasks') return detailPath(`/g/${result.gameId}/tasks`, 'task')
  if (result.kind === 'creators')
    return detailPath(activeProjectId ? `/g/${activeProjectId}/creators` : '/creators', 'creator')
  if (result.kind === 'festivals')
    return detailPath(activeProjectId ? `/g/${activeProjectId}/festivals` : '/festivals', 'festival')
  if (result.kind === 'insights') return detailPath(`/g/${result.gameId}/insights`, 'insight')
  if (result.kind === 'activities') return detailPath(`/g/${result.gameId}/events`, 'activity')
  return detailPath(`/g/${result.gameId}/sources`, 'source')
}

/** Ctrl/⌘+F quick search, scoped to the current catalogue by default. */
export function QuickSearch() {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const open = useUi((state) => state.searchOpen)
  const setOpen = useUi((state) => state.setSearchOpen)
  const currentGameId = useUi((state) => state.currentGameId)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const [activeIndex, setActiveIndex] = useState(0)
  const deferredQuery = useDeferredValue(query.trim())
  const pageScope = useMemo(() => scopeForPath(location.pathname), [location.pathname])
  const activeProjectId = location.pathname.match(/^\/g\/([^/]+)/)?.[1] ?? null
  const scopedGameId = activeProjectId ?? currentGameId

  const results = useQuery({
    queryKey: ['quick-search', deferredQuery, scope, scope === 'all' ? null : scopedGameId],
    queryFn: () =>
      trpc.search.run.query({
        query: deferredQuery,
        scope,
        ...(scope !== 'all' && scopedGameId ? { gameId: scopedGameId } : {}),
      }),
    enabled: open && deferredQuery.length > 0,
    staleTime: 10_000,
  })
  const items = results.data ?? []
  const selectedIndex = Math.max(0, Math.min(activeIndex, Math.max(items.length - 1, 0)))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matchesCombo(event, 'ctrl+f') || matchesCombo(event, 'meta+f')) {
        event.preventDefault()
        if (open) inputRef.current?.select()
        else setOpen(true)
      } else if (open && event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setScope(pageScope ?? 'all')
    setActiveIndex(0)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, pageScope])

  useEffect(() => setActiveIndex(0), [deferredQuery, scope])

  useEffect(() => {
    resultsRef.current
      ?.querySelector<HTMLElement>(`[data-search-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const openResult = (result: SearchResult) => {
    navigate(pathForResult(result, activeProjectId))
    setOpen(false)
  }

  const chooseScope = (next: SearchScope) => {
    setScope(next)
    inputRef.current?.focus()
  }

  return (
    <div
      ref={(node) => {
        if (node) node.inert = !open
      }}
      aria-hidden={!open}
      className={cn(
        'fixed inset-0 z-[90] flex items-start justify-center bg-black/30 px-4 pt-[8vh] transition-[opacity,background-color] duration-150 ease-out motion-reduce:transition-none',
        open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
      )}
      onMouseDown={() => setOpen(false)}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('search.open')}
        className={cn(
          'flex max-h-[78vh] w-[min(680px,94vw)] flex-col overflow-hidden rounded-[16px] bg-surface shadow-hard transition-[transform,opacity,filter] duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-y-0 opacity-100 blur-0' : '-translate-y-3 opacity-0 blur-[4px]',
        )}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-14 items-center gap-3 px-4 focus-within:shadow-[inset_0_-2px_0_var(--accent)]">
          <Search className="h-5 w-5 shrink-0 text-accent" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((index) => (items.length ? Math.min(index + 1, items.length - 1) : 0))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((index) => Math.max(index - 1, 0))
              } else if (event.key === 'Enter' && items[selectedIndex]) {
                event.preventDefault()
                openResult(items[selectedIndex])
              }
            }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            className="h-14 min-w-0 flex-1 appearance-none bg-transparent text-base text-text outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {results.isFetching && deferredQuery && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" aria-hidden />
          )}
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              aria-label={t('common.clear')}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="tap inline-flex h-10 min-w-10 shrink-0 items-center justify-center rounded-[var(--radius)] bg-surface-2 px-2 font-mono text-[10px] text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              aria-label={t('common.close')}
            >
              Esc
            </button>
          )}
        </div>

        {pageScope && (
          <div className="border-t border-border px-3 py-2">
            <div className="flex h-10 w-fit items-center rounded-[10px] bg-surface-2 p-1 shadow-[inset_0_0_0_1px_var(--border)]">
              <button
                type="button"
                onClick={() => chooseScope(pageScope)}
                className={cn(
                  'tap h-8 rounded-[6px] px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                  scope === pageScope ? 'bg-surface text-accent shadow-hard' : 'text-muted hover:text-text',
                )}
              >
                {t('search.current', { section: t(`search.scope.${pageScope}`) })}
              </button>
              <button
                type="button"
                onClick={() => chooseScope('all')}
                className={cn(
                  'tap h-8 rounded-[6px] px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                  scope === 'all' ? 'bg-surface text-accent shadow-hard' : 'text-muted hover:text-text',
                )}
              >
                {t('search.everywhere')}
              </button>
            </div>
          </div>
        )}

        <div ref={resultsRef} className="min-h-52 flex-1 overflow-y-auto border-t border-border p-2">
          {!deferredQuery ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-6 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-accent/10 text-accent">
                <Search className="h-5 w-5" aria-hidden />
              </span>
              <p className="t-section">{t('search.start')}</p>
              <p className="max-w-sm t-hint">{t('search.startHint')}</p>
            </div>
          ) : results.isPending ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
              {t('common.loading')}
            </div>
          ) : results.isError ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="t-section text-alarm">{t('common.loadError')}</p>
              <button
                type="button"
                className="tap min-h-10 rounded-[var(--radius)] px-3 text-accent"
                onClick={() => results.refetch()}
              >
                {t('common.retry')}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="t-section">{t('search.empty')}</p>
              <p className="max-w-sm t-hint">{t(scope === 'all' ? 'search.emptyHint' : 'search.emptyCurrentHint')}</p>
              {scope !== 'all' && (
                <button
                  type="button"
                  className="tap min-h-10 rounded-[var(--radius)] px-3 text-sm text-accent hover:bg-accent/10"
                  onClick={() => chooseScope('all')}
                >
                  {t('search.searchEverywhere')}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <p className="px-2 pb-1 pt-0.5 t-hint">{t('search.results', { n: items.length })}</p>
              {items.map((item, index) => {
                const Icon = kindIcons[item.kind]
                return (
                  <button
                    key={`${item.kind}:${item.id}`}
                    type="button"
                    data-search-index={index}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => openResult(item)}
                    className={cn(
                      'tap group flex min-h-14 w-full items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                      index === selectedIndex ? 'bg-accent/10 text-text' : 'text-text hover:bg-surface-2',
                    )}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-muted shadow-[inset_0_0_0_1px_var(--border)] group-hover:text-text">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      {item.subtitle && <span className="block truncate t-hint">{item.subtitle}</span>}
                      {item.excerpt && item.excerpt !== item.subtitle && (
                        <span className="block truncate text-[11px] text-muted/80">{item.excerpt}</span>
                      )}
                    </span>
                    <span className="shrink-0 t-hint">{t(`search.kind.${item.kind}`)}</span>
                    <ArrowRight
                      className={cn(
                        'h-4 w-4 shrink-0 text-muted transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none',
                        index === selectedIndex ? 'translate-x-0 opacity-100' : '-translate-x-1 opacity-0',
                      )}
                      aria-hidden
                    />
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex min-h-10 items-center gap-4 border-t border-border px-4 py-2 t-hint">
          <span>{t('search.hintNavigate')}</span>
          <span>{t('search.hintOpen')}</span>
          <span className="ml-auto">{scope === 'all' ? t('search.everywhere') : t(`search.scope.${scope}`)}</span>
        </div>
      </section>
    </div>
  )
}
