import type { DispatchEvent, NotificationResult } from './types.js';
import type { Logger } from '../types.js';
import { normalizeEvent, regressionSummary, sendWebhook } from './format.js';

export function formatSlackPayload(evt: DispatchEvent): object {
    const n = normalizeEvent(evt);

    switch (n.type) {
      case 'onRunCompleted': {
        const statusEmoji = n.status === 'started' ? '🚀' : n.status === 'success' ? '✅' : '❌';
        return {
          text: `${statusEmoji} Run ${n.status}`,
          attachments: [{
            color: n.status === 'success' ? 'good' : n.status === 'started' ? '#36a64f' : 'danger',
            fields: [
              { title: 'Run ID', value: String(n.runId ?? 'n/a'), short: true },
              { title: 'Scenario', value: String(n.scenario ?? 'n/a'), short: true },
              { title: 'Models', value: (n.models as string[])?.join(', ') ?? 'n/a', short: false },
            ],
          }],
        };
      }

      case 'onBudgetThreshold': {
        const percentUsed = Number(n.percentUsed ?? 0);
        const spent = Number(n.spent ?? 0);
        const limit = Number(n.limit ?? 0);
        const warnEmoji = percentUsed >= 100 ? '🚨' : '⚠️';
        const thresholdLabel = n.threshold != null ? String(n.threshold) : `${Math.min(percentUsed, 100)}%`;
        return {
          text: `${warnEmoji} Budget Alert: ${thresholdLabel} threshold reached`,
          attachments: [{
            color: 'warning',
            fields: [
              { title: 'Model', value: String(n.model ?? 'global'), short: true },
              { title: 'Spent', value: `$${spent.toFixed(2)}`, short: true },
              { title: 'Limit', value: `$${limit.toFixed(2)}`, short: true },
            ],
          }],
        };
      }

      case 'onAnomalyDetected': {
        return {
          text: '⚠️ Anomaly Detected',
          attachments: [{
            color: 'warning',
            fields: [
              { title: 'Type', value: String(n.anomalyType ?? 'n/a'), short: true },
              { title: 'Severity', value: String(n.severity ?? 'n/a'), short: true },
              { title: 'Model', value: String(n.model ?? 'n/a'), short: true },
              { title: 'Run', value: String(n.runId ?? 'n/a'), short: false },
              { title: 'Description', value: String(n.description ?? 'n/a'), short: false },
            ],
          }],
        };
      }

      case 'onRegressionFailed': {
        return {
          text: '🚨 Regression Test Failed',
          attachments: [{
            color: 'danger',
            fields: [
              { title: 'Suite', value: String(n.suite ?? 'n/a'), short: true },
              { title: 'Model', value: String(n.model ?? 'n/a'), short: true },
              { title: 'Regressions', value: regressionSummary(n.extra), short: false },
            ],
          }],
        };
      }

      default:
        return { text: JSON.stringify(n.extra) };
    }
  }

export async function sendSlackNotification(
  webhookUrl: string,
  event: DispatchEvent,
  logger?: Logger
): Promise<NotificationResult> {
  return sendWebhook('slack', webhookUrl, formatSlackPayload(event), event.type, logger);
}
