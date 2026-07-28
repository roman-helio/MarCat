import { defineConfig } from 'drizzle-kit'

// Local SQLite (libsql is SQLite-compatible). We only use drizzle-kit to
// GENERATE migration SQL from the schema; migrations are applied at runtime
// via the libsql migrator (see src/migrate.ts / runMigrations).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
})
