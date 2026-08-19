import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportRendererError } from '@/lib/diagnostics'

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRendererError('react-boundary', error, { componentStack: info.componentStack ?? undefined, scope: 'app' })
    console.error('Renderer crashed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="grid min-h-screen place-items-center bg-bg p-6 text-text">
        <div
          role="alert"
          className="w-full max-w-lg rounded-[var(--radius)] border border-alarm bg-surface p-5 shadow-hard"
        >
          <h1 className="t-title text-alarm">Что-то пошло не так / Something went wrong</h1>
          <p className="mt-2 break-words text-sm text-muted">{this.state.error.message}</p>
          <button
            className="mt-4 min-h-10 rounded-[var(--radius)] bg-accent-fill px-4 text-sm font-medium text-accent-fg shadow-hard tactile"
            onClick={() => window.location.reload()}
          >
            Перезагрузить / Reload
          </button>
        </div>
      </main>
    )
  }
}
