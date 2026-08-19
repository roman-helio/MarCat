import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
const modalStack: HTMLElement[] = []

/**
 * Modal/drawer accessibility: Escape-to-close, focus the first control on open,
 * and trap Tab focus inside the container. Pass the container ref + a close fn.
 * `enabled` must be false while the modal is hidden, or its global Escape/Tab
 * listener would swallow those keys app-wide.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void, enabled = true) {
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el) return
    modalStack.push(el)
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = () =>
      el
        ? (Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (n) => n.offsetParent !== null,
          ) as HTMLElement[])
        : []

    // Focus after the opening render, unless autofocus already moved focus inside.
    const focusTimer = window.setTimeout(() => {
      if (el && !el.contains(document.activeElement)) focusables()[0]?.focus()
    }, 0)

    const onKey = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== el) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
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
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKey, true)
      const stackIndex = modalStack.lastIndexOf(el)
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1)
      window.setTimeout(() => {
        if (previouslyFocused?.isConnected) previouslyFocused.focus()
      }, 0)
    }
  }, [enabled, ref])
}
