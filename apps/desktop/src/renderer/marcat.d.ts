export {}

declare global {
  interface Window {
    /** Preload bridge for things tRPC can't do (see preload/index.ts). */
    marcat?: {
      relaunch: () => void
      openBackupsFolder: () => void
      chooseProjectFolder: () => Promise<string | null>
      openLocalPath: (path: string) => Promise<{ ok: boolean; error?: string }>
      showFileContextMenu: (request: { path: string | null; openLabel: string; missingLabel: string }) => void
    }
  }
}
