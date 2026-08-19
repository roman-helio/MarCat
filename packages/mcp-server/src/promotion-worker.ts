#!/usr/bin/env node
import { processCreatorPromotionQueue } from '@marcat/core'
import { fileUrlFromPath, openDb } from '@marcat/db'

async function main(): Promise<void> {
  const dbPath = process.argv[2]
  if (!dbPath) throw new Error('Creator promotion worker requires a database path')
  const database = await openDb(fileUrlFromPath(dbPath))
  try {
    await processCreatorPromotionQueue(database.db)
  } finally {
    database.client.close()
  }
}

main().catch((error) => {
  console.error('[marcat-promotion-worker] failed:', error)
  process.exit(1)
})
