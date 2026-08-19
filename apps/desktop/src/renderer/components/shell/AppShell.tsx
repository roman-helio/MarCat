import { Suspense, useEffect, useRef } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { CompanionBar } from './CompanionBar'
import { CommandPalette } from './CommandPalette'
import { QuickSearch } from './QuickSearch'
import { Onboarding } from './Onboarding'
import { Sidebar } from './Sidebar'
import { ConfirmHost } from '@/components/ui/ConfirmHost'
import { Toaster } from '@/components/ui/Toaster'
import { DataVersionSync } from '@/components/DataVersionSync'
import { LoadingState } from '@/components/ui/QueryState'
import { PageContainer } from './PageContainer'
import { useT } from '@/i18n/useT'

function RouteFocus() {
  const location = useLocation()
  const currentHeading = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const main = document.querySelector<HTMLElement>('#main-content')
    if (!main) return

    const focusPage = () => {
      const heading = main?.querySelector<HTMLElement>('h1')
      if (!heading || heading === currentHeading.current) return false
      currentHeading.current = heading
      heading.focus({ preventScroll: true })
      const pageName = heading?.textContent?.trim()
      document.title = pageName ? `${pageName} · MarCat` : 'MarCat'
      return true
    }

    if (focusPage()) return

    let fallback = 0
    const observer = new MutationObserver(() => {
      if (!focusPage()) return
      observer.disconnect()
      window.clearTimeout(fallback)
    })
    observer.observe(main, { childList: true, subtree: true })
    fallback = window.setTimeout(() => {
      observer.disconnect()
      main.focus({ preventScroll: true })
      document.title = 'MarCat'
    }, 1500)
    return () => {
      observer.disconnect()
      window.clearTimeout(fallback)
    }
  }, [location.pathname])

  return null
}

export function AppShell() {
  const t = useT()

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <button
        type="button"
        data-ui="skip-link"
        onClick={() => document.querySelector<HTMLElement>('#main-content')?.focus()}
        className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-[var(--radius)] bg-surface px-3 py-2 text-sm font-medium text-text shadow-hard transition-transform focus:translate-y-0 motion-reduce:transition-none"
      >
        {t('common.skipToContent')}
      </button>
      <RouteFocus />
      <DataVersionSync />
      <CompanionBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main
          id="main-content"
          tabIndex={-1}
          className="app-scrollport min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-6"
        >
          <Suspense
            fallback={
              <PageContainer width="wide">
                <LoadingState />
              </PageContainer>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
      <CommandPalette />
      <QuickSearch />
      <Onboarding />
      <ConfirmHost />
      <Toaster />
    </div>
  )
}
