import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // Only runtime `dependencies` are externalized — here that's just the native
    // @libsql/client. Everything else (our @marcat/* packages, drizzle, trpc,
    // electron-trpc, zod) is a devDependency and gets bundled into the main
    // process, so the packaged app's node_modules stays tiny and contains no
    // out-of-tree workspace symlinks.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'discovery-worker': resolve(__dirname, 'src/main/discovery-worker.ts'),
          'promotion-worker': resolve(__dirname, 'src/main/promotion-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname),
    server: { host: '127.0.0.1' },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer') },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') },
      },
    },
  },
})
