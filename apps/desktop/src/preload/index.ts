import { contextBridge, ipcRenderer } from 'electron'
import { exposeElectronTRPC } from 'electron-trpc/main'

// Bridge the tRPC IPC channel into the (context-isolated) renderer, plus a tiny
// helper surface for things tRPC can't do (relaunch, reveal a folder).
process.once('loaded', () => {
  exposeElectronTRPC()
  contextBridge.exposeInMainWorld('marcat', {
    relaunch: () => ipcRenderer.send('marcat:relaunch'),
    openBackupsFolder: () => ipcRenderer.send('marcat:openBackupsFolder'),
    chooseProjectFolder: (): Promise<string | null> => ipcRenderer.invoke('marcat:chooseProjectFolder'),
    openLocalPath: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('marcat:openLocalPath', path),
    showFileContextMenu: (request: { path: string | null; openLabel: string; missingLabel: string }) =>
      ipcRenderer.send('marcat:showFileContextMenu', request),
  })
})
