/* One-off: remove leftover DIAG-* test games from the local app database. */
const path = require('node:path')
const { createDb, fileUrlFromPath } = require('@marcat/db')

async function main() {
  const dbPath = path.join(process.env.APPDATA, 'MarCat', 'marcat.db')
  const { client } = createDb(fileUrlFromPath(dbPath))
  await client.execute('PRAGMA foreign_keys = ON;')
  const res = await client.execute("DELETE FROM games WHERE slug LIKE 'diag-%'")
  console.log('removed DIAG games:', res.rowsAffected)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
