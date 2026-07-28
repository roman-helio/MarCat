const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { appRouter } = require('@marcat/core')
const { configureConnection, createDb, fileUrlFromPath, runMigrations } = require('@marcat/db')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-concurrency-'))
  const dbPath = path.join(dir, 'shared.db')
  const migrations = path.join(require.resolve('@marcat/db'), '..', '..', 'migrations')
  const root = createDb(fileUrlFromPath(dbPath))
  await configureConnection(root.client)
  await runMigrations(root.db, root.client, migrations)
  const rootCaller = appRouter.createCaller({ db: root.db })
  const game = await rootCaller.games.create({ name: 'Concurrent Game' })
  const otherGame = await rootCaller.games.create({ name: 'Other Game' })

  const connections = Array.from({ length: 8 }, () => createDb(fileUrlFromPath(dbPath)))
  await Promise.all(connections.map(({ client }) => configureConnection(client)))
  const callers = connections.map(({ db }) => appRouter.createCaller({ db }))
  const created = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      callers[index % callers.length].tasks.create({ gameId: game.id, title: `Concurrent task ${index + 1}` }),
    ),
  )
  const seqs = created.map((task) => task.seq)
  if (new Set(seqs).size !== created.length) throw new Error('Concurrent task sequence collision')

  const [blocker, blocked] = created
  const duplicateEdges = await Promise.all(
    callers
      .slice(0, 4)
      .map((caller) => caller.tasks.addDependency({ blockerTaskId: blocker.id, blockedTaskId: blocked.id })),
  )
  if (new Set(duplicateEdges.map((edge) => edge.id)).size !== 1) throw new Error('Duplicate dependency was created')

  const foreignTask = await rootCaller.tasks.create({ gameId: otherGame.id, title: 'Foreign task' })
  let crossGameBlocked = false
  try {
    await rootCaller.tasks.addDependency({ blockerTaskId: blocker.id, blockedTaskId: foreignTask.id })
  } catch {
    crossGameBlocked = true
  }
  if (!crossGameBlocked) throw new Error('Cross-game dependency was accepted')

  for (const { client } of connections) client.close()
  root.client.close()
  console.log(`CONCURRENCY OK (${created.length} writes, unique seq + dependency invariant)`)
}

main().catch((error) => {
  console.error('CONCURRENCY FAIL', error)
  process.exitCode = 1
})
