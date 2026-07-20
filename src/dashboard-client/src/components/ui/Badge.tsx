import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-inner px-8 py-4 font-mono text-12 font-500 uppercase',
  {
    variants: {
      variant: {
        tier: '',
        status: '',
        provider: '',
        reasoning: '',
      },
    },
    defaultVariants: { variant: 'tier' },
  },
);

function tierClass(value: string): string {
  if (value === 'S+') return 'text-accent border border-accent';
  if (value === 'S') return 'text-accent border border-accent';
  if (value.startsWith('A')) return 'text-info border border-info';
  if (value.startsWith('B') || value.startsWith('C')) return 'text-fg-1 border border-border';
  return 'text-fg-1 border border-border';
}

function statusClass(value: string): string {
  if (value === 'deprecated') return 'text-danger border border-danger';
  if (value === 'beta') return 'text-warn border border-warn';
  if (value === 'alpha') return 'text-fg-1 border border-border';
  return 'text-fg-1 border border-border';
}

export interface BadgeProps
  extends VariantProps<typeof badgeVariants> {
  value: string;
  className?: string;
}

export function Badge({ variant = 'tier', value, className }: BadgeProps) {
  const colorClass = variant === 'tier' ? tierClass(value)
    : variant === 'status' ? statusClass(value)
    : variant === 'provider' ? 'text-info border border-info'
    : 'text-accent border border-accent';
  return (
    <span className={cn(badgeVariants({ variant }), colorClass, className)}>
      {value}
    </span>
  );
}
