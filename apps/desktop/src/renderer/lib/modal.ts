import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Modal/drawer accessibility: Escape-to-close, focus the first control on open,
 * and trap Tab focus inside the container. Pass the container ref + a close fn.
 * `enabled` must be false while the modal is hidden, or its global Escape/Tab
 * listener would swallow those keys app-wide.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    const focusables = () =>
      el
        ? (Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (n) => n.offsetParent !== null,
          ) as HTMLElement[])
        : []

    // Focus the first control unless something inside is already focused.
    if (el && !el.contains(document.activeElement)) focusables()[0]?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Tab' && el) {
        const f = focusables()
        if (f.length === 0) return
        const first = f[0]!
        const last = f[f.length - 1]!
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, enabled])
}
