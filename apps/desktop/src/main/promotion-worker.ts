import { processCreatorPromotionQueue } from '@marcat/core'
import { configureConnection, createDb, fileUrlFromPath } from '@marcat/db'

type PromotionWorkerRequest = { kind: 'run'; dbPath: string }
type PromotionWorkerResult = { kind: 'result'; runId: string | null } | { kind: 'error'; error: string }

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message
  return String(error)
}

const parentPort = process.parentPort
if (!parentPort) throw new Error('Creator promotion worker requires an Electron parent port')

parentPort.once('message', (event) => {
  const request = event.data as PromotionWorkerRequest
  void (async () => {
    if (request?.kind !== 'run' || !request.dbPath) throw new Error('Invalid creator promotion worker request')
    const database = createDb(fileUrlFromPath(request.dbPath))
    try {
      await configureConnection(database.client)
      const result = await processCreatorPromotionQueue(database.db)
      parentPort.postMessage({ kind: 'result', runId: result?.runId ?? null } satisfies PromotionWorkerResult)
    } finally {
      database.client.close()
    }
  })()
    .then(() => setImmediate(() => process.exit(0)))
    .catch((error) => {
      parentPort.postMessage({ kind: 'error', error: formatError(error) } satisfies PromotionWorkerResult)
      setImmediate(() => process.exit(1))
    })
})
