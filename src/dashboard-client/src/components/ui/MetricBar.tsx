import { cn } from '../../lib/cn';

interface MetricBarProps {
  value: number;
  min: number;
  max: number;
  label?: string;
  thresholds?: { warn: number; danger: number };
  className?: string;
}

export function MetricBar({ value, min, max, label, thresholds, className }: MetricBarProps) {
  const range = max - min || 1;
  const pct = Math.max(0, Math.min(100, ((value - min) / range) * 100));
  const colorClass = thresholds
    ? value >= thresholds.danger
      ? 'bg-danger'
      : value >= thresholds.warn
        ? 'bg-warn'
        : 'bg-accent'
    : 'bg-accent';
  return (
    <div className={cn('flex items-center gap-12', className)}>
      {label && <span className="font-mono text-12 text-fg-1 w-80 truncate">{label}</span>}
      <div className="flex-1 h-8 rounded-inner bg-bg-2 overflow-hidden">
        <div className={cn('h-full rounded-inner transition-all duration-150 ease-out-quart', colorClass)} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-14 text-fg-0 w-60 text-right" data-numeric>{value.toFixed(1)}</span>
    </div>
  );
}
