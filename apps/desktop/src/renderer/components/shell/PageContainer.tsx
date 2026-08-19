import { type HTMLAttributes } from 'react'
import { Outlet } from 'react-router-dom'
import { cn } from '@/lib/utils'

export type PageWidth = 'standard' | 'wide'

const widthClass: Record<PageWidth, string> = {
  standard: 'max-w-[var(--page-width-standard)]',
  wide: 'max-w-[var(--page-width-wide)]',
}

interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  width?: PageWidth
}

export function PageContainer({ width = 'standard', className, ...props }: PageContainerProps) {
  return <div className={cn('mx-auto w-full min-w-0', widthClass[width], className)} {...props} />
}

export function PageContainerOutlet({ width }: { width: PageWidth }) {
  return (
    <PageContainer width={width}>
      <Outlet />
    </PageContainer>
  )
}
