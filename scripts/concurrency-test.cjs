const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fork } = require('node:child_process')
const { createClient } = require('@libsql/client')
const { appRouter } = require('@marcat/core')
const { configureConnection, createDb, fileUrlFromPath, runMigrations } = require('@marcat/db')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function lockWorker(mode, dbPath, gameId) {
  if (mode === 'raw-holder') {
    // Simulate an older/external SQLite writer that does not know MarCat's lock file.
    const client = createClient({ url: fileUrlFromPath(dbPath) })
    try {
      await client.execute('PRAGMA busy_timeout=0')
      const transaction = await client.transaction('write')
      try {
        await transaction.execute({
          sql: 'UPDATE games SET updated_at = ? WHERE id = ?',
          args: [new Date().toISOString(), gameId],
        })
        process.send?.({ type: 'holding' })
        await wait(1_600)
        await transaction.commit()
      } finally {
        transaction.close()
      }
    } finally {
      client.close()
    }
    return
  }

  const database = createDb(fileUrlFromPath(dbPath))
  try {
    if (mode === 'holder' || mode === 'crash') {
      const transaction = await database.client.transaction('write')
      try {
        await transaction.execute({
          sql: 'UPDATE games SET updated_at = ? WHERE id = ?',
          args: [new Date().toISOString(), gameId],
        })
        process.send?.({ type: 'holding' })
        if (mode === 'crash') {
          await wait(20)
          process.exit(17)
        }
        await wait(600)
        await transaction.commit()
      } finally {
        transaction.close()
      }
      return
    }

    const caller = appRouter.createCaller({ db: database.db })
    const created = await caller.tasks.create({
      gameId,
      title:
        mode === 'recovery'
          ? 'Recovered abandoned write lock'
          : mode === 'legacy-contender'
            ? 'Queued behind legacy writer'
            : 'Cross-process queued write',
    })
    process.send?.({ type: 'created', mode, id: created.id })
  } finally {
    database.client.close()
  }
}

function childFailure(child, stderr) {
  return new Error(`Concurrency child exited with code ${child.exitCode}: ${stderr.trim() || 'no diagnostics'}`)
}

async function waitForExit(child, stderr) {
  const [code, signal] = await new Promise((resolve) => child.once('exit', (...args) => resolve(args)))
  if (code !== 0) throw childFailure(child, `${stderr}\n${signal ? `signal=${signal}` : ''}`)
}

async function crossProcessWriteQueue(dbPath, gameId) {
  const spawn = (mode) => {
    const child = fork(__filename, [`--lock-${mode}`, dbPath, gameId], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    const messages = []
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('message', (message) => messages.push(message))
    return { child, stderr: () => stderr, messages: () => messages }
  }

  const holder = spawn('holder')
  await new Promise((resolve, reject) => {
    holder.child.once('error', reject)
    holder.child.on('message', (message) => {
      if (message?.type === 'holding') resolve()
    })
    holder.child.once('exit', () => reject(childFailure(holder.child, holder.stderr())))
  })

  const startedAt = Date.now()
  const contender = spawn('contender')
  await Promise.all([waitForExit(contender.child, contender.stderr()), waitForExit(holder.child, holder.stderr())])
  const waitedMs = Date.now() - startedAt
  if (waitedMs < 300)
    throw new Error(`Cross-process writer did not queue behind the active transaction (${waitedMs}ms)`)

  const crashed = spawn('crash')
  await new Promise((resolve, reject) => {
    crashed.child.once('error', reject)
    crashed.child.on('message', (message) => {
      if (message?.type === 'holding') resolve()
    })
  })
  const [crashCode] = await new Promise((resolve) => crashed.child.once('exit', (...args) => resolve(args)))
  if (crashCode !== 17) throw new Error(`Crash worker exited unexpectedly: ${crashCode}\n${crashed.stderr()}`)
  const recovery = spawn('recovery')
  await waitForExit(recovery.child, recovery.stderr())

  const rawHolder = spawn('raw-holder')
  await new Promise((resolve, reject) => {
    rawHolder.child.once('error', reject)
    rawHolder.child.on('message', (message) => {
      if (message?.type === 'holding') resolve()
    })
    rawHolder.child.once('exit', () => reject(childFailure(rawHolder.child, rawHolder.stderr())))
  })
  const legacyStartedAt = Date.now()
  const legacyContender = spawn('legacy-contender')
  await Promise.all([
    waitForExit(legacyContender.child, legacyContender.stderr()),
    waitForExit(rawHolder.child, rawHolder.stderr()),
  ])
  const legacyWaitedMs = Date.now() - legacyStartedAt
  if (legacyWaitedMs < 1_000) {
    throw new Error(`Writer did not retry behind an uncooperative SQLite transaction (${legacyWaitedMs}ms)`)
  }
  const legacyCreatedId = legacyContender.messages().find((message) => message?.type === 'created')?.id
  if (!legacyCreatedId) throw new Error('Legacy-contender write exited without reporting its committed task')
  return { legacyCreatedId }
}

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

  const { legacyCreatedId } = await crossProcessWriteQueue(dbPath, game.id)
  const queuedWrite = await rootCaller.tasks.search({ gameId: game.id, query: 'Cross-process queued write' })
  if (queuedWrite.totalCount !== 1 || queuedWrite.items.length !== 1) {
    throw new Error('Queued cross-process write was not committed exactly once')
  }
  const recoveredWrite = await rootCaller.tasks.search({ gameId: game.id, query: 'Recovered abandoned write lock' })
  if (recoveredWrite.totalCount !== 1 || recoveredWrite.items.length !== 1) {
    throw new Error('A write did not recover after the lock owner exited')
  }
  const legacyQueuedWrite = await rootCaller.tasks.get({ id: legacyCreatedId })
  if (legacyQueuedWrite?.task.title !== 'Queued behind legacy writer') {
    throw new Error(
      `A write did not recover after uncooperative SQLite contention: ${JSON.stringify(legacyQueuedWrite)}`,
    )
  }

  for (const { client } of connections) client.close()
  root.client.close()
  console.log(`CONCURRENCY OK (${created.length} writes, cross-process queue + unique seq + dependency invariant)`)
}

const workerMode = process.argv[2]?.match(/^--lock-(holder|contender|crash|recovery|raw-holder|legacy-contender)$/)?.[1]
const entry = workerMode ? lockWorker(workerMode, process.argv[3], process.argv[4]) : main()

entry.catch((error) => {
  console.error('CONCURRENCY FAIL', error)
  process.exitCode = 1
})
