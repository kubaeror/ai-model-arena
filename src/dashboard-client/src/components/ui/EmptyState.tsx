import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-12 py-48 text-center">
      <p className="font-display text-20 text-fg-1">{title}</p>
      {description && <p className="font-body text-14 text-fg-1 max-w-65ch">{description}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}
