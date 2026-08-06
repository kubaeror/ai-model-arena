import type { ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-inner px-2 py-1 font-mono text-12 font-500 uppercase',
  {
    variants: {
      variant: {
        tier: 'text-accent border border-accent',
        status: 'text-fg-1 border border-border',
        provider: 'text-info border border-info',
        reasoning: 'text-accent border border-accent',
        success: 'text-accent border border-accent',
        failure: 'text-danger border border-danger',
        neutral: 'text-fg-1 border border-border',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

type BadgeVariant = 'tier' | 'status' | 'provider' | 'reasoning' | 'success' | 'failure' | 'neutral';

function variantFromValue(variant: BadgeVariant, value: string): BadgeVariant {
  if (variant === 'tier') {
    if (value === 'S+' || value === 'S' || value === 'PASS') return 'tier';
    if (value.startsWith('A') || value === 'pass') return 'provider';
    if (value.startsWith('B') || value.startsWith('C')) return 'neutral';
    if (value === 'FAIL' || value === 'fail' || value === 'errored') return 'failure';
    return 'neutral';
  }
  if (variant === 'status') {
    if (value === 'deprecated' || value === 'error') return 'failure';
    if (value === 'beta') return 'tier';
    if (value === 'alpha') return 'neutral';
    if (value === 'reachable' || value === 'running') return 'success';
    if (value === 'unreachable') return 'failure';
    if (value === 'INACTIVE' || value === 'idle') return 'neutral';
    return 'neutral';
  }
  return variant;
}

interface BadgeProps {
  children?: ReactNode;
  value?: string;
  variant?: BadgeVariant;
  className?: string;
}

export function Badge({ variant = 'neutral', value, children, className }: BadgeProps) {
  const display = value ?? (typeof children === 'string' ? children : '');
  const resolved = variantFromValue(variant, display);
  return (
    <span className={cn(badgeVariants({ variant: resolved }), className)}>
      {children ?? value}
    </span>
  );
}
