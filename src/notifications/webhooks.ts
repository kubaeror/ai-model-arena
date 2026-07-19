import crypto from 'node:crypto';
import { webhooksForEvent, getWebhookSecret } from '../anomaly-detection/db.js';
import type { Logger } from '../types.js';

/**
 * Webhook delivery for external systems that registered a URL via the API
 * (POST /api/webhooks). Decouples event notification from the hardcoded
 * Slack/Discord channels: any registered webhook receives a signed POST for
 * the events it subscribed to.
 *
 * Events: run_completed, anomaly_detected, budget_exceeded.
 */
export type WebhookEvent = 'run_completed' | 'anomaly_detected' | 'budget_exceeded';

export async function dispatchWebhooks(event: WebhookEvent, payload: unknown, logger?: Logger): Promise<void> {
  let hooks;
  try {
    hooks = webhooksForEvent(event);
  } catch {
    return; // DB unavailable — fail silently, never block runs.
  }
  if (hooks.length === 0) return;
  const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload });
  await Promise.allSettled(
    hooks.map(async (h) => {
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        const secret = getWebhookSecret(h.id);
        if (secret) {
          const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
          headers['x-arena-signature'] = `sha256=${sig}`;
        }
        const res = await fetch(h.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          logger?.warn('Webhook delivery failed', { url: h.url, event, status: res.status });
        } else {
          logger?.debug('Webhook delivered', { url: h.url, event });
        }
      } catch (err) {
        logger?.warn('Webhook delivery error', {
          url: h.url,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
