import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/activitySemantics.ts', 'src/gameSemantics.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  external: ['@marcat/db', '@trpc/server', 'drizzle-orm', 'superjson', 'zod'],
})
