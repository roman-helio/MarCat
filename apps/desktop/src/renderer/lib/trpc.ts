import { createTRPCProxyClient } from '@trpc/client'
import { ipcLink } from 'electron-trpc/renderer'
import type { AppRouter } from '@marcat/core'

/** Vanilla tRPC v10 client talking to the Electron main process over IPC. */
export const trpc = createTRPCProxyClient<AppRouter>({
  links: [ipcLink()],
})
