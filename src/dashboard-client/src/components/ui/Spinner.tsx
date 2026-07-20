import { cn } from '../../lib/cn';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('inline-block h-16 w-16 animate-spin rounded-full border-2 border-border border-t-accent', className)}
    />
  );
}
