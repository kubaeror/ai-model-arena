import type { ReactNode } from 'react';
import { useRouteBreadcrumbs, Breadcrumb } from './Breadcrumb';
import { cn } from '../../lib/cn';

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, children, className }: PageHeaderProps) {
  const breadcrumbs = useRouteBreadcrumbs();

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {breadcrumbs.length > 1 && <Breadcrumb items={breadcrumbs} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-28 font-600 md:text-44 md:font-700">{title}</h1>
          {description && <p className="font-body text-14 text-fg-1 mt-1">{description}</p>}
        </div>
        {children && <div className="flex items-center gap-2">{children}</div>}
      </div>
    </div>
  );
}
