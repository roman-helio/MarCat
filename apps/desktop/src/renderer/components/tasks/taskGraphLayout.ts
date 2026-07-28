import type { TaskDependency } from '@marcat/db'
import type { TaskWithTags } from './meta'

const NODE_W = 300
const COL_GAP = 88
const ROW_GAP = 34
const COMPONENT_GAP = 88
const PACK_W = 1_400

type Point = { x: number; y: number }

/** Conservative visual height estimate for the shared, fully-wrapped task card. */
function nodeHeight(task: TaskWithTags): number {
  const titleLines = Math.max(1, Math.ceil((task.title?.length ?? 0) / 34))
  const tagChars = (task.tags ?? []).reduce((sum, tag) => sum + tag.name.length + 3, 0)
  const tagLines = tagChars > 0 ? Math.max(1, Math.ceil(tagChars / 32)) : 0
  return 58 + titleLines * 21 + (task.dueDate ? 20 : 0) + tagLines * 24 + (task.status === 'blocked' ? 20 : 0)
}

export type TaskGraphLayout = {
  positions: Map<string, Point>
  chainCount: number
  looseCount: number
}

/**
 * Layout each weakly-connected component independently, then pack the components
 * into rows. Tasks without links live in a compact grid after the real chains.
 * This keeps dependency direction readable without pretending unrelated work is
 * one long process.
 */
export function computeTaskGraphLayout(tasks: TaskWithTags[], deps: TaskDependency[]): TaskGraphLayout {
  const ids = tasks.map((task) => task.id)
  const idSet = new Set(ids)
  const taskOrder = new Map(ids.map((id, index) => [id, index]))
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const validDeps = deps.filter((dep) => idSet.has(dep.blockerTaskId) && idSet.has(dep.blockedTaskId))

  const neighbours = new Map<string, string[]>()
  const blockers = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  for (const dep of validDeps) {
    neighbours.set(dep.blockerTaskId, [...(neighbours.get(dep.blockerTaskId) ?? []), dep.blockedTaskId])
    neighbours.set(dep.blockedTaskId, [...(neighbours.get(dep.blockedTaskId) ?? []), dep.blockerTaskId])
    blockers.set(dep.blockedTaskId, [...(blockers.get(dep.blockedTaskId) ?? []), dep.blockerTaskId])
    children.set(dep.blockerTaskId, [...(children.get(dep.blockerTaskId) ?? []), dep.blockedTaskId])
  }

  const seen = new Set<string>()
  const components: string[][] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const component: string[] = []
    const stack = [id]
    while (stack.length) {
      const current = stack.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      component.push(current)
      for (const next of neighbours.get(current) ?? []) stack.push(next)
    }
    component.sort((a, b) => (taskOrder.get(a) ?? 0) - (taskOrder.get(b) ?? 0))
    components.push(component)
  }

  const chains = components.filter((component) => component.length > 1)
  const loose = components.filter((component) => component.length === 1).flat()
  const positions = new Map<string, Point>()

  type ComponentLayout = { points: Map<string, Point>; width: number; height: number }
  const layoutComponent = (component: string[]): ComponentLayout => {
    const componentSet = new Set(component)
    const indegree = new Map(component.map((id) => [id, 0]))
    const depth = new Map(component.map((id) => [id, 0]))
    for (const dep of validDeps) {
      if (componentSet.has(dep.blockerTaskId) && componentSet.has(dep.blockedTaskId)) {
        indegree.set(dep.blockedTaskId, (indegree.get(dep.blockedTaskId) ?? 0) + 1)
      }
    }

    const queue = component.filter((id) => indegree.get(id) === 0)
    let cursor = 0
    while (cursor < queue.length) {
      const id = queue[cursor++]!
      for (const child of children.get(id) ?? []) {
        if (!componentSet.has(child)) continue
        depth.set(child, Math.max(depth.get(child) ?? 0, (depth.get(id) ?? 0) + 1))
        const left = (indegree.get(child) ?? 0) - 1
        indegree.set(child, left)
        if (left === 0) queue.push(child)
      }
    }

    const layers = new Map<number, string[]>()
    for (const id of component) {
      const layer = depth.get(id) ?? 0
      layers.set(layer, [...(layers.get(layer) ?? []), id])
    }
    const maxLayer = Math.max(0, ...layers.keys())
    const orderIndex = new Map<string, number>()
    const reindex = () => {
      for (const layer of layers.values()) layer.forEach((id, index) => orderIndex.set(id, index))
    }
    const barycenter = (id: string, related: Map<string, string[]>) => {
      const relevant = (related.get(id) ?? []).filter((candidate) => componentSet.has(candidate))
      if (!relevant.length) return orderIndex.get(id) ?? 0
      return relevant.reduce((sum, candidate) => sum + (orderIndex.get(candidate) ?? 0), 0) / relevant.length
    }

    reindex()
    for (let pass = 0; pass < 4; pass++) {
      for (let layer = 1; layer <= maxLayer; layer++) {
        layers.get(layer)?.sort((a, b) => barycenter(a, blockers) - barycenter(b, blockers))
        reindex()
      }
      for (let layer = maxLayer - 1; layer >= 0; layer--) {
        layers.get(layer)?.sort((a, b) => barycenter(a, children) - barycenter(b, children))
        reindex()
      }
    }

    const layerHeights = new Map<number, number>()
    for (const [layer, layerIds] of layers) {
      layerHeights.set(
        layer,
        layerIds.reduce((sum, id) => sum + nodeHeight(taskById.get(id)!), 0) +
          Math.max(0, layerIds.length - 1) * ROW_GAP,
      )
    }
    const maxHeight = Math.max(1, ...layerHeights.values())
    const points = new Map<string, Point>()
    for (const [layer, layerIds] of layers) {
      let y = (maxHeight - (layerHeights.get(layer) ?? 0)) / 2
      layerIds.forEach((id) => {
        points.set(id, {
          x: layer * (NODE_W + COL_GAP),
          y,
        })
        y += nodeHeight(taskById.get(id)!) + ROW_GAP
      })
    }
    return {
      points,
      width: (maxLayer + 1) * NODE_W + maxLayer * COL_GAP,
      height: maxHeight,
    }
  }

  let packX = 0
  let packY = 0
  let rowHeight = 0
  let contentBottom = 0
  for (const component of chains) {
    const layout = layoutComponent(component)
    if (packX > 0 && packX + layout.width > PACK_W) {
      packX = 0
      packY += rowHeight + COMPONENT_GAP
      rowHeight = 0
    }
    for (const [id, point] of layout.points) {
      positions.set(id, { x: point.x + packX, y: point.y + packY })
    }
    packX += layout.width + COMPONENT_GAP
    rowHeight = Math.max(rowHeight, layout.height)
    contentBottom = Math.max(contentBottom, packY + layout.height)
  }

  if (loose.length) {
    const columns = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(loose.length))))
    const looseY = chains.length ? contentBottom + COMPONENT_GAP : 0
    const rowHeights: number[] = []
    loose.forEach((id, index) => {
      const row = Math.floor(index / columns)
      rowHeights[row] = Math.max(rowHeights[row] ?? 0, nodeHeight(taskById.get(id)!))
    })
    const rowOffsets = rowHeights.map((_, row) =>
      rowHeights.slice(0, row).reduce((sum, height) => sum + height + ROW_GAP, looseY),
    )
    loose.forEach((id, index) => {
      positions.set(id, {
        x: (index % columns) * (NODE_W + ROW_GAP),
        y: rowOffsets[Math.floor(index / columns)] ?? looseY,
      })
    })
  }

  return { positions, chainCount: chains.length, looseCount: loose.length }
}
