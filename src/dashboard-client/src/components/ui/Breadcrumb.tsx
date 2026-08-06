import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
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
