import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface FieldProps {
  label: string;
  children: ReactNode;
  error?: string;
  hint?: string;
  className?: string;
}

export function Field({ label, children, error, hint, className }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="font-body text-12 text-fg-1 uppercase">{label}</span>
      {children}
      {hint && !error && <span className="font-body text-11 text-fg-1">{hint}</span>}
      {error && <span className="font-body text-11 text-danger">{error}</span>}
    </div>
  );
}
