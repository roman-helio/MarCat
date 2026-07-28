import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowRight, BookOpen, ChevronDown, RefreshCcw, Sparkles, X } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc'
import { FACES, faceFor, type Mood } from '@/components/companion/cat'
import { useCompanion } from '@/store/companion'
import { useUi } from '@/store/ui'
import { useSettings, matchesCombo } from '@/store/settings'
import { useT } from '@/i18n/useT'
import { Button } from '@/components/ui/Button'
import { LevelUpCelebration } from '@/components/companion/LevelUpCelebration'

type AdvisorRequest = { gameId: string; route: string; lang: 'ru' | 'en'; reveal: boolean }

/**
 * MarCat's single focus surface: quick command input in the strip, and a compact
 * contextual card with one recommendation, evidence and safe in-app actions.
 */
export function CompanionBar() {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const {
    mood,
    message,
    setStatus,
    react,
    sleep,
    level,
    setLevel,
    celebration,
    dismissCelebration,
    adviceByGame,
    dismissedByGame,
    rememberAdvice,
    beginAdvice,
    shouldAutoAdvise,
    dismissAdvice,
  } = useCompanion()
  const commandOpen = useUi((state) => state.commandOpen)
  const setCommandOpen = useUi((state) => state.setCommandOpen)
  const currentGameId = useUi((state) => state.currentGameId)
  const setPendingPrompt = useUi((state) => state.setPendingPrompt)
  const lang = useSettings((state) => state.lang)
  const hotkey = useSettings((state) => state.commandHotkey)
  const companionActivity = useSettings((state) => state.companionActivity)
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [blinking, setBlinking] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [showWhy, setShowWhy] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const route = `${location.pathname}${location.search}`

  const snapshot = useQuery({
    queryKey: ['companion-snapshot', currentGameId, route, lang],
    queryFn: () => trpc.companion.snapshot.query({ gameId: currentGameId!, route, lang }),
    enabled: !!currentGameId,
    staleTime: 30_000,
  })
  const aiAvailable = useQuery({
    queryKey: ['ai-available'],
    queryFn: () => trpc.ai.available.query(),
    staleTime: 60_000,
  })
  const stored = currentGameId ? adviceByGame[currentGameId] : undefined
  const isDismissed = Boolean(
    currentGameId && snapshot.data && dismissedByGame[currentGameId] === snapshot.data.fingerprint,
  )
  const hideDismissed = isDismissed && !(companionActivity === 'request' && panelOpen)
  const currentStored = stored?.fingerprint === snapshot.data?.fingerprint && !hideDismissed ? stored : undefined
  const maySurfaceAdvice = companionActivity !== 'request' || panelOpen
  const activeAdvice = maySurfaceAdvice
    ? (currentStored?.advice ?? (!hideDismissed ? snapshot.data?.advice : undefined))
    : undefined
  const displayMood = (message ? mood : (activeAdvice?.mood as Mood | undefined)) ?? 'sleeping'
  const phrase =
    message ?? activeAdvice?.message ?? t(companionActivity === 'request' ? 'comp.requestReady' : 'comp.ready')
  const tone = FACES[displayMood].tone
  const awake = displayMood !== 'sleeping'

  const advisor = useMutation({
    mutationFn: ({ reveal: _reveal, ...value }: AdvisorRequest) => trpc.companion.advise.mutate(value),
    onSuccess: (result, value) => {
      rememberAdvice(value.gameId, { ...result, createdAt: Date.now() })
      if (value.reveal) setPanelOpen(true)
    },
  })

  useEffect(() => {
    if (companionActivity === 'request') sleep()
  }, [companionActivity, sleep])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matchesCombo(event, hotkey)) {
        event.preventDefault()
        setPanelOpen(false)
        setCommandOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkey, setCommandOpen])

  useEffect(() => {
    if (commandOpen) inputRef.current?.focus()
  }, [commandOpen])

  useEffect(() => {
    if (!awake) return
    const id = window.setInterval(() => {
      setBlinking(true)
      window.setTimeout(() => setBlinking(false), 160)
    }, 4800)
    return () => window.clearInterval(id)
  }, [awake])

  useEffect(() => {
    if (!panelOpen) return
    const onPointer = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setPanelOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanelOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [panelOpen])

  useEffect(() => {
    if (snapshot.data && currentGameId) setLevel(currentGameId, snapshot.data.growth.level)
  }, [currentGameId, setLevel, snapshot.data])

  useEffect(() => {
    const data = snapshot.data
    if (
      !currentGameId ||
      !data?.advice.shouldAskClaude ||
      !aiAvailable.data?.available ||
      advisor.isPending ||
      !shouldAutoAdvise(currentGameId, data.fingerprint)
    )
      return
    beginAdvice(currentGameId, data.fingerprint)
    advisor.mutate({ gameId: currentGameId, route, lang, reveal: false })
    // The store methods are stable; depending on the mutation object would re-run on every state flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiAvailable.data?.available, currentGameId, lang, route, snapshot.data?.fingerprint])

  const submit = () => {
    const question = draft.trim()
    setCommandOpen(false)
    setDraft('')
    if (!question) return
    if (!currentGameId) {
      setStatus('idle', t('comp.pickGame'))
      return
    }
    react('working')
    setPendingPrompt(question)
    navigate(`/g/${currentGameId}/ai`)
  }

  const askAdvisor = () => {
    if (!currentGameId || !snapshot.data || advisor.isPending) return
    advisor.mutate({ gameId: currentGameId, route, lang, reveal: true })
  }

  const openAction = () => {
    if (!activeAdvice?.action.path) return
    setPanelOpen(false)
    navigate(activeAdvice.action.path)
  }

  const openCommand = () => {
    setPanelOpen(false)
    setCommandOpen(true)
  }

  const knowledge = currentStored?.knowledge ?? snapshot.data?.knowledge ?? []
  const refs = new Set(
    currentStored?.advice.knowledgeRefs ?? (snapshot.data?.advice.knowledgeIds as string[] | undefined) ?? [],
  )
  const sources = knowledge.filter(
    (card) => refs.has(card.id) && card.source && !card.source.toLocaleLowerCase().includes('steamиздат'),
  )
  const growth = snapshot.data?.growth
  const hunt = snapshot.data?.hunt

  return (
    <>
      {celebration && celebration.gameId === currentGameId && (
        <LevelUpCelebration fromLevel={celebration.fromLevel} level={celebration.level} onClose={dismissCelebration} />
      )}
      <div
        ref={popoverRef}
        className="relative z-50 flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 text-xs"
      >
        <button
          type="button"
          title={t('comp.askTitle')}
          aria-expanded={panelOpen}
          onClick={() => {
            setCommandOpen(false)
            setPanelOpen((open) => !open)
          }}
          className={cn(
            'tap inline-flex min-h-9 min-w-10 items-center font-mono text-sm tracking-tight',
            tone,
            awake && 'bob',
          )}
        >
          {faceFor(displayMood, blinking)}
          {displayMood === 'sleeping' && <span className="blink"> z</span>}
        </button>

        {commandOpen ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') {
                setCommandOpen(false)
                setDraft('')
              }
            }}
            onBlur={() => setCommandOpen(false)}
            placeholder={t('comp.ask')}
            className="h-7 flex-1 rounded-[var(--radius)] border border-accent/60 bg-bg px-2.5 font-mono text-xs text-text outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPanelOpen((open) => !open)}
            className={cn(
              'tap flex min-h-9 flex-1 items-center truncate text-left',
              awake ? 'text-text' : 'text-muted',
            )}
          >
            <span className="truncate text-pretty">{phrase}</span>
          </button>
        )}

        <button
          type="button"
          title={t('comp.level', { n: level })}
          onClick={() => setPanelOpen((open) => !open)}
          className="tap nums inline-flex min-h-9 shrink-0 items-center rounded-[var(--radius)] px-1.5 t-hint text-accent"
        >
          Lv{level}
        </button>

        {panelOpen && (
          <section
            role="dialog"
            aria-label={t('comp.panelTitle')}
            className="enter absolute left-3 top-[calc(100%+8px)] w-[min(460px,calc(100vw-24px))] rounded-[12px] bg-surface p-4 shadow-hard"
          >
            <header className="flex items-start gap-3">
              <div className={cn('mt-0.5 shrink-0 font-mono text-base', tone)}>{faceFor(displayMood, false)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="t-section text-balance">{activeAdvice?.title ?? t('comp.panelTitle')}</h2>
                  {currentStored && (
                    <span className="rounded-[var(--radius)] bg-accent/10 px-1.5 py-0.5 t-hint text-accent">
                      Claude
                    </span>
                  )}
                </div>
                <p className="mt-1 t-body text-pretty text-muted">{activeAdvice?.message ?? t('comp.ready')}</p>
              </div>
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text"
                aria-label={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            {snapshot.data && (
              <div className="mt-4 grid grid-cols-2 gap-2">
                <div className="rounded-[var(--radius)] bg-surface-2 p-2.5">
                  <div className="t-hint">{t('comp.appetite')}</div>
                  <div className="nums mt-0.5 t-body font-medium">
                    {growth?.next == null
                      ? t('comp.maxLevel')
                      : snapshot.data.wishlist.balance == null
                        ? t('comp.noWishlist')
                        : t('comp.untilLevel', { n: growth.remaining })}
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border" aria-hidden>
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
                      style={{ width: `${growth?.pct ?? 0}%` }}
                    />
                  </div>
                </div>
                <div className="rounded-[var(--radius)] bg-surface-2 p-2.5">
                  <div className="t-hint">{t('comp.hunt')}</div>
                  <div className="nums mt-0.5 t-body font-medium">{hunt?.score ?? 0}%</div>
                  <div className="mt-1 truncate t-hint">{t('comp.actions7', { n: hunt?.meaningfulActions ?? 0 })}</div>
                </div>
              </div>
            )}

            {activeAdvice && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={openAction}>
                  {activeAdvice.action.label}
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowWhy((show) => !show)}>
                  <ChevronDown className={cn('h-4 w-4 transition-transform duration-150', showWhy && 'rotate-180')} />
                  {t('comp.why')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowHelp((show) => !show)}>
                  <BookOpen className="h-4 w-4" />
                  {t('comp.howHere')}
                </Button>
              </div>
            )}

            {showWhy && activeAdvice && (
              <div className="mt-3 rounded-[var(--radius)] bg-bg p-3">
                <p className="t-body text-pretty">{activeAdvice.why}</p>
                {sources.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {sources.map((source) => (
                      <div key={source.id} className="t-hint text-pretty">
                        {source.source}
                        {source.sourcePages ? ` · ${t('comp.pages', { pages: source.sourcePages })}` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {showHelp && snapshot.data?.help && (
              <div className="mt-3 rounded-[var(--radius)] bg-bg p-3">
                <h3 className="t-section text-balance">{snapshot.data.help.title}</h3>
                <p className="mt-1 t-body text-pretty text-muted">{snapshot.data.help.guidance}</p>
              </div>
            )}

            {advisor.isError && <p className="mt-3 t-hint text-alarm">{t('comp.advisorError')}</p>}

            <footer className="mt-4 flex flex-wrap items-center gap-1 border-t border-border pt-3">
              {aiAvailable.data?.available && (
                <button
                  type="button"
                  onClick={askAdvisor}
                  disabled={advisor.isPending || !snapshot.data}
                  className="tap inline-flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] px-2.5 t-hint hover:bg-surface-2 hover:text-text disabled:opacity-50"
                >
                  {advisor.isPending ? (
                    <RefreshCcw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {advisor.isPending ? t('comp.thinking') : t('comp.think')}
                </button>
              )}
              <button
                type="button"
                onClick={openCommand}
                className="tap inline-flex min-h-10 items-center rounded-[var(--radius)] px-2.5 t-hint hover:bg-surface-2 hover:text-text"
              >
                {t('comp.askDeeper')}
              </button>
              {currentGameId && snapshot.data && (
                <button
                  type="button"
                  onClick={() => {
                    dismissAdvice(currentGameId, snapshot.data.fingerprint)
                    setPanelOpen(false)
                  }}
                  className="tap ml-auto inline-flex min-h-10 items-center rounded-[var(--radius)] px-2.5 t-hint hover:bg-surface-2 hover:text-text"
                >
                  {t('common.dismiss')}
                </button>
              )}
            </footer>
          </section>
        )}
      </div>
    </>
  )
}
