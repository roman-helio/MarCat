import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Plus, Send, Square, Trash2, Wand2, X } from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { useCompanion } from '@/store/companion'
import { bigCat, FACES } from '@/components/companion/cat'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Toggle'
import { PRIORITY_ORDER, type TaskPriority } from '@/components/tasks/meta'
import { samplePlaybooks } from '@/lib/playbooks'
import { catLevel, resolveWishlistBalance } from '@/lib/level'
import { useT } from '@/i18n/useT'
import { QueryError } from '@/components/ui/QueryState'

/** Claude routes research-heavy playbooks to Opus; Codex uses the CLI's configured model. */
const COMPLEX_PLAYBOOKS = new Set(['influencers', 'festivalScan', 'explain'])

const STATUS_KEY: Record<string, string> = {
  running: 'ai.proposed',
  proposed: 'ai.proposed',
  applied: 'ai.applied',
  rejected: 'ai.rejected',
  error: 'ai.errored',
}
const PRIO_BORDER: Record<TaskPriority, string> = {
  urgent: 'var(--color-alarm)',
  high: 'var(--color-warning)',
  med: 'var(--color-info)',
  low: 'var(--color-muted)',
}

type Change = { id: string; entity: string; status: string; after: Record<string, unknown> }
type Draft = {
  title: string
  priority: TaskPriority
  dueDate: string
  description: string
  checklist: string[]
  tags: string[]
}
type Comment = { id: string; quote: string; text: string }

const asStr = (v: unknown) => (typeof v === 'string' ? v : '')
const asList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)) : [])

