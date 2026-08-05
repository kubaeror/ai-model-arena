import type { Logger } from '../types.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 500;

/**
 * POST with retry: transient 5xx responses and network errors are retried
 * (3 attempts total, 500ms backoff). Non-retryable responses and the final
 * attempt's response are returned as-is so callers can report the body.
 */
export async function postWithRetry(url: string, body: string, headers: Record<string, string> = {}, logger?: Logger): Promise<Response> {
  let lastRes: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      if (res.ok || res.status < 500) return res;
      lastRes = res;
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) {
      logger?.debug('Notification POST failed, retrying', { attempt, status: lastRes?.status });
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }
  if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  return lastRes!;
}
