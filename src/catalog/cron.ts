import type { Logger } from '../types.js';
import { ensureFresh } from './cache.js';
import { refreshIntervalMs } from './sync.js';

const SOURCES = ['models.dev', 'modelbench', 'zeroeval'] as const;

let timer: NodeJS.Timeout | null = null;

export function getRefreshIntervalMs(): number {
  return refreshIntervalMs();
}

export function startCatalogCron(logger?: Logger): void {
  if (timer) return;
  const intervalMs = getRefreshIntervalMs();
  timer = setInterval(async () => {
    for (const source of SOURCES) {
      try {
        await ensureFresh(source);
      } catch (err) {
        logger?.error('catalog cron refresh failed', { source, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }, intervalMs);
  logger?.info('catalog cron started', { intervalMs });
}

export function stopCatalogCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
