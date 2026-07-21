import pino from 'pino';
import type { Logger } from '../types.js';

/**
 * Create a structured (JSON) logger backed by pino, writing to stdout.
 * PM2 captures the worker's stdout/stderr into per-run log files, so this
 * also satisfies the "structured logging with pino" requirement.
 */
export function createLogger(name: string, level?: string): Logger {
  const p = pino({
    name,
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    base: undefined, // drop default pid/hostname for cleaner diffs
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  });

  return {
    info: (msg, data) => p.info(data ?? {}, msg),
    warn: (msg, data) => p.warn(data ?? {}, msg),
    error: (msg, data) => p.error(data ?? {}, msg),
    debug: (msg, data) => p.debug(data ?? {}, msg),
    child: (childName) => createLogger(`${name}:${childName}`, level),
  };
}
