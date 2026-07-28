import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Keep native/runtime deps external so the libsql binding loads at runtime.
  external: ['@libsql/client', 'drizzle-orm'],
})
