import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Calendar as RBC, dateFnsLocalizer, type View } from 'react-big-calendar'
import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css'
import { format, getDay, parse, startOfWeek } from 'date-fns'
import { enUS, ru } from 'date-fns/locale'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { useModal } from '@/lib/modal'
import { useUi } from '@/store/ui'
import { useSettings } from '@/store/settings'
import { Button } from '@/components/ui/Button'
import { PageHeader } from '@/components/ui/Screen'
import { TaskDrawer } from '@/components/tasks/TaskDrawer'
import { useT } from '@/i18n/useT'
import { LoadingState, QueryError } from '@/components/ui/QueryState'

// Force Monday as the first day of the week for both locales (ru is already Monday).
const mondayEn = { ...enUS, options: { ...enUS.options, weekStartsOn: 1 as const } }
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales: { 'en-US': mondayEn, ru } })
const DnDCalendar = withDragAndDrop(RBC as any) as any

interface Ev {
  title: string
  start: Date
  end: Date
  allDay: boolean
  resource: { type: 'task' | 'deadline'; id?: string }
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function Calendar() {
  const t = useT()
  const { gameId } = useParams<{ gameId: string }>()
  const setCurrentGame = useUi((s) => s.setCurrentGame)
  const lang = useSettings((s) => s.lang)
  const culture = lang === 'ru' ? 'ru' : 'en-US'
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  // Date of the slot the user clicked — opens a deferred "new task" composer.
  const [newOn, setNewOn] = useState<string | null>(null)

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
  }, [gameId, setCurrentGame])

  const tasks = useQuery({
    queryKey: ['tasks', gameId],
    queryFn: () => trpc.tasks.list.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const tags = useQuery({
    queryKey: ['tags', gameId],
    queryFn: () => trpc.tags.list.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const reschedule = useMutation({
    mutationFn: (v: { id: string; dueDate: string }) =>
      trpc.tasks.update.mutate({ id: v.id, patch: { dueDate: v.dueDate } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks', gameId] })
      qc.invalidateQueries({ queryKey: ['tags-status', gameId] })
    },
  })
  const createOnDay = useMutation({
    mutationFn: (v: { dueDate: string; title: string }) =>
      trpc.tasks.create.mutate({ gameId: gameId!, title: v.title, dueDate: v.dueDate }),
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: ['tasks', gameId] })
      setNewOn(null)
      if (task) setSelected(task.id) // open the full drawer to fill in details
    },
  })

  const events: Ev[] = useMemo(() => {
    const evs: Ev[] = []
    for (const task of tasks.data ?? []) {
      if (!task.dueDate) continue
      const d = new Date(task.dueDate + 'T00:00:00')
      evs.push({ title: task.title, start: d, end: d, allDay: true, resource: { type: 'task', id: task.id } })
    }
    for (const tg of tags.data ?? []) {
      if (!tg.targetDate) continue
      const d = new Date(tg.targetDate + 'T00:00:00')
      evs.push({ title: `★ ${tg.name}`, start: d, end: d, allDay: true, resource: { type: 'deadline' } })
    }
    return evs
  }, [tasks.data, tags.data])

  // Localized toolbar/labels for react-big-calendar.
  const messages = useMemo(
    () => ({
      today: t('cal.today'),
      previous: t('cal.back'),
      next: t('cal.next'),
      month: t('cal.month'),
      agenda: t('cal.agenda'),
      noEventsInRange: t('cal.none'),
      showMore: (n: number) => t('cal.more', { n }),
    }),
    [t],
  )

  if (!gameId) return null

  return (
    <div className="page-stack-compact">
      <PageHeader title={t('nav.calendar')} />
      {(tasks.isError || tags.isError) && (
        <QueryError
          error={tasks.error ?? tags.error}
          onRetry={() => {
            void tasks.refetch()
            void tags.refetch()
          }}
        />
      )}
      {(tasks.isLoading || tags.isLoading) && <LoadingState />}
      <div className="rbc-marcat rounded-[var(--radius)] border border-border bg-surface p-2">
        <DnDCalendar
          localizer={localizer}
          culture={culture}
          messages={messages}
          events={events}
          startAccessor="start"
          endAccessor="end"
          views={['month', 'agenda'] as View[]}
          popup
          selectable
          style={{ height: '70vh' }}
          onSelectSlot={(s: { start: Date }) => setNewOn(toIso(s.start))}
          dayPropGetter={(date: Date) => {
            const wd = date.getDay()
            return wd === 0 || wd === 6 ? { className: 'rbc-weekend' } : {}
          }}
          draggableAccessor={(event: Ev) => event.resource.type === 'task'}
          resizable={false}
          onEventDrop={({ event, start }: { event: Ev; start: Date }) => {
            if (event.resource.type === 'task' && event.resource.id) {
              reschedule.mutate({ id: event.resource.id, dueDate: toIso(start) })
            }
          }}
          eventPropGetter={(event: Ev) => ({
            style: {
              background: event.resource.type === 'deadline' ? 'var(--color-warning)' : 'var(--color-accent)',
              border: 'none',
              color: '#fff',
              fontSize: 12,
            },
          })}
          onSelectEvent={(event: Ev) => {
            if (event.resource.type === 'task' && event.resource.id) setSelected(event.resource.id)
          }}
        />
      </div>
      {newOn && (
        <NewTaskModal
          date={newOn}
          pending={createOnDay.isPending}
          onCreate={(title) => createOnDay.mutate({ dueDate: newOn, title })}
          onClose={() => setNewOn(null)}
        />
      )}
      {selected && <TaskDrawer taskId={selected} gameId={gameId} onClose={() => setSelected(null)} />}
    </div>
  )
}

/** Deferred task creation: clicking a day opens this; nothing is saved until you confirm. */
function NewTaskModal({
  date,
  pending,
  onCreate,
  onClose,
}: {
  date: string
  pending: boolean
  onCreate: (title: string) => void
  onClose: () => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  useModal(ref, onClose)
  const [title, setTitle] = useState('')
  const submit = () => {
    const v = title.trim()
    if (v) onCreate(v)
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className="w-full max-w-sm space-y-3 rounded-[var(--radius)] border border-border-strong bg-surface p-4 shadow-hard"
      >
        <h2 className="t-section">{t('cal.newTaskOn', { date })}</h2>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder={t('tasks.new')}
          className={cn(fieldCls)}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={!title.trim() || pending}>
            {t('common.create')}
          </Button>
        </div>
      </div>
    </div>
  )
}
