import { defineConfig } from 'tsup'
import { readFileSync, writeFileSync } from 'node:fs'

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  define: { __MARCAT_VERSION__: JSON.stringify(packageVersion) },
  onSuccess: async () => {
    // Before 0.3.5, exported project configs referenced dist/index.js. Recreate
    // the tiny launcher after every clean build, including watch rebuilds.
    writeFileSync(new URL('./dist/index.js', import.meta.url), "#!/usr/bin/env node\nimport './index.cjs'\n")
  },
  // Keep only the native SQLite wrapper external. The release copies this small
  // native dependency tree beside the otherwise standalone MCP bundle.
  external: ['libsql'],
  noExternal: [/.*/],
})
