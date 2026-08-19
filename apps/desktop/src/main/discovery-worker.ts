import { processYouTubeDiscoveryQueue, type SecretsStore } from '@marcat/core'
import { fileUrlFromPath, openDb } from '@marcat/db'

type DiscoveryWorkerRequest = {
  kind: 'run'
  dbPath: string
  apiKeys: {
    youtube?: string
    scrapecreators?: string
  }
}

type DiscoveryWorkerResult = { kind: 'result'; runId: string | null } | { kind: 'error'; error: string }

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message
  return String(error)
}

const parentPort = process.parentPort
if (!parentPort) throw new Error('Creator discovery worker requires an Electron parent port')

let started = false
parentPort.once('message', (event) => {
  if (started) return
  started = true
  const request = event.data as DiscoveryWorkerRequest
  void (async () => {
    if (request?.kind !== 'run' || !request.dbPath) throw new Error('Invalid creator discovery worker request')
    const database = await openDb(fileUrlFromPath(request.dbPath))
    try {
      const secrets: SecretsStore = {
        getClaudeToken: () => undefined,
        setClaudeToken: () => {},
        getAiProvider: () => undefined,
        setAiProvider: () => {},
        getApiKey: (provider) => request.apiKeys[provider as keyof typeof request.apiKeys],
        setApiKey: () => {},
      }
      // Recycle the native DB/network process between short slices. The local
      // libSQL binding has shown an access violation only after long discovery
      // sessions; durable progress makes bounded slices transparent and safe.
      const runId = await processYouTubeDiscoveryQueue(database.db, secrets, {
        maxYoutubeChannelsPerInvocation: 25,
      })
      parentPort.postMessage({ kind: 'result', runId } satisfies DiscoveryWorkerResult)
    } finally {
      database.client.close()
    }
  })()
    .then(() => setImmediate(() => process.exit(0)))
    .catch((error) => {
      parentPort.postMessage({ kind: 'error', error: formatError(error) } satisfies DiscoveryWorkerResult)
      setImmediate(() => process.exit(1))
    })
})
