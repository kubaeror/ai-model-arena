import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Panel } from './Panel';

interface StatTileProps {
  value: ReactNode;
  label: string;
  sparkline?: ReactNode;
  className?: string;
}

export function StatTile({ value, label, sparkline, className }: StatTileProps) {
  return (
    <Panel className={cn('flex flex-col gap-8', className)}>
      <span className="font-display text-44 font-600 text-fg-0" data-numeric>{value}</span>
      <span className="font-body text-14 text-fg-1 uppercase">{label}</span>
      {sparkline && <div className="mt-8">{sparkline}</div>}
    </Panel>
  );
}
