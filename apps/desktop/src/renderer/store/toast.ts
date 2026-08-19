import { create } from 'zustand'

export type ToastKind = 'success' | 'error' | 'info'
export interface Toast {
  id: number
  kind: ToastKind
  msg: string
}

interface ToastState {
  toasts: Toast[]
  push: (kind: ToastKind, msg: string) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, msg) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, kind, msg }] }))
    // Errors require an explicit dismissal; routine feedback remains long enough to read.
    if (kind !== 'error') setTimeout(() => get().dismiss(id), 5000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** Imperative helpers usable anywhere (event handlers, mutation callbacks). */
export const toast = {
  success: (msg: string) => useToasts.getState().push('success', msg),
  error: (msg: string) => useToasts.getState().push('error', msg),
  info: (msg: string) => useToasts.getState().push('info', msg),
  /** Convenience for mutation onError: stringifies the error. */
  fromError: (e: unknown) => useToasts.getState().push('error', e instanceof Error ? e.message : String(e)),
}
