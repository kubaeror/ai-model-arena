import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Panel } from './Panel';

interface StatTileProps {
  value: ReactNode;
  label: string;
  className?: string;
}

export function StatTile({ value, label, className }: StatTileProps) {
  return (
    <Panel className={cn('flex flex-col gap-2', className)}>
      <span className="font-display text-44 font-600 text-fg-0" data-numeric>{value}</span>
      <span className="font-body text-14 text-fg-1 uppercase">{label}</span>
    </Panel>
  );
}
