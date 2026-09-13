import { cn } from '../../lib/cn';

interface MetricBarProps {
  value: number;
  min: number;
  max: number;
  label?: string;
  className?: string;
}

export function MetricBar({ value, min, max, label, className }: MetricBarProps) {
  const range = max - min || 1;
  const pct = Math.max(0, Math.min(100, ((value - min) / range) * 100));
  return (
    <div className={cn('flex items-center gap-3', className)}>
      {label && <span className="font-mono text-12 text-fg-1 w-80 truncate">{label}</span>}
      <div className="flex-1 h-2 rounded-inner bg-bg-2 overflow-hidden">
        <div className="h-full rounded-inner transition-all duration-150 ease-out-quart bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-14 text-fg-0 w-60 text-right" data-numeric>{value.toFixed(1)}</span>
    </div>
  );
}
