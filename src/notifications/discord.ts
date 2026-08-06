import type { DispatchEvent, NotificationResult } from './types.js';
import type { Logger } from '../types.js';
import { normalizeEvent, regressionSummary, sendWebhook } from './format.js';

export function formatDiscordPayload(evt: DispatchEvent): object {
    const n = normalizeEvent(evt);
    const toField = (name: string, value: string, inline: boolean = true) => ({ name, value, inline });

    let title = '';
    let description = '';
    let color = 0x000000;
    const fields: object[] = [];

    switch (n.type) {
      case 'onRunCompleted': {
        const status = String(n.status ?? 'unknown');
        title = `Run ${status}`;
        description = status === 'started' ? 'Scheduled run started' : `Run completed with status: ${status}`;
        color = status === 'success' ? 0x00ff00 : status === 'started' ? 0x36a64f : 0xff0000;
        fields.push(
          toField('Run ID', String(n.runId ?? 'n/a')),
          toField('Scenario', String(n.scenario ?? 'n/a')),
          { name: 'Models', value: (n.models as string[])?.join(', ') ?? 'n/a', inline: false }
        );
        break;
      }

      case 'onBudgetThreshold': {
        const percentUsed = Number(n.percentUsed ?? 0);
        const spent = Number(n.spent ?? 0);
        const limit = Number(n.limit ?? 0);
        const thresholdVal = n.threshold != null ? String(n.threshold) : `${Math.min(percentUsed, 100)}%`;
        title = 'Budget Alert';
        description = `${thresholdVal} threshold reached`;
        color = percentUsed >= 100 ? 0xff0000 : 0xffff00;
        fields.push(
          toField('Model', String(n.model ?? 'global')),
          toField('Spent', `$${spent.toFixed(2)}`),
          toField('Limit', `$${limit.toFixed(2)}`)
        );
        break;
      }

      case 'onAnomalyDetected': {
        title = 'Anomaly Detected';
        description = String(n.description ?? 'n/a');
        color = 0xffff00;
        fields.push(
          toField('Type', String(n.anomalyType ?? 'n/a')),
          toField('Severity', String(n.severity ?? 'n/a')),
          toField('Model', String(n.model ?? 'n/a')),
          { name: 'Run', value: String(n.runId ?? 'n/a'), inline: false },
          { name: 'Description', value: String(n.description ?? 'n/a'), inline: false }
        );
        break;
      }

      case 'onRegressionFailed': {
        title = 'Regression Test Failed';
        description = 'One or more regressions detected';
        color = 0xff0000;
        fields.push(
          toField('Suite', String(n.suite ?? 'n/a')),
          toField('Model', String(n.model ?? 'n/a')),
          { name: 'Regressions', value: regressionSummary(n.extra), inline: false }
        );
        break;
      }

      default:
        title = 'Notification';
        description = JSON.stringify(n.extra);
    }

    return {
      embeds: [{
        title,
        description,
        color,
        fields,
        timestamp: evt.timestamp ?? new Date().toISOString(),
      }],
    };
  }

export async function sendDiscordNotification(
  webhookUrl: string,
  event: DispatchEvent,
  logger?: Logger
): Promise<NotificationResult> {
  return sendWebhook('discord', webhookUrl, formatDiscordPayload(event), event.type, logger);
}
