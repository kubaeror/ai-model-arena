import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface PanelProps {
  children: ReactNode;
  className?: string;
}

export function Panel({ children, className }: PanelProps) {
  return (
    <section className={cn('rounded-panel border border-border bg-bg-1 p-16', className)}>
      {children}
    </section>
  );
}

interface PanelHeaderProps {
  title?: string;
  actions?: ReactNode;
  className?: string;
}

export function PanelHeader({ title, actions, className }: PanelHeaderProps) {
  return (
    <header className={cn('flex items-center justify-between border-b border-border pb-12 mb-16', className)}>
      {title && <h2 className="font-display text-20 font-600">{title}</h2>}
      {actions && <div className="flex gap-8">{actions}</div>}
    </header>
  );
}

interface PanelBodyProps {
  children: ReactNode;
  className?: string;
}

export function PanelBody({ children, className }: PanelBodyProps) {
  return <div className={cn('', className)}>{children}</div>;
}
