export type RendererErrorKind = 'react-boundary' | 'window-error' | 'unhandled-rejection' | 'data-load-error'

export interface RendererErrorContext {
  componentStack?: string
  scope?: string
  taskId?: string
}

const recentReports = new Map<string, number>()
const REPORT_DEDUP_MS = 2_000

function errorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack }
  if (typeof error === 'string') return { message: error }
  try {
    return { message: JSON.stringify(error) }
  } catch {
    return { message: String(error) }
  }
}

/** Best-effort renderer diagnostics. Reporting must never create a second UI failure. */
export function reportRendererError(kind: RendererErrorKind, error: unknown, context: RendererErrorContext = {}): void {
  try {
    const details = errorDetails(error)
    const fingerprint = [kind, context.scope, context.taskId, details.message, details.stack?.slice(0, 300)].join('|')
    const now = Date.now()
    if (now - (recentReports.get(fingerprint) ?? 0) < REPORT_DEDUP_MS) return
    recentReports.set(fingerprint, now)
    for (const [key, reportedAt] of recentReports) {
      if (now - reportedAt > REPORT_DEDUP_MS) recentReports.delete(key)
    }
    window.marcat?.reportRendererError({
      kind,
      message: details.message,
      stack: details.stack,
      componentStack: context.componentStack,
      route: window.location.hash || window.location.pathname,
      title: document.title,
      scope: context.scope,
      taskId: context.taskId,
    })
  } catch {
    // Diagnostics are deliberately fail-open so the original screen can recover.
  }
}

let globalReportingInstalled = false

export function installGlobalErrorReporting(): void {
  if (globalReportingInstalled) return
  globalReportingInstalled = true
  window.addEventListener('error', (event) => {
    const error =
      event.error ??
      new Error(
        `${event.message || 'Unknown renderer error'}${event.filename ? ` at ${event.filename}:${event.lineno}` : ''}`,
      )
    reportRendererError('window-error', error, { scope: 'window' })
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportRendererError('unhandled-rejection', event.reason, { scope: 'window' })
  })
}
