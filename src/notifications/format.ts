import type { Logger } from '../types.js';
import type { DispatchEvent, NotificationResult } from './types.js';
import { postWithRetry } from './retry.js';

/**
 * Shared extraction of the event fields both channels render.
 *
 * Field mapping derived from the switch bodies in slack.ts / discord.ts:
 *   status, runId, scenario, models, model, percentUsed,
 *   spentUsd (fallback spent), limitUsd (fallback limit), threshold,
 *   type (anomaly kind), severity, description, suite.
 * Every other key (including `regressions`, consumed via regressionSummary)
 * is preserved in `extra`, a full shallow copy of the event data.
 */
export interface NormalizedEvent {
  type: string;
  status?: unknown;
  model?: unknown;
  runId?: unknown;
  scenario?: unknown;
  models?: unknown;
  spent?: unknown;
  limit?: unknown;
  percentUsed?: unknown;
  threshold?: unknown;
  anomalyType?: unknown;
  severity?: unknown;
  description?: unknown;
  suite?: unknown;
  extra: Record<string, unknown>;
}

export function normalizeEvent(event: DispatchEvent): NormalizedEvent {
  const data = event.data ?? {};
  return {
    type: event.type,
    status: data.status,
    model: data.model,
    runId: data.runId,
    scenario: data.scenario,
    models: data.models,
    spent: data.spentUsd ?? data.spent,
    limit: data.limitUsd ?? data.limit,
    percentUsed: data.percentUsed,
    threshold: data.threshold,
    anomalyType: data.type,
    severity: data.severity,
    description: data.description,
    suite: data.suite,
    extra: { ...data },
  };
}

/** Regression summary text (verbatim from the former slack.ts/discord.ts copies). */
export function regressionSummary(data: Record<string, unknown>): string {
  const regressions = data.regressions;
  if (Array.isArray(regressions)) {
    return regressions.map((r) => {
      const x = r as { metric?: string; baseline?: number; current?: number; threshold?: number };
      const parts = [`${x.metric}`];
      if (x.baseline != null) parts.push(`baseline=${x.baseline}`);
      if (x.current != null) parts.push(`current=${x.current}`);
      if (x.threshold != null) parts.push(`threshold=${x.threshold}`);
      return parts.join(' ');
    }).join(', ');
  }
  if (regressions == null) return 'n/a';
  return JSON.stringify(regressions);
}

/**
 * Shared webhook dispatch: POST the payload with retry and build a
 * NotificationResult. Identical in structure to the former
 * sendSlackNotification / sendDiscordNotification wrappers — the only
 * differences were channel name, payload formatter, and the log strings,
 * all derivable from the channel argument.
 */
export async function sendWebhook(
  channel: string,
  webhookUrl: string,
  payload: object,
  eventType: string,
  logger?: Logger
): Promise<NotificationResult> {
  const timestamp = new Date().toISOString();
  const channelLabel = channel.charAt(0).toUpperCase() + channel.slice(1);

  try {
    const response = await postWithRetry(webhookUrl, JSON.stringify(payload), {}, logger);

    if (!response.ok) {
      const text = await response.text();
      return { channel, success: false, error: text, timestamp };
    }

    logger?.debug(`${channelLabel} notification sent`, { type: eventType });
    return { channel, success: true, timestamp };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger?.error(`Failed to send ${channelLabel} notification`, { error });
    return { channel, success: false, error, timestamp };
  }
}
