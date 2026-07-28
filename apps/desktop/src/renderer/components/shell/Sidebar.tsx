import type { ReactNode } from 'react'
import { NavLink, useLocation, type NavLinkProps } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Cat,
  Gamepad2,
  LayoutDashboard,
  LineChart,
  ListTodo,
  ScrollText,
  PartyPopper,
  Plug,
  Settings,
  Home,
  Users,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  LibraryBig,
  Lightbulb,
  MessageSquareText,
  Search,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { trpc } from '@/lib/trpc'
import { useT } from '@/i18n/useT'

type BadgeTone = 'alarm' | 'warning' | 'accent'

const badgeCls: Record<BadgeTone, string> = {
  alarm: 'bg-alarm text-white',
  warning: 'bg-warning text-white',
  accent: 'bg-accent-fill text-accent-fg',
}

function SideLink({
  to,
  end,
  icon: Icon,
  label,
  collapsed,
  badge = 0,
  badgeTone = 'accent',
  nested = false,
  section = false,
}: {
  to: string
  end?: NavLinkProps['end']
  icon: LucideIcon
  label: string
  collapsed: boolean
  badge?: number
  badgeTone?: BadgeTone
  nested?: boolean
  section?: boolean
}) {
  const shownBadge = Math.min(badge, 99)
  const accessibleLabel = shownBadge > 0 ? `${label}: ${shownBadge}` : label

  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? accessibleLabel : undefined}
      aria-label={accessibleLabel}
      className={({ isActive }) =>
        cn(
          'relative flex min-h-10 items-center rounded-[var(--radius)] px-2.5 text-sm transition-[color,background-color,transform] hover:translate-x-[2px]',
          collapsed ? 'justify-center' : 'gap-2.5',
          nested && !collapsed && 'pl-5',
          isActive
            ? 'bg-accent/12 text-accent shadow-[inset_2px_0_0_var(--color-accent)]'
            : 'text-muted hover:bg-surface-2 hover:text-text',
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {!collapsed && <span className={cn('min-w-0 flex-1 truncate', section && 't-section')}>{label}</span>}
      {shownBadge > 0 && (
        <span
          className={cn(
            'nums inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 t-hint font-medium',
            badgeCls[badgeTone],
            collapsed && 'absolute right-0.5 top-0.5 h-4 min-w-4 px-0.5',
          )}
          aria-hidden
        >
          {shownBadge === 99 && badge > 99 ? '99+' : shownBadge}
        </span>
      )}
    </NavLink>
  )
}

function SectionHeader({
  id,
  label,
  collapsed,
  expanded,
  active,
  onToggle,
  icon: Icon,
  color,
  badge = 0,
  badgeTone = 'accent',
}: {
  id: string
  label: string
  collapsed: boolean
  expanded: boolean
  active: boolean
  onToggle: () => void
  icon?: LucideIcon
  color?: string
  badge?: number
  badgeTone?: BadgeTone
}) {
  const shownBadge = Math.min(badge, 99)
  return (
    <button
      type="button"
      onClick={onToggle}
      title={collapsed ? label : undefined}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={id}
      className={cn(
        'tap relative flex min-h-10 w-full items-center rounded-[var(--radius)] text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        collapsed ? 'justify-center px-2.5' : 'gap-2.5 px-2.5',
        active && !expanded
          ? 'bg-accent/12 text-accent shadow-[inset_2px_0_0_var(--color-accent)]'
          : active
            ? 'text-accent hover:bg-surface-2'
            : 'text-muted hover:bg-surface-2 hover:text-text',
      )}
    >
      {Icon ? (
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
      ) : (
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      )}
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left t-section">{label}</span>}
      {!expanded && shownBadge > 0 && (
        <span
          className={cn(
            'nums inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 t-hint font-medium',
            badgeCls[badgeTone],
            collapsed && 'absolute right-0.5 top-0.5 h-4 min-w-4 px-0.5',
          )}
          aria-hidden
        >
          {shownBadge === 99 && badge > 99 ? '99+' : shownBadge}
        </span>
      )}
      {!collapsed && (
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
            expanded && 'rotate-90',
          )}
          aria-hidden
        />
      )}
    </button>
  )
}

