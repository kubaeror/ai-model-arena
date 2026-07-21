import { useCacheStats } from '../hooks/useCache';
import { cn } from '../lib/cn';

export function CacheStatePill() {
  const { data, isLoading } = useCacheStats();
  if (isLoading || !data) {
    return <span className="font-mono text-12 text-fg-1">cache: …</span>;
  }
  const hasError = data.some(s => s.last_status === 'error');
  const allFresh = data.every(s => new Date(s.next_refresh).getTime() > Date.now());
  const status = hasError ? 'error' : allFresh ? 'fresh' : 'stale';
  const colorClass = status === 'error' ? 'text-danger border-danger' : status === 'stale' ? 'text-warn border-warn' : 'text-accent border-accent';
  const label = status === 'error' ? 'cache error' : `cache: ${data.length} sources`;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-inner border px-2 py-1 font-mono text-12', colorClass)}>
      {label}
    </span>
  );
}
