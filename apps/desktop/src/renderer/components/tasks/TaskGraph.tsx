import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowRight, Trash2, Wand2 } from 'lucide-react'
import type { TaskDependency } from '@marcat/db'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n/useT'
import { STATUS_META, type TaskWithTags } from './meta'
import { computeTaskGraphLayout } from './taskGraphLayout'
import { TaskCardBody } from './TaskCard'
import { CARD_STATE_STYLES } from '@/components/ui/CardState'

type TaskNodeData = {
  task: TaskWithTags
  openBlockers: number
}
type TaskFlowNode = Node<TaskNodeData, 'task'>

function TaskNode({ data, selected }: NodeProps<TaskFlowNode>) {
  const t = useT()
  const { task, openBlockers } = data
  const finished = task.status === 'done' || task.status === 'cancelled'

  return (
    <div
      className={cn(
        'relative w-[300px] rounded-[10px] border-l-[4px] bg-surface p-3 text-left transition-[box-shadow,opacity] duration-150 ease-out',
        CARD_STATE_STYLES[STATUS_META[task.status].tone].spine,
        finished && 'opacity-55',
      )}
      style={{
        boxShadow: selected ? '0 0 0 2px var(--color-accent), var(--shadow-hard-lift)' : 'var(--shadow-hard)',
      }}
      title={task.title}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3.5 !w-3.5 !border-2 !border-surface !bg-border-strong transition-[background-color,scale] duration-150 hover:!scale-125 hover:!bg-accent"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-3.5 !w-3.5 !border-2 !border-surface !bg-border-strong transition-[background-color,scale] duration-150 hover:!scale-125 hover:!bg-accent"
      />

      {openBlockers > 0 && (
        <div className="nums mb-2 text-right t-hint text-alarm">
          {t('tasks.graphOpenBlockers', { n: openBlockers })}
        </div>
      )}
      <TaskCardBody task={task} showOpen={false} />
    </div>
  )
}

const nodeTypes = { task: TaskNode }

