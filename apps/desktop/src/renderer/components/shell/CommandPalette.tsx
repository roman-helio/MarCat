import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { useSettings, matchesCombo } from '@/store/settings'
import { useT } from '@/i18n/useT'

interface Cmd {
  id: string
  label: string
  group: string
  run: () => void
}

/** Quick navigation + actions, opened with Ctrl/⌘+K. */
export function CommandPalette() {
  const t = useT()
  const navigate = useNavigate()
  const gameId = useUi((s) => s.currentGameId)
  const setCommandOpen = useUi((s) => s.setCommandOpen)
  const paletteHotkey = useSettings((s) => s.paletteHotkey)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesCombo(e, paletteHotkey)) {
        e.preventDefault()
        setQ('')
        setIdx(0)
        setOpen((o) => !o)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteHotkey])
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  const cmds = useMemo(() => {
    const go = (path: string) => () => {
      navigate(path)
      setOpen(false)
    }
    const list: Cmd[] = [
      { id: 'all', group: t('cmd.go'), label: t('nav.allGames'), run: go('/') },
      { id: 'fest', group: t('cmd.go'), label: t('fest.global'), run: go('/festivals') },
      { id: 'settings', group: t('cmd.go'), label: t('nav.settings'), run: go('/settings') },
    ]
    if (gameId) {
      const g = (p: string) => `/g/${gameId}${p}`
      list.push(
        { id: 'home', group: t('cmd.game'), label: t('nav.home'), run: go(g('')) },
        { id: 'tasks', group: t('cmd.game'), label: t('nav.tasks'), run: go(g('/tasks')) },
        { id: 'cal', group: t('cmd.game'), label: t('nav.calendar'), run: go(g('/calendar')) },
        { id: 'events', group: t('cmd.game'), label: t('nav.events'), run: go(g('/events')) },
        { id: 'insights', group: t('cmd.game'), label: t('nav.insights'), run: go(g('/insights')) },
        { id: 'comments', group: t('cmd.game'), label: t('nav.comments'), run: go(g('/comments')) },
        { id: 'gfest', group: t('cmd.game'), label: t('nav.festivals'), run: go(g('/festivals')) },
        { id: 'sources', group: t('cmd.game'), label: t('nav.sources'), run: go(g('/sources')) },
        { id: 'an', group: t('cmd.game'), label: t('nav.analytics'), run: go(g('/analytics')) },
        { id: 'marcat', group: t('cmd.game'), label: t('nav.aiDen'), run: go(g('/ai')) },
      )
    }
    list.push({
      id: 'ask',
      group: t('cmd.action'),
      label: t('comp.askTitle'),
      run: () => {
        setOpen(false)
        setCommandOpen(true)
      },
    })
    return list
  }, [gameId, navigate, setCommandOpen, t])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? cmds.filter((c) => c.label.toLowerCase().includes(needle)) : cmds
  }, [cmds, q])
  const active = Math.min(idx, Math.max(0, filtered.length - 1))

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="enter w-[min(560px,92vw)] overflow-hidden rounded-[var(--radius)] border border-border bg-surface shadow-hard"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setIdx(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(i + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              filtered[active]?.run()
            }
          }}
          placeholder={t('cmd.placeholder')}
          className="w-full border-b border-border bg-surface px-3 py-2.5 text-sm text-text outline-none"
        />
        <div className="enter-stagger max-h-80 overflow-auto py-1">
          {filtered.length === 0 && <p className="px-3 py-2 text-sm text-muted">{t('cmd.empty')}</p>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              onMouseEnter={() => setIdx(i)}
              onClick={() => c.run()}
              className={cn(
                'tap flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm',
                i === active ? 'bg-accent/10 text-text' : 'text-muted hover:bg-surface-2',
              )}
            >
              <span>{c.label}</span>
              <span className="t-hint">{c.group}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
