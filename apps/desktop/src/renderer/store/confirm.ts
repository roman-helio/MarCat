import { create } from 'zustand'

export interface ConfirmOpts {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as destructive (red). */
  danger?: boolean
}

interface ConfirmState {
  current: (ConfirmOpts & { resolve: (v: boolean) => void }) | null
  /** Open a confirm dialog; resolves true if confirmed, false if cancelled/dismissed. */
  ask: (opts: ConfirmOpts) => Promise<boolean>
  settle: (v: boolean) => void
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  current: null,
  ask: (opts) => new Promise<boolean>((resolve) => set({ current: { ...opts, resolve } })),
  settle: (v) => {
    const cur = get().current
    set({ current: null })
    cur?.resolve(v)
  },
}))

/** Imperative helper usable inside event handlers: `if (await confirm({...})) …`. */
export const confirm = (opts: ConfirmOpts) => useConfirm.getState().ask(opts)
