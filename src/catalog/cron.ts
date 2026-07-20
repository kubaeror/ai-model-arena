import type { Logger } from '../types.js';
import { ensureFresh } from './cache.js';

const REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const SOURCES = ['models.dev', 'modelbench', 'zeroeval'] as const;

let timer: NodeJS.Timeout | null = null;

export function startCatalogCron(logger?: Logger): void {
  if (timer) return;
  timer = setInterval(async () => {
    for (const source of SOURCES) {
      try {
        await ensureFresh(source);
      } catch (err) {
        logger?.error('catalog cron refresh failed', { source, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }, REFRESH_INTERVAL_MS);
  logger?.info('catalog cron started', { intervalMs: REFRESH_INTERVAL_MS });
}

export function stopCatalogCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
