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
