import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createDb, fileUrlFromPath } from '../src/client'
import { runMigrations } from '../src/migrate'

// Dev/CLI entrypoint: `npm run db:migrate` (runs via tsx).
async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = path.resolve(here, '..', 'migrations')
  const dbPath = process.env.MARCAT_DB ?? path.resolve(here, '..', 'dev.db')
  const { db, client } = createDb(fileUrlFromPath(dbPath))
  await runMigrations(db, client, migrationsFolder)
  console.log(`Migrations applied to ${dbPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