function SectionItems({ id, expanded, children }: { id: string; expanded: boolean; children: ReactNode }) {
  return (
    <div
      ref={(node) => {
        if (node) node.inert = !expanded
      }}
      id={id}
      aria-hidden={!expanded}
      className={cn(
        'grid overflow-hidden transition-[grid-template-rows,opacity] duration-150 motion-reduce:transition-none',
        expanded ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

export function Sidebar() {
  const t = useT()
  const location = useLocation()
  const currentGameId = useUi((state) => state.currentGameId)
  const collapsed = useUi((state) => state.sidebarCollapsed)
  const setCollapsed = useUi((state) => state.setSidebarCollapsed)
  const setSearchOpen = useUi((state) => state.setSearchOpen)
  const sectionState = useUi((state) => state.sidebarSections)
  const setSection = useUi((state) => state.setSidebarSection)
  const games = useQuery({ queryKey: ['games'], queryFn: () => trpc.games.list.query() })
  const overview = useQuery({ queryKey: ['dashboard'], queryFn: () => trpc.dashboard.overview.query() })
  const currentGame = games.data?.find((game) => game.id === currentGameId) ?? null
  const data = overview.data
  const toggleLabel = collapsed ? t('nav.expand') : t('nav.collapse')

  const alarmDeadlines = data?.deadlines.filter((item) => item.alarm) ?? []
  const warningDeadlines = data?.deadlines.filter((item) => item.warn) ?? []
  const upcomingWeek = data?.tasksUpcoming.filter((item) => item.daysLeft <= 7) ?? []
  const festivalSoon =
    data?.festivals.filter((item) => item.deadlineDays != null && item.deadlineDays >= 0 && item.deadlineDays <= 14) ??
    []
  const prospectTotal = data?.creatorProspects.reduce((sum, item) => sum + item.count, 0) ?? 0
  const criticalTotal = (data?.tasksOverdue.length ?? 0) + alarmDeadlines.length + (data?.syncs.length ?? 0)
  const focusBadge = criticalTotal || upcomingWeek.length + (data?.aiReview.length ?? 0)
  const focusTone: BadgeTone = criticalTotal > 0 ? 'alarm' : data?.aiReview.length ? 'accent' : 'warning'

  const byGame = currentGame
    ? {
        overdue: data?.tasksOverdue.filter((item) => item.gameId === currentGame.id).length ?? 0,
        upcoming: upcomingWeek.filter((item) => item.gameId === currentGame.id).length,
        deadlines: [...alarmDeadlines, ...warningDeadlines].filter((item) => item.gameId === currentGame.id).length,
        festivals: festivalSoon.filter((item) => item.gameId === currentGame.id).length,
        creators: data?.creatorProspects.find((item) => item.gameId === currentGame.id)?.count ?? 0,
        syncs: data?.syncs.filter((item) => item.gameId === currentGame.id).length ?? 0,
        reviews: data?.aiReview.filter((item) => item.gameId === currentGame.id).length ?? 0,
        comments: data?.comments.find((item) => item.gameId === currentGame.id)?.count ?? 0,
      }
    : null

  const librarySectionId = 'sidebar-library'
  const libraryActive = location.pathname === '/festivals' || location.pathname === '/creators'
  const libraryExpanded = sectionState.library ?? libraryActive
  const libraryBadge = festivalSoon.length + prospectTotal
  const libraryTone: BadgeTone = festivalSoon.length > 0 ? 'warning' : 'accent'

  const projectSectionKey = currentGame ? `project:${currentGame.id}` : ''
  const projectSectionId = currentGame ? `sidebar-project-${currentGame.id}` : 'sidebar-project'
  const projectBase = currentGame ? `/g/${currentGame.id}` : ''
  const projectActive = currentGame
    ? location.pathname === projectBase || location.pathname.startsWith(`${projectBase}/`)
    : false
  const projectExpanded = currentGame ? (sectionState[projectSectionKey] ?? projectActive) : false
  const projectBadge = byGame
    ? (byGame.overdue || byGame.upcoming) +
      byGame.deadlines +
      byGame.festivals +
      byGame.creators +
      byGame.syncs +
      byGame.comments +
      byGame.reviews
    : 0
  const projectTone: BadgeTone =
    byGame?.overdue || byGame?.syncs ? 'alarm' : byGame?.deadlines || byGame?.festivals ? 'warning' : 'accent'

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col gap-0.5 overflow-hidden border-r border-border bg-surface px-2 py-3 transition-[width] duration-150',
        collapsed ? 'w-16' : 'w-56',
      )}
    >
      <div className={cn('flex min-h-10 items-center pb-2', collapsed ? 'justify-center' : 'gap-2 px-2.5')}>
        {!collapsed && (
          <>
            <Gamepad2 className="h-5 w-5 shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate t-title">MarCat</span>
          </>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          title={toggleLabel}
          aria-label={toggleLabel}
          className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      <button
        type="button"
        onClick={() => setSearchOpen(true)}
        title={collapsed ? t('search.open') : undefined}
        aria-label={t('search.open')}
        className={cn(
          'tap flex min-h-10 w-full items-center rounded-[var(--radius)] text-sm text-muted transition-[transform,background-color,color] hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          collapsed ? 'justify-center px-2.5' : 'gap-2.5 px-2.5',
        )}
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-left">{t('common.search')}</span>
            <kbd className="rounded-[4px] bg-bg px-1.5 py-0.5 font-mono text-[10px] text-muted shadow-[0_0_0_1px_var(--border)]">
              Ctrl F
            </kbd>
          </>
        )}
      </button>

      <div className="pt-1">
        <SideLink
          to="/"
          end
          icon={LayoutDashboard}
          label={t('nav.focus')}
          collapsed={collapsed}
          badge={focusBadge}
          badgeTone={focusTone}
          section
        />
      </div>

      <div className="pt-2">
        <SectionHeader
          id={librarySectionId}
          label={t('nav.library')}
          collapsed={collapsed}
          expanded={libraryExpanded}
          active={libraryActive}
          onToggle={() => setSection('library', !libraryExpanded)}
          icon={LibraryBig}
          badge={libraryBadge}
          badgeTone={libraryTone}
        />
        <SectionItems id={librarySectionId} expanded={libraryExpanded}>
          <SideLink
            to="/festivals"
            icon={PartyPopper}
            label={t('fest.global')}
            collapsed={collapsed}
            badge={festivalSoon.length}
            badgeTone="warning"
            nested
          />
          <SideLink
            to="/creators"
            icon={Users}
            label={t('creators.global')}
            collapsed={collapsed}
            badge={prospectTotal}
            nested
          />
        </SectionItems>
      </div>

      {currentGame && byGame && (
        <div className="pt-2">
          <SectionHeader
            id={projectSectionId}
            label={currentGame.name}
            collapsed={collapsed}
            expanded={projectExpanded}
            active={projectActive}
            onToggle={() => setSection(projectSectionKey, !projectExpanded)}
            color={currentGame.color}
            badge={projectBadge}
            badgeTone={projectTone}
          />
          <SectionItems id={projectSectionId} expanded={projectExpanded}>
            <SideLink to={`/g/${currentGame.id}`} end icon={Home} label={t('nav.home')} collapsed={collapsed} nested />
            <SideLink
              to={`/g/${currentGame.id}/tasks`}
              icon={ListTodo}
              label={t('nav.tasks')}
              collapsed={collapsed}
              badge={byGame.overdue || byGame.upcoming}
              badgeTone={byGame.overdue ? 'alarm' : 'warning'}
              nested
            />
            <SideLink
              to={`/g/${currentGame.id}/events`}
              icon={ScrollText}
              label={t('nav.events')}
              collapsed={collapsed}
              nested
            />
            <SideLink
              to={`/g/${currentGame.id}/insights`}
              icon={Lightbulb}
              label={t('nav.insights')}
              collapsed={collapsed}
              nested
            />
            <SideLink
              to={`/g/${currentGame.id}/comments`}
              icon={MessageSquareText}
              label={t('nav.comments')}
              collapsed={collapsed}
              badge={byGame.comments}
              nested
            />
            <SideLink
              to={`/g/${currentGame.id}/festivals`}
              icon={PartyPopper}
              label={t('nav.festivals')}
              collapsed={collapsed}
              badge={byGame.festivals}
              badgeTone="warning"
              nested
            />
            <SideLink
              to={`/g/${currentGame.id}/creators`}
              icon={Users}
              label={t('nav.creators')}
              collapsed={collapsed}
              badge={byGame.creators}
              nested
            />
            <SideLink
              to={`/g/${currentGame.id}/sources`}
              icon={Plug}
              label={t('nav.sources')}
              collapsed={collapsed}
              badge={byGame.syncs}
              badgeTone="alarm"
              nested
            />
            <SideLink
              to={`/g/${currentGame.id}/analytics`}
              icon={LineChart}
              label={t('nav.analytics')}
              collapsed={collapsed}
              nested
            />
            <SideLink
              to={`/g/${currentGame.id}/ai`}
              icon={Cat}
              label={t('nav.aiDen')}
              collapsed={collapsed}
              badge={byGame.reviews}
              nested
            />
          </SectionItems>
        </div>
      )}

      <div className="mt-auto">
        <SideLink to="/settings" icon={Settings} label={t('nav.settings')} collapsed={collapsed} />
      </div>
    </aside>
  )
}
