import { Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import { CompanionBar } from './CompanionBar'
import { CommandPalette } from './CommandPalette'
import { QuickSearch } from './QuickSearch'
import { Onboarding } from './Onboarding'
import { Sidebar } from './Sidebar'
import { ConfirmHost } from '@/components/ui/ConfirmHost'
import { Toaster } from '@/components/ui/Toaster'
import { DataVersionSync } from '@/components/DataVersionSync'
import { LoadingState } from '@/components/ui/QueryState'

export function AppShell() {
  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <DataVersionSync />
      <CompanionBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-h-0 flex-1 overflow-auto p-6">
          <Suspense
            fallback={
              <div className="mx-auto max-w-6xl">
                <LoadingState />
              </div>
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
