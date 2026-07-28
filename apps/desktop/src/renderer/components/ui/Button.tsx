import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'primary' | 'outline' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'icon'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const variants: Record<Variant, string> = {
  primary: 'bg-accent-fill text-accent-fg hover:bg-accent-hi shadow-hard tactile disabled:opacity-50',
  outline:
    'border border-border-strong bg-surface hover:bg-surface-2 text-text shadow-hard tactile disabled:opacity-50',
  ghost: 'hover:bg-surface-2 text-text tap disabled:opacity-50',
  danger: 'bg-alarm text-white hover:opacity-90 shadow-hard tactile disabled:opacity-50',
}

const sizes: Record<Size, string> = {
  sm: 'h-10 px-3.5 text-sm gap-1.5',
  md: 'h-11 px-5 text-sm gap-2',
  icon: 'h-10 w-10 p-0 justify-center',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-[var(--radius)] font-medium select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