export function AiDen() {
  const t = useT()
  const { gameId } = useParams<{ gameId: string }>()
  const setCurrentGame = useUi((s) => s.setCurrentGame)
  const pendingPrompt = useUi((s) => s.pendingPrompt)
  const setPendingPrompt = useUi((s) => s.setPendingPrompt)
  const seedPrompt = useUi((s) => s.seedPrompt)
  const setSeedPrompt = useUi((s) => s.setSeedPrompt)
  const consumed = useRef<string | null>(null)
  const promptRef = useRef<HTMLInputElement>(null)
  const { mood, setStatus, sleep, react, setLevel } = useCompanion()
  const qc = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [copied, setCopied] = useState(false)
  const [model, setModel] = useState<'sonnet' | 'opus'>('sonnet')
  const [playbooks] = useState(() => samplePlaybooks(4))

  // review state
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [note, setNote] = useState('')
  const [popover, setPopover] = useState<{ text: string; top: number; left: number } | null>(null)
  const [commentText, setCommentText] = useState('')
  const proposalRef = useRef<HTMLDivElement>(null)
  const commentSeq = useRef(0)

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
  }, [gameId, setCurrentGame])

  const available = useQuery({ queryKey: ['ai-available'], queryFn: () => trpc.ai.available.query() })
  const runs = useQuery({
    queryKey: ['ai-runs', gameId],
    queryFn: () => trpc.ai.listRuns.query({ gameId: gameId! }),
    enabled: !!gameId,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === 'running') ? 1000 : false),
  })
  const detail = useQuery({
    queryKey: ['ai-run', selected],
    queryFn: () => trpc.ai.getRun.query({ id: selected! }),
    enabled: !!selected,
    refetchInterval: (q) => (q.state.data?.run.status === 'running' ? 1000 : false),
  })
  const wishlist = useQuery({
    queryKey: ['wishlist', gameId],
    queryFn: () => trpc.wishlists.series.query({ gameId: gameId! }),
    enabled: !!gameId,
  })

  const run = useMutation({
    mutationFn: (v: { p: string; model: 'sonnet' | 'opus' }) =>
      trpc.ai.run.mutate({ gameId: gameId!, prompt: v.p, model: v.model }),
    onMutate: (v) => {
      setError(null)
      setStatus('thinking', v.p)
    },
    onSuccess: (r) => {
      setPrompt('')
      setComments([])
      setNote('')
      qc.invalidateQueries({ queryKey: ['ai-runs', gameId] })
      if (r) setSelected(r.id)
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setStatus('worried')
    },
  })
  const invalidateApplied = () => {
    qc.invalidateQueries({ queryKey: ['ai-run', selected] })
    qc.invalidateQueries({ queryKey: ['ai-runs', gameId] })
    for (const k of ['tasks', 'events', 'tags', 'tags-status', 'insights']) {
      qc.invalidateQueries({ queryKey: [k, gameId] })
    }
  }
  const approve = useMutation({
    mutationFn: () => trpc.ai.applyRun.mutate({ id: selected! }),
    onSuccess: () => {
      react('onTrack')
      invalidateApplied()
    },
  })
  const reject = useMutation({
    mutationFn: () => trpc.ai.rejectRun.mutate({ id: selected! }),
    onSuccess: () => {
      sleep()
      invalidateApplied()
    },
  })
  const updateChange = useMutation({
    mutationFn: (v: { id: string; after: Record<string, unknown> }) => trpc.ai.updateChange.mutate(v),
  })
  const reply = useMutation({
    mutationFn: (message: string) => trpc.ai.reply.mutate({ runId: selected!, message }),
    onMutate: () => {
      setError(null)
      setStatus('thinking')
    },
    onSuccess: () => {
      setComments([])
      setNote('')
      qc.invalidateQueries({ queryKey: ['ai-run', selected] })
      qc.invalidateQueries({ queryKey: ['ai-runs', gameId] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })
  const cancel = useMutation({
    mutationFn: () => trpc.ai.cancel.mutate({ id: selected! }),
    onSuccess: () => {
      sleep()
      qc.invalidateQueries({ queryKey: ['ai-run', selected] })
      qc.invalidateQueries({ queryKey: ['ai-runs', gameId] })
    },
  })
  const archive = useMutation({
    mutationFn: (id: string) => trpc.ai.archiveRun.mutate({ id }),
    onSuccess: (_r, id) => {
      if (selected === id) setSelected(null)
      qc.invalidateQueries({ queryKey: ['ai-runs', gameId] })
    },
  })

  // React to the run finishing (companion mood follows the polled status).
  const runStatus = detail.data?.run.status
  useEffect(() => {
    if (runStatus === 'proposed') react('proposalReady')
    else if (runStatus === 'error') react('aiError')
  }, [runStatus, react])

  // Reset review state when switching runs.
  useEffect(() => {
    setEditing(null)
    setDraft(null)
    setComments([])
    setNote('')
    setPopover(null)
  }, [selected])

  // Inline-AI: prefill the input with entity context (does NOT auto-run).
  useEffect(() => {
    if (seedPrompt) {
      setPrompt(seedPrompt)
      setSeedPrompt(null)
      promptRef.current?.focus()
    }
  }, [seedPrompt, setSeedPrompt])

  // Run a prompt handed off from the companion command bar.
  useEffect(() => {
    if (pendingPrompt && gameId && consumed.current !== pendingPrompt) {
      consumed.current = pendingPrompt
      const p = pendingPrompt
      setPendingPrompt(null)
      setPrompt(p)
      run.mutate({ p, model })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt, gameId])

  const balance = resolveWishlistBalance(wishlist.data ?? []) ?? 0
  const lvl = catLevel(balance)
  useEffect(() => {
    if (gameId && wishlist.data) setLevel(gameId, lvl.level)
  }, [gameId, lvl.level, setLevel, wishlist.data])

  const d = detail.data
  const changes = useMemo(() => (d?.changes ?? []) as Change[], [d?.changes])
  const taskChanges = changes.filter((c) => c.entity === 'task')
  const otherChanges = changes.filter((c) => c.entity !== 'task' && c.entity !== 'dependency')
  // Fold dependencies into the tasks they block (no noisy standalone rows).
  const blockersOf = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const c of changes) {
      if (c.entity !== 'dependency') continue
      const blocked = asStr(c.after.blocked)
      const blocker = asStr(c.after.blocker)
      if (blocked && blocker) m.set(blocked.toLowerCase(), [...(m.get(blocked.toLowerCase()) ?? []), blocker])
    }
    return m
  }, [changes])

  if (!gameId) return null
  const isOff = available.data && !available.data.available
  const usesCodex = available.data?.provider === 'codex'
  const isProposed = d?.run.status === 'proposed'

  // Debug log: pull usage from either the Claude envelope or Codex JSONL events.
  const rawMeta = (() => {
    if (!d?.run.rawOutput) return null
    try {
      const lines = d.run.rawOutput.split(/\r?\n/).filter(Boolean)
      const parsedLines = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      const j =
        parsedLines.find((event) => event.type === 'turn.completed') ?? parsedLines[parsedLines.length - 1] ?? {}
      const usage = (j.usage ?? {}) as Record<string, number>
      return {
        cost: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
        ms: typeof j.duration_ms === 'number' ? j.duration_ms : null,
        inTok: usage.input_tokens ?? null,
        outTok: usage.output_tokens ?? null,
      }
    } catch {
      return null
    }
  })()
  const copyLog = () => {
    if (!d) return
    void navigator.clipboard?.writeText(
      JSON.stringify(
        {
          prompt: d.run.prompt,
          model: d.run.model,
          status: d.run.status,
          summary: d.run.summary,
          raw: d.run.rawOutput,
          changes: d.changes,
        },
        null,
        2,
      ),
    )
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const openEditor = (c: Change) => {
    setEditing(c.id)
    setDraft({
      title: asStr(c.after.title),
      priority: (['low', 'med', 'high', 'urgent'].includes(asStr(c.after.priority))
        ? asStr(c.after.priority)
        : 'med') as TaskPriority,
      dueDate: asStr(c.after.dueDate),
      description: asStr(c.after.description),
      checklist: asList(c.after.checklist),
      tags: [...asList(c.after.tags), ...(asStr(c.after.tag) ? [asStr(c.after.tag)] : [])],
    })
  }

  const saveEdit = async (c: Change) => {
    if (!draft) return
    const oldTitle = asStr(c.after.title)
    const after: Record<string, unknown> = { ...c.after }
    after.title = draft.title.trim() || oldTitle
    after.priority = draft.priority
    after.description = draft.description
    if (draft.dueDate) after.dueDate = draft.dueDate
    else delete after.dueDate
    after.checklist = draft.checklist.filter((x) => x.trim())
    after.tags = draft.tags.filter((x) => x.trim())
    delete after.tag
    await updateChange.mutateAsync({ id: c.id, after })
    // Keep dependency links valid if the task was renamed.
    if (after.title !== oldTitle) {
      for (const dc of changes.filter((x) => x.entity === 'dependency')) {
        const a = { ...dc.after }
        let touched = false
        if (asStr(a.blocker) === oldTitle) {
          a.blocker = after.title
          touched = true
        }
        if (asStr(a.blocked) === oldTitle) {
          a.blocked = after.title
          touched = true
        }
        if (touched) await updateChange.mutateAsync({ id: dc.id, after: a })
      }
    }
    setEditing(null)
    setDraft(null)
    qc.invalidateQueries({ queryKey: ['ai-run', selected] })
  }

  // Selection → floating comment popover.
  const onProposalMouseUp = () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return setPopover(null)
    const text = sel.toString().trim()
    const node = sel.anchorNode
    if (!text || !node || !proposalRef.current?.contains(node)) return setPopover(null)
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setCommentText('')
    setPopover({ text, top: rect.bottom + 6, left: rect.left })
  }
  const addComment = () => {
    if (!popover || !commentText.trim()) return
    setComments((cs) => [...cs, { id: `c${commentSeq.current++}`, quote: popover.text, text: commentText.trim() }])
    setCommentText('')
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }

  // Send a follow-up in the SAME chat (resumes the session — not a new request).
  const sendReply = () => {
    if (!d || (!comments.length && !note.trim())) return
    const lines = [
      ...comments.map((c, i) => `${i + 1}. Regarding "${c.quote}": ${c.text}`),
      note.trim() ? (comments.length ? `${comments.length + 1}. ${note.trim()}` : note.trim()) : '',
    ].filter(Boolean)
    reply.mutate(lines.join('\n'))
  }

  return (
    <div className="enter-stagger mx-auto max-w-6xl space-y-5">
      <h1 className="t-title">{t('ai.den')}</h1>

      {(available.isError || runs.isError || detail.isError || wishlist.isError) && (
        <QueryError
          error={available.error ?? runs.error ?? detail.error ?? wishlist.error}
          onRetry={() => {
            void available.refetch()
            void runs.refetch()
            void detail.refetch()
            void wishlist.refetch()
          }}
        />
      )}

      <div className="flex items-center gap-4 rounded-[var(--radius)] border border-border bg-surface p-4 shadow-hard">
        <div className="flex w-28 shrink-0 flex-col items-center gap-1">
          <pre className={cn('font-mono text-sm leading-tight', FACES[mood].tone, mood !== 'sleeping' && 'bob')}>
            {bigCat(mood)}
          </pre>
          <div className="w-full">
            <div className="flex items-baseline justify-between t-hint">
              <span className="nums text-accent">{t('cat.level', { n: lvl.level })}</span>
              <span className="nums">{lvl.max ? 'MAX' : `${balance}/${lvl.ceil}`}</span>
            </div>
            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${lvl.pct}%` }} />
            </div>
            <div className="nums mt-0.5 text-center text-xs text-muted">{t('cat.wishlists', { n: balance })}</div>
          </div>
        </div>
        <div className="flex-1">
          {isOff ? (
            <p className="text-sm text-muted">{t('ai.unavailable')}</p>
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  ref={promptRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && prompt.trim()) run.mutate({ p: prompt.trim(), model })
                  }}
                  placeholder={t('ai.ask')}
                  className={fieldCls}
                />
                {usesCodex ? (
                  <div
                    className="inline-flex h-10 shrink-0 items-center rounded-[var(--radius)] bg-accent/10 px-3 text-xs font-medium text-accent shadow-[inset_0_0_0_1px_var(--border)]"
                    title={t('ai.model.codexHint')}
                  >
                    {t('ai.model.codex')}
                  </div>
                ) : (
                  <Segmented
                    ariaLabel={t('ai.model')}
                    value={model}
                    onChange={setModel}
                    items={[
                      { value: 'sonnet', label: t('ai.model.sonnet'), title: t('ai.model.sonnetHint') },
                      { value: 'opus', label: t('ai.model.opus'), title: t('ai.model.opusHint') },
                    ]}
                  />
                )}
                <Button
                  size="sm"
                  onClick={() => prompt.trim() && run.mutate({ p: prompt.trim(), model })}
                  disabled={!prompt.trim() || run.isPending}
                >
                  <Send className="h-4 w-4" />
                  {t('ai.runBtn')}
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {playbooks.map((pb) => (
                  <button
                    key={pb.id}
                    onClick={() =>
                      run.mutate({ p: t(pb.promptKey), model: COMPLEX_PLAYBOOKS.has(pb.id) ? 'opus' : model })
                    }
                    disabled={run.isPending}
                    className="hoverlift inline-flex min-h-10 items-center gap-1 rounded-[var(--radius)] border border-border bg-surface px-2 text-xs text-muted hover:border-accent/60 hover:text-text disabled:opacity-50"
                  >
                    <Wand2 className="h-3 w-3 text-accent" />
                    {t(pb.titleKey)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-[var(--radius)] border border-alarm bg-alarm/10 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-alarm">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
        {/* runs list */}
        <div className="space-y-1">
          <h2 className="t-section">{t('ai.runs')}</h2>
          {runs.data && runs.data.length === 0 && <p className="text-xs text-muted">{t('ai.noRuns')}</p>}
          {(runs.data ?? []).map((r) => (
            <div
              key={r.id}
              className={cn(
                'group flex min-h-10 items-center gap-1 rounded-[var(--radius)] border px-2 py-1.5 text-xs',
                selected === r.id ? 'border-accent bg-accent/10' : 'border-border bg-surface hover:bg-surface-2',
              )}
            >
              <button onClick={() => setSelected(r.id)} className="tap min-w-0 flex-1 text-left">
                <div className="truncate text-text">{r.prompt}</div>
                <div className="flex items-center gap-1 t-hint">
                  {r.status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
                  {t(STATUS_KEY[r.status] ?? 'ai.proposed')}
                  {r.pendingChanges > 0 && <span className="nums text-accent">· {r.pendingChanges}</span>}
                </div>
              </button>
              <button
                onClick={() => archive.mutate(r.id)}
                title={t('ai.archive')}
                className="tap inline-flex shrink-0 items-center justify-center rounded-[var(--radius)] p-1.5 text-muted opacity-0 hover:bg-surface-2 hover:text-alarm group-hover:opacity-100"
                aria-label={t('common.archive')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>

        {/* selected proposal */}
        <div ref={proposalRef} onMouseUp={onProposalMouseUp} className="space-y-2">
          {d && (
            <div className="flex items-center justify-between">
              <span className="t-hint">{t(STATUS_KEY[d.run.status] ?? 'ai.proposed')}</span>
              <button onClick={() => setShowLog((v) => !v)} className="t-hint hover:text-text">
                {t('ai.log')}
              </button>
            </div>
          )}
          {d && showLog && (
            <div className="space-y-2 rounded-[var(--radius)] border border-border bg-surface-2/40 p-2.5 text-xs text-muted">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{d.run.model ?? '—'}</span>
                {rawMeta?.inTok != null && (
                  <span className="nums">
                    ↓{rawMeta.inTok} ↑{rawMeta.outTok}
                  </span>
                )}
                {rawMeta?.cost != null && <span className="nums">${rawMeta.cost.toFixed(4)}</span>}
                {rawMeta?.ms != null && <span className="nums">{(rawMeta.ms / 1000).toFixed(1)}s</span>}
                <button onClick={copyLog} className="ml-auto text-accent hover:underline">
                  {copied ? t('ai.copied') : t('ai.copyJson')}
                </button>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted">
                {d.run.prompt}
              </pre>
              {d.run.rawOutput && (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted">
                  {d.run.rawOutput}
                </pre>
              )}
            </div>
          )}
          {!d ? (
            <p className="text-sm text-muted">{t('ai.proposal')}</p>
          ) : d.run.status === 'running' ? (
            <div className="flex items-center gap-3 rounded-[var(--radius)] border border-border bg-surface p-4 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
              <span className="flex-1">{t('ai.running')}</span>
              <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                <Square className="h-3.5 w-3.5" />
                {t('ai.cancel')}
              </Button>
            </div>
          ) : d.run.status === 'error' ? (
            <div className="space-y-1 rounded-[var(--radius)] border border-alarm bg-alarm/10 p-4">
              <p className="t-section text-alarm">{t('ai.errorTitle')}</p>
              <pre className="whitespace-pre-wrap font-mono text-xs text-alarm">{d.run.summary}</pre>
            </div>
          ) : (
            <div className="space-y-3 rounded-[var(--radius)] border border-border bg-surface p-4">
              {/* conversation thread */}
              {d.messages.length > 0 && (
                <div className="space-y-2">
                  {d.messages.map((m) => (
                    <div
                      key={m.id}
                      className={cn(
                        'rounded-[var(--radius)] px-2.5 py-1.5 text-sm whitespace-pre-wrap',
                        m.role === 'user' ? 'bg-surface-2 text-text' : 'border border-border bg-bg text-text',
                      )}
                    >
                      <div className="mb-0.5 t-hint">{m.role === 'user' ? t('ai.you') : 'MarCat'}</div>
                      {m.content}
                    </div>
                  ))}
                </div>
              )}
              {changes.length === 0 ? (
                <p className="text-sm text-muted">{t('ai.emptyProposal')}</p>
              ) : (
                <>
                  {isProposed && <p className="text-xs text-muted">{t('ai.selectHint')}</p>}
                  <div className="overflow-hidden rounded-[var(--radius)] border border-border">
                    {/* milestones / events: simple rows */}
                    {otherChanges.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-sm last:border-b-0"
                      >
                        <span className="t-hint text-accent">{c.entity}</span>
                        <span className="flex-1 truncate">
                          {asStr(c.after.title) ||
                            asStr(c.after.name) ||
                            asStr(c.after.folder) ||
                            (c.entity === 'insight' && asStr(c.after.body)
                              ? `${t('insights.existing')}: ${asStr(c.after.body)}`
                              : asStr(c.after.entityId))}
                        </span>
                        {(asStr(c.after.date) || asStr(c.after.targetDate) || asStr(c.after.startDate)) && (
                          <span className="text-xs text-muted">
                            {asStr(c.after.date) || asStr(c.after.targetDate) || asStr(c.after.startDate)}
                          </span>
                        )}
                      </div>
                    ))}
                    {/* tasks: rich rows, dependencies folded in, click to edit */}
                    {taskChanges.map((c) => {
                      const a = c.after
                      const prio = (
                        ['low', 'med', 'high', 'urgent'].includes(asStr(a.priority)) ? asStr(a.priority) : 'med'
                      ) as TaskPriority
                      const tagList = [...asList(a.tags), ...(asStr(a.tag) ? [asStr(a.tag)] : [])]
                      const checklistN = asList(a.checklist).length
                      const blockers = blockersOf.get(asStr(a.title).toLowerCase()) ?? []
                      const meta = [
                        asStr(a.dueDate) ? `${t('task.due')} ${asStr(a.dueDate)}` : '',
                        checklistN ? t('ai.checklistCount', { n: checklistN }) : '',
                        ...tagList.map((tg) => `#${tg}`),
                      ].filter(Boolean)
                      const isEditing = editing === c.id
                      return (
                        <div
                          key={c.id}
                          className="border-b border-border last:border-b-0"
                          style={{ borderLeft: `3px solid ${PRIO_BORDER[prio]}` }}
                        >
                          <div
                            className="cursor-pointer px-2.5 py-1.5 text-sm hover:bg-surface-2"
                            onClick={() => {
                              if (!isProposed) return
                              if (window.getSelection()?.toString()) return // don't toggle while selecting text
                              if (isEditing) {
                                setEditing(null)
                                setDraft(null)
                              } else {
                                openEditor(c)
                              }
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <span className="t-hint text-accent">{c.entity}</span>
                              <span className="flex-1 truncate">{asStr(a.title)}</span>
                              {c.status !== 'pending' && <span className="t-hint">{c.status}</span>}
                            </div>
                            {meta.length > 0 && (
                              <div className="mt-0.5 pl-1 text-xs text-muted">{meta.join(' · ')}</div>
                            )}
                            {blockers.length > 0 && (
                              <div className="mt-0.5 pl-1 text-xs text-warning">
                                {t('ai.afterTasks', { list: blockers.join(', ') })}
                              </div>
                            )}
                          </div>

                          {isEditing && draft && (
                            <div
                              className="space-y-2 border-t border-border bg-surface-2/40 p-2.5"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                value={draft.title}
                                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                                className={cn(fieldCls, 'font-medium')}
                              />
                              <div className="grid grid-cols-2 gap-2">
                                <select
                                  value={draft.priority}
                                  onChange={(e) => setDraft({ ...draft, priority: e.target.value as TaskPriority })}
                                  className={fieldCls}
                                >
                                  {PRIORITY_ORDER.map((p) => (
                                    <option key={p} value={p}>
                                      {t(`prio.${p}`)}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  type="date"
                                  value={draft.dueDate}
                                  onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                                  className={fieldCls}
                                />
                              </div>
                              <textarea
                                value={draft.description}
                                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                                placeholder={t('task.description')}
                                rows={3}
                                className={cn(fieldCls, 'resize-y')}
                              />
                              {/* checklist */}
                              <div className="space-y-1">
                                {draft.checklist.map((item, i) => (
                                  <div key={i} className="flex items-center gap-2">
                                    <input
                                      value={item}
                                      onChange={(e) => {
                                        const cl = [...draft.checklist]
                                        cl[i] = e.target.value
                                        setDraft({ ...draft, checklist: cl })
                                      }}
                                      className={cn(fieldCls, 'text-xs')}
                                    />
                                    <button
                                      onClick={() =>
                                        setDraft({ ...draft, checklist: draft.checklist.filter((_, j) => j !== i) })
                                      }
                                      className="tap inline-flex items-center justify-center rounded-[var(--radius)] p-1.5 text-muted hover:bg-surface-2 hover:text-alarm"
                                      aria-label={t('common.remove')}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                ))}
                                <button
                                  onClick={() => setDraft({ ...draft, checklist: [...draft.checklist, ''] })}
                                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-text"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  {t('task.addItem')}
                                </button>
                              </div>
                              {/* tags */}
                              <div className="flex flex-wrap items-center gap-1.5">
                                {draft.tags.map((tg, i) => (
                                  <span
                                    key={i}
                                    className="inline-flex items-center gap-1 rounded-[var(--radius)] bg-accent/15 px-1.5 py-0.5 text-xs text-accent"
                                  >
                                    {tg}
                                    <button
                                      onClick={() => setDraft({ ...draft, tags: draft.tags.filter((_, j) => j !== i) })}
                                      aria-label={t('common.remove')}
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </span>
                                ))}
                                <input
                                  placeholder={t('task.addTag')}
                                  onKeyDown={(e) => {
                                    const v = (e.target as HTMLInputElement).value.trim()
                                    if (e.key === 'Enter' && v) {
                                      setDraft({ ...draft, tags: [...draft.tags, v] })
                                      ;(e.target as HTMLInputElement).value = ''
                                    }
                                  }}
                                  className={cn(fieldCls, 'w-28 text-xs')}
                                />
                              </div>
                              <div className="flex gap-2">
                                <Button size="sm" onClick={() => saveEdit(c)} disabled={updateChange.isPending}>
                                  <Check className="h-4 w-4" />
                                  {t('ai.save')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setEditing(null)
                                    setDraft(null)
                                  }}
                                >
                                  {t('common.cancel')}
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {isProposed && changes.length > 0 && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
                    <Check className="h-4 w-4" />
                    {t('ai.approve')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => reject.mutate()} disabled={reject.isPending}>
                    <X className="h-4 w-4" />
                    {t('ai.reject')}
                  </Button>
                </div>
              )}

              {/* chat reply (same conversation — resumes the session, never a new request) */}
              <div className="space-y-2 border-t border-border pt-3">
                <h3 className="t-section">{t('ai.replyTitle')}</h3>
                {comments.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-start gap-2 rounded-[var(--radius)] border border-border bg-surface-2/40 px-2 py-1.5 text-xs"
                  >
                    <div className="flex-1">
                      <div className="truncate text-muted italic">“{c.quote}”</div>
                      <div className="text-text">{c.text}</div>
                    </div>
                    <button
                      onClick={() => setComments((cs) => cs.filter((x) => x.id !== c.id))}
                      className="tap inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-alarm"
                      aria-label={t('common.remove')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t('ai.replyPlaceholder')}
                  rows={2}
                  className={cn(fieldCls, 'resize-y')}
                />
                <Button size="sm" onClick={sendReply} disabled={reply.isPending || (!comments.length && !note.trim())}>
                  <Send className="h-4 w-4" />
                  {t('ai.reply')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* floating comment popover for the current selection */}
      {popover && isProposed && (
        <div
          className="fixed z-50 flex items-center gap-1 rounded-[var(--radius)] border border-border bg-surface p-1 shadow-hard"
          style={{ top: popover.top, left: popover.left }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addComment()
              if (e.key === 'Escape') setPopover(null)
            }}
            placeholder={t('ai.commentPlaceholder')}
            className={cn(fieldCls, 'h-7 w-56 text-xs')}
          />
          <Button size="icon" onClick={addComment} disabled={!commentText.trim()}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