export function TaskGraph({
  tasks,
  deps,
  onSelect,
  onConnect,
  onRemoveEdge,
}: {
  tasks: TaskWithTags[]
  deps: TaskDependency[]
  onSelect: (id: string) => void
  onConnect: (blockerId: string, blockedId: string) => void
  onRemoveEdge: (id: string) => void
}) {
  const t = useT()
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const depsRef = useRef(deps)
  depsRef.current = deps
  const flowRef = useRef<ReactFlowInstance<TaskFlowNode, Edge> | null>(null)
  const lastLayoutSig = useRef<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  const visibleIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks])
  const visibleDeps = useMemo(
    () => deps.filter((dep) => visibleIds.has(dep.blockerTaskId) && visibleIds.has(dep.blockedTaskId)),
    [deps, visibleIds],
  )
  const layout = useMemo(() => computeTaskGraphLayout(tasks, visibleDeps), [tasks, visibleDeps])
  const layoutSig = useMemo(
    () =>
      tasks
        .map((task) => task.id)
        .sort()
        .join(',') +
      '#' +
      visibleDeps
        .map((dep) => `${dep.blockerTaskId}>${dep.blockedTaskId}`)
        .sort()
        .join(','),
    [tasks, visibleDeps],
  )
  const styleSig = useMemo(
    () => tasks.map((task) => `${task.id}:${task.status}:${task.priority}:${task.title}:${task.dueDate}`).join('|'),
    [tasks],
  )
  const openBlockers = useMemo(() => {
    const statusById = new Map(tasks.map((task) => [task.id, task.status]))
    const counts = new Map<string, number>()
    for (const dep of visibleDeps) {
      const status = statusById.get(dep.blockerTaskId)
      if (status !== 'done' && status !== 'cancelled') {
        counts.set(dep.blockedTaskId, (counts.get(dep.blockedTaskId) ?? 0) + 1)
      }
    }
    return counts
  }, [tasks, visibleDeps])

  const [nodes, setNodes, onNodesChange] = useNodesState<TaskFlowNode>([])

  useEffect(() => {
    const structuralChange = lastLayoutSig.current !== layoutSig
    lastLayoutSig.current = layoutSig
    const positions = layout.positions
    setNodes((previous) => {
      const previousPositions = new Map(previous.map((node) => [node.id, node.position]))
      return tasksRef.current.map((task) => ({
        id: task.id,
        type: 'task',
        position: (structuralChange
          ? positions.get(task.id)
          : (previousPositions.get(task.id) ?? positions.get(task.id))) ?? { x: 0, y: 0 },
        data: { task, openBlockers: openBlockers.get(task.id) ?? 0 },
        ariaLabel: task.taskKey ? `${task.taskKey}: ${task.title}` : task.title,
      }))
    })

    if (structuralChange) {
      requestAnimationFrame(() => {
        void flowRef.current?.fitView({ padding: 0.16, maxZoom: 1, duration: 220 })
      })
    }
  }, [layout, layoutSig, openBlockers, setNodes, styleSig])

  useEffect(() => {
    if (selectedEdgeId && !visibleDeps.some((dep) => dep.id === selectedEdgeId)) setSelectedEdgeId(null)
  }, [selectedEdgeId, visibleDeps])

  const tidy = () => {
    const fresh = computeTaskGraphLayout(tasksRef.current, depsRef.current)
    setNodes((current) => current.map((node) => ({ ...node, position: fresh.positions.get(node.id) ?? node.position })))
    requestAnimationFrame(() => {
      void flowRef.current?.fitView({ padding: 0.16, maxZoom: 1, duration: 220 })
    })
  }

  const edges: Edge[] = visibleDeps.map((dep) => {
    const selected = dep.id === selectedEdgeId
    return {
      id: dep.id,
      source: dep.blockerTaskId,
      target: dep.blockedTaskId,
      type: 'smoothstep',
      selected,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 17,
        height: 17,
        color: selected ? 'var(--color-accent)' : 'var(--color-muted)',
      },
      style: {
        stroke: selected ? 'var(--color-accent)' : 'var(--color-muted)',
        strokeWidth: selected ? 2.5 : 1.5,
      },
    }
  })
  const selectedDep = visibleDeps.find((dep) => dep.id === selectedEdgeId) ?? null
  const titleById = new Map(tasks.map((task) => [task.id, task.title]))

  if (!tasks.length) {
    return (
      <div className="flex min-h-80 items-center justify-center rounded-[12px] bg-surface px-6 text-center shadow-hard">
        <div>
          <div className="font-mono text-2xl text-accent">=^•ω•^=</div>
          <p className="mt-2 t-body">{t('tasks.graphFilteredEmpty')}</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className="task-graph h-[70vh] min-h-[480px] overflow-hidden rounded-[12px] bg-surface shadow-hard"
      role="region"
      aria-label={t('tasks.viewGraph')}
    >
      <ReactFlow<TaskFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={(instance) => {
          flowRef.current = instance
        }}
        onNodesChange={onNodesChange}
        minZoom={0.42}
        maxZoom={1.5}
        nodesDraggable
        nodesConnectable
        deleteKeyCode={['Backspace', 'Delete']}
        onConnect={(connection) =>
          connection.source && connection.target && onConnect(connection.source, connection.target)
        }
        onEdgesDelete={(deleted) => {
          setSelectedEdgeId(null)
          deleted.forEach((edge) => onRemoveEdge(edge.id))
        }}
        onEdgeClick={(event, edge) => {
          event.stopPropagation()
          setSelectedEdgeId(edge.id)
        }}
        onPaneClick={() => setSelectedEdgeId(null)}
        onNodeClick={(_, node) => onSelect(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--color-border)" gap={24} size={1} />
        <Controls showInteractive={false} />

        <Panel position="top-left" className="m-3 max-w-sm rounded-[10px] bg-surface px-3 py-2 shadow-hard">
          <div className="nums t-hint text-text">
            {t('tasks.graphStats', {
              chains: layout.chainCount,
              links: visibleDeps.length,
              loose: layout.looseCount,
            })}
          </div>
          {visibleDeps.length === 0 && <p className="mt-1 t-hint">{t('tasks.graphNoLinks')}</p>}
        </Panel>

        <Panel position="top-right" className="m-3">
          <button
            type="button"
            onClick={tidy}
            className="tap inline-flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] bg-surface py-1 pl-3 pr-3.5 t-hint text-text shadow-hard hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Wand2 className="h-3.5 w-3.5" aria-hidden />
            {t('tasks.graphTidy')}
          </button>
        </Panel>

        {selectedDep && (
          <Panel position="bottom-center" className="m-4 max-w-[min(720px,calc(100vw-3rem))]">
            <div className="flex items-center gap-2 rounded-[10px] bg-surface p-2 pl-3 shadow-hard">
              <span className="min-w-0 flex-1 break-words t-body [overflow-wrap:anywhere]">
                {titleById.get(selectedDep.blockerTaskId) ?? '—'}
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-accent" aria-hidden />
              <span className="min-w-0 flex-1 break-words t-body [overflow-wrap:anywhere]">
                {titleById.get(selectedDep.blockedTaskId) ?? '—'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelectedEdgeId(null)
                  onRemoveEdge(selectedDep.id)
                }}
                className="tap ml-2 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-alarm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-alarm/60"
                aria-label={t('tasks.graphDeleteLink')}
                title={t('tasks.graphDeleteLink')}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  )
}
