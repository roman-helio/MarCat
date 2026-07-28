import { useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Calendar as RBC, dateFnsLocalizer, type View } from 'react-big-calendar'
import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css'
import { format, getDay, parse, startOfWeek } from 'date-fns'
import { enUS, ru } from 'date-fns/locale'
import { trpc } from '@/lib/trpc'
import { useSettings } from '@/store/settings'
import { useT } from '@/i18n/useT'
import type { TaskPriority, TaskStatus, TaskWithTags } from './meta'

const mondayEn = { ...enUS, options: { ...enUS.options, weekStartsOn: 1 as const } }
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales: { 'en-US': mondayEn, ru } })
const DnDCalendar = withDragAndDrop(RBC as any) as any

interface CalendarEvent {
  title: string
  start: Date
  end: Date
  allDay: boolean
  resource: {
    type: 'task' | 'deadline'
    id?: string
    status?: TaskStatus
    priority?: TaskPriority
  }
}

const statusColor: Record<TaskStatus, string> = {
  todo: 'var(--muted)',
  doing: 'var(--color-info)',
  blocked: 'var(--color-alarm)',
  done: 'var(--color-success)',
  cancelled: 'var(--muted)',
}

const priorityColor: Record<TaskPriority, string> = {
  urgent: 'var(--color-alarm)',
  high: '#f97316',
  med: 'var(--color-warning)',
  low: 'var(--color-info)',
}

function toIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function TaskCalendarView({
  tasks,
  tags,
  onSelect,
  onChanged,
}: {
  tasks: TaskWithTags[]
  tags: Array<{ id: string; name: string; targetDate?: string | null }>
  onSelect: (id: string) => void
  onChanged: () => void
}) {
  const t = useT()
  const lang = useSettings((state) => state.lang)
  const culture = lang === 'ru' ? 'ru' : 'en-US'
  const visibleTagIds = useMemo(() => new Set(tasks.flatMap((task) => task.tags.map((tag) => tag.id))), [tasks])
  const reschedule = useMutation({
    mutationFn: (value: { id: string; dueDate: string }) =>
      trpc.tasks.update.mutate({ id: value.id, patch: { dueDate: value.dueDate } }),
    onSuccess: onChanged,
  })
  const events = useMemo<CalendarEvent[]>(() => {
    const taskEvents = tasks.flatMap((task) => {
      if (!task.dueDate) return []
      const date = new Date(`${task.dueDate}T00:00:00`)
      return [
        {
          title: `${task.taskKey ? `${task.taskKey} · ` : ''}${task.title}`,
          start: date,
          end: date,
          allDay: true,
          resource: { type: 'task' as const, id: task.id, status: task.status, priority: task.priority },
        },
      ]
    })
    const deadlines = tags.flatMap((tag) => {
      if (!tag.targetDate || !visibleTagIds.has(tag.id)) return []
      const date = new Date(`${tag.targetDate}T00:00:00`)
      return [
        {
          title: `★ ${tag.name}`,
          start: date,
          end: date,
          allDay: true,
          resource: { type: 'deadline' as const },
        },
      ]
    })
    return [...taskEvents, ...deadlines]
  }, [tags, tasks, visibleTagIds])
  const messages = useMemo(
    () => ({
      today: t('cal.today'),
      previous: t('cal.back'),
      next: t('cal.next'),
      month: t('cal.month'),
      agenda: t('cal.agenda'),
      noEventsInRange: t('cal.none'),
      showMore: (count: number) => t('cal.more', { n: count }),
    }),
    [t],
  )

  return (
    <div className="rbc-marcat rounded-[12px] bg-surface p-2 shadow-hard">
      <DnDCalendar
        localizer={localizer}
        culture={culture}
        messages={messages}
        events={events}
        startAccessor="start"
        endAccessor="end"
        views={['month', 'agenda'] as View[]}
        popup
        style={{ height: 'calc(100vh - 230px)', minHeight: 520 }}
        dayPropGetter={(date: Date) => {
          const weekday = date.getDay()
          return weekday === 0 || weekday === 6 ? { className: 'rbc-weekend' } : {}
        }}
        draggableAccessor={(event: CalendarEvent) => event.resource.type === 'task'}
        resizable={false}
        onEventDrop={({ event, start }: { event: CalendarEvent; start: Date }) => {
          if (event.resource.type === 'task' && event.resource.id) {
            reschedule.mutate({ id: event.resource.id, dueDate: toIso(start) })
          }
        }}
        eventPropGetter={(event: CalendarEvent) => ({
          style: {
            background:
              event.resource.type === 'deadline'
                ? 'var(--color-warning)'
                : statusColor[event.resource.status ?? 'todo'],
            border: 'none',
            borderLeft: `4px solid ${priorityColor[event.resource.priority ?? 'med']}`,
            color: '#fff',
            fontSize: 12,
          },
        })}
        onSelectEvent={(event: CalendarEvent) => {
          if (event.resource.type === 'task' && event.resource.id) onSelect(event.resource.id)
        }}
      />
    </div>
  )
}
