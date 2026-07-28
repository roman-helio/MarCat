export interface SqliteBusyRetryOptions {
  attempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current = error
  for (let depth = 0; current != null && depth < 12; depth += 1) {
    chain.push(current)
    current = typeof current === 'object' && 'cause' in current ? (current as { cause?: unknown }).cause : undefined
  }
  return chain
}

/** SQLite exposes lock failures through several nested driver error shapes. */
export function isSqliteBusy(error: unknown): boolean {
  return errorChain(error).some((entry) => {
    const code = typeof entry === 'object' && entry && 'code' in entry ? String(entry.code) : ''
    const message = entry instanceof Error ? entry.message : String(entry)
    return (
      code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /SQLITE_(?:BUSY|LOCKED)|database is locked/i.test(message)
    )
  })
}

/**
 * Retry one atomic/idempotent SQLite operation after transient writer contention.
 * Callers must not wrap a non-idempotent sequence that can partially commit.
 */
export async function withSqliteBusyRetry<T>(
  operation: () => Promise<T>,
  options: SqliteBusyRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 5)
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 50)
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 800)
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isSqliteBusy(error) || attempt === attempts - 1) throw error
      const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt) + Math.floor(Math.random() * 25)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}
