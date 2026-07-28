import { cn } from '../../lib/cn';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-inner bg-bg-2',
        className,
      )}
      aria-hidden="true"
    />
  );
}

export function SkeletonLine({ className }: { className?: string }) {
  return <Skeleton className={cn('h-4 w-full', className)} />;
}

export function SkeletonCard({ className }: { className?: string }) {
  return <Skeleton className={cn('h-32 rounded-panel', className)} />;
}

export function SkeletonRow({ columns = 4 }: { columns?: number }) {
  return (
    <div className="flex gap-3 p-3 border-b border-border/50">
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} className="h-4 flex-1" />
      ))}
    </div>
  );
}
