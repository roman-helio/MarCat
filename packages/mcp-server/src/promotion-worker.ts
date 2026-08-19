#!/usr/bin/env node
import { processCreatorPromotionQueue } from '@marcat/core'
import { configureConnection, createDb, fileUrlFromPath } from '@marcat/db'

async function main(): Promise<void> {
  const dbPath = process.argv[2]
  if (!dbPath) throw new Error('Creator promotion worker requires a database path')
  const database = createDb(fileUrlFromPath(dbPath))
  try {
    await configureConnection(database.client)
    await processCreatorPromotionQueue(database.db)
  } finally {
    database.client.close()
  }
}

main().catch((error) => {
  console.error('[marcat-promotion-worker] failed:', error)
  process.exit(1)
})
