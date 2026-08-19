import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Shared form control styling (inputs, selects, textareas). */
export const fieldCls =
  'min-h-11 w-full rounded-[var(--radius)] border border-border bg-bg px-3 py-2 t-body text-text outline-none transition-[box-shadow,border-color] duration-150 ease-out focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/60'
