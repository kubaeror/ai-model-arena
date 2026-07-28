import { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';

interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

/** Auto-generates breadcrumbs from the current path. Override with explicit items. */
export function useRouteBreadcrumbs(): BreadcrumbItem[] {
  const location = useLocation();
  return useMemo(() => {
    const segments = location.pathname.split('/').filter(Boolean);
    const items: BreadcrumbItem[] = [{ label: 'Home', to: '/' }];
    let path = '';
    for (const seg of segments) {
      path += `/${seg}`;
      const label = seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' ');
      items.push({ label, to: path });
    }
    return items;
  }, [location.pathname]);
}

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={cn('flex items-center gap-1', className)}>
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={12} className="text-fg-1" />}
          {item.to && i < items.length - 1 ? (
            <Link
              to={item.to}
              className="font-mono text-12 text-fg-1 hover:text-fg-0 transition-colors duration-80"
            >
              {item.label}
            </Link>
          ) : (
            <span className={cn(
              'font-mono text-12',
              i === items.length - 1 ? 'text-fg-0' : 'text-fg-1',
            )}>
              {item.label}
            </span>
          )}
        </div>
      ))}
    </nav>
  );
}
