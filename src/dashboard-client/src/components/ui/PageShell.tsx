import { useEffect, type ReactNode } from 'react';
import { Breadcrumb, type BreadcrumbItem } from './Breadcrumb';
import { Skeleton } from './Skeleton';
import { cn } from '../../lib/cn';

interface PageShellProps {
  title: string;
  description?: string;
  breadcrumbs?: BreadcrumbItem[];
  actions?: ReactNode;
  children?: ReactNode;
  loading?: boolean;
  className?: string;
}

export function PageShell({
  title,
  description,
  breadcrumbs,
  actions,
  children,
  loading,
  className,
}: PageShellProps) {
  useEffect(() => {
    document.title = `${title} — AI Model Arena`;
  }, [title]);

  if (loading) return <PageShellSkeleton breadcrumbs={breadcrumbs} />;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb items={breadcrumbs} />
      )}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-28 font-600">{title}</h1>
          {description && (
            <p className="font-body text-14 text-fg-1">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2">{actions}</div>
        )}
      </div>
      {children}
    </div>
  );
}

function PageShellSkeleton({ breadcrumbs }: { breadcrumbs?: BreadcrumbItem[] }) {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <div className="flex items-center gap-1">
          {breadcrumbs.map((_, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-fg-1 text-12">/</span>}
              <Skeleton className="h-3 w-16" />
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-56" />
      </div>
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-panel" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-panel" />
    </div>
  );
}
