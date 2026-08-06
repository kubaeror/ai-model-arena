import type { CSSProperties } from 'react';
import { cn } from '../../lib/cn';

interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ className, style }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-inner bg-bg-2',
        className,
      )}
      style={style}
      aria-hidden="true"
    />
  );
}

/** @internal test support — not part of the public surface. */
export function SkeletonLine({ className }: { className?: string }) {
  return <Skeleton className={cn('h-4 w-full', className)} />;
}

/** @internal test support — not part of the public surface. */
export function SkeletonCard({ className }: { className?: string }) {
  return <Skeleton className={cn('h-32 rounded-panel', className)} />;
}

/** @internal test support — not part of the public surface. */
export function SkeletonRow({ columns = 4 }: { columns?: number }) {
  return (
    <div className="flex gap-3 p-3 border-b border-border/50">
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} className="h-4 flex-1" />
      ))}
    </div>
  );
}

/** @internal test support — not part of the public surface. */
export function SkeletonTable({ columns = 4, rows = 5 }: { columns?: number; rows?: number }) {
  return (
    <div className="overflow-hidden rounded-panel border border-border bg-bg-1">
      <div className="flex gap-3 p-3 border-b border-border">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-3 p-3 border-b border-border/50 last:border-0">
          {Array.from({ length: columns }).map((_, j) => (
            <Skeleton key={j} className="h-4" style={{ flex: j === 0 ? 2 : 1 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** @internal test support — not part of the public surface. */
export function SkeletonStats({ count = 3 }: { count?: number }) {
  return (
    <div className={`grid grid-cols-${Math.min(count, 4)} gap-4`}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-24 rounded-panel" />
      ))}
    </div>
  );
}
