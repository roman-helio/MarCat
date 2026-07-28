/** Whole days from today (local) until an ISO date (YYYY-MM-DD). Negative = past. */
export function daysUntil(isoDate: string): number {
  const target = new Date(isoDate + 'T00:00:00')
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target.getTime() - startToday.getTime()) / 86_400_000)
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function isOverdue(dueDate?: string | null): boolean {
  return !!dueDate && dueDate < todayIso()
}
