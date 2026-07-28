import { lazy } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { queryClient } from './lib/queryClient'
import { ThemeManager } from './components/ThemeManager'
import { AppShell } from './components/shell/AppShell'

const Dashboard = lazy(() => import('./pages/Dashboard').then((module) => ({ default: module.Dashboard })))
const GameHome = lazy(() => import('./pages/GameHome').then((module) => ({ default: module.GameHome })))
const Settings = lazy(() => import('./pages/Settings').then((module) => ({ default: module.Settings })))
const AiDen = lazy(() => import('./pages/AiDen').then((module) => ({ default: module.AiDen })))
const Tasks = lazy(() => import('./pages/Tasks').then((module) => ({ default: module.Tasks })))
const Calendar = lazy(() => import('./pages/Calendar').then((module) => ({ default: module.Calendar })))
const Events = lazy(() => import('./pages/Events').then((module) => ({ default: module.Events })))
const Festivals = lazy(() => import('./pages/Festivals').then((module) => ({ default: module.Festivals })))
const Creators = lazy(() => import('./pages/Creators').then((module) => ({ default: module.Creators })))
const Sources = lazy(() => import('./pages/Sources').then((module) => ({ default: module.Sources })))
const Analytics = lazy(() => import('./pages/Analytics').then((module) => ({ default: module.Analytics })))
const Insights = lazy(() => import('./pages/Insights').then((module) => ({ default: module.Insights })))
const Comments = lazy(() => import('./pages/Comments').then((module) => ({ default: module.Comments })))

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeManager />
      <HashRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/festivals" element={<Festivals />} />
            <Route path="/creators" element={<Creators />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/g/:gameId" element={<GameHome />} />
            <Route path="/g/:gameId/tasks" element={<Tasks />} />
            <Route path="/g/:gameId/calendar" element={<Calendar />} />
            <Route path="/g/:gameId/events" element={<Events />} />
            <Route path="/g/:gameId/insights" element={<Insights />} />
            <Route path="/g/:gameId/comments" element={<Comments />} />
            <Route path="/g/:gameId/festivals" element={<Festivals />} />
            <Route path="/g/:gameId/creators" element={<Creators />} />
            <Route path="/g/:gameId/sources" element={<Sources />} />
            <Route path="/g/:gameId/analytics" element={<Analytics />} />
            <Route path="/g/:gameId/ai" element={<AiDen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
