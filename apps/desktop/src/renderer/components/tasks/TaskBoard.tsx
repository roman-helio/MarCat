import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import { BOARD_COLUMNS, STATUS_META, type TaskStatus, type TaskWithTags } from './meta'
import { useT } from '@/i18n/useT'
import { TaskCard } from './TaskCard'

function Card({ task, onSelect }: { task: TaskWithTags; onSelect: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id })
  return (
    <TaskCard
      ref={setNodeRef}
      task={task}
      onOpen={onSelect}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      className={cn('cursor-grab active:cursor-grabbing', isDragging && 'opacity-50')}
      {...listeners}
      {...attributes}
    />
  )
}

function Column({
  status,
  tasks,
  onSelect,
}: {
  status: TaskStatus
  tasks: TaskWithTags[]
  onSelect: (id: string) => void
}) {
  const t = useT()
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <div className="flex w-60 min-w-56 flex-none flex-col 2xl:w-auto 2xl:min-w-0 2xl:flex-1">
      <div className="mb-1.5 flex items-center gap-2 px-1 t-hint">
        <span className={cn('h-2 w-2 rounded-full', STATUS_META[status].dot)} />
        <span className={cn('font-medium', STATUS_META[status].badge.split(' ').at(-1))}>{t(`status.${status}`)}</span>
        <span className="nums text-muted/60">{tasks.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-24 flex-1 flex-col gap-1.5 rounded-[10px] border border-dashed p-1.5 transition-[background-color,border-color] duration-150 ease-out',
          STATUS_META[status].column,
          STATUS_META[status].border,
          isOver && 'border-accent bg-accent/5',
        )}
      >
        {tasks.map((t) => (
          <Card key={t.id} task={t} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

export function TaskBoard({
  tasks,
  onSelect,
  onMove,
}: {
  tasks: TaskWithTags[]
  onSelect: (id: string) => void
  onMove: (id: string, status: TaskStatus) => void
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return
    const status = e.over.id as TaskStatus
    const task = tasks.find((t) => t.id === e.active.id)
    if (task && task.status !== status) onMove(task.id, status)
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max gap-2.5 2xl:min-w-0">
          {BOARD_COLUMNS.map((status) => (
            <Column key={status} status={status} tasks={tasks.filter((t) => t.status === status)} onSelect={onSelect} />
          ))}
        </div>
      </div>
    </DndContext>
  )
}
