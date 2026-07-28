const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildSync } = require('esbuild')

const source = path.join(
  __dirname,
  '..',
  'apps',
  'desktop',
  'src',
  'renderer',
  'components',
  'tasks',
  'taskGraphLayout.ts',
)
const output = path.join(os.tmpdir(), `marcat-task-graph-layout-${process.pid}.cjs`)

const tasks = (...ids) => ids.map((id) => ({ id }))
const dep = (id, blockerTaskId, blockedTaskId) => ({ id, blockerTaskId, blockedTaskId })

try {
  buildSync({
    entryPoints: [source],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: output,
    logLevel: 'silent',
  })
  const { computeTaskGraphLayout } = require(output)

  const loose = computeTaskGraphLayout(tasks('a', 'b', 'c', 'd'), [])
  assert.equal(loose.chainCount, 0)
  assert.equal(loose.looseCount, 4)
  assert.equal(loose.positions.size, 4)
  assert.ok(new Set([...loose.positions.values()].map(({ x, y }) => `${x}:${y}`)).size === 4)

  const separate = computeTaskGraphLayout(tasks('a', 'b', 'c', 'd'), [dep('ab', 'a', 'b'), dep('cd', 'c', 'd')])
  assert.equal(separate.chainCount, 2)
  assert.equal(separate.looseCount, 0)
  assert.ok(separate.positions.get('a').x < separate.positions.get('b').x)
  assert.ok(separate.positions.get('c').x < separate.positions.get('d').x)
  assert.notDeepEqual(separate.positions.get('a'), separate.positions.get('c'))

  const branch = computeTaskGraphLayout(tasks('start', 'left', 'right', 'finish'), [
    dep('sl', 'start', 'left'),
    dep('sr', 'start', 'right'),
    dep('lf', 'left', 'finish'),
    dep('rf', 'right', 'finish'),
  ])
  assert.equal(branch.chainCount, 1)
  assert.ok(branch.positions.get('start').x < branch.positions.get('left').x)
  assert.equal(branch.positions.get('left').x, branch.positions.get('right').x)
  assert.ok(branch.positions.get('right').x < branch.positions.get('finish').x)

  const filtered = computeTaskGraphLayout(tasks('a', 'b'), [dep('outside', 'a', 'missing')])
  assert.equal(filtered.chainCount, 0)
  assert.equal(filtered.looseCount, 2)

  console.log('Task graph layout tests passed.')
} finally {
  fs.rmSync(output, { force: true })
}
