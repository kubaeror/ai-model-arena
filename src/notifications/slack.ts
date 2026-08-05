import type { DispatchEvent, NotificationResult } from './types.js';
import type { Logger } from '../types.js';
import { postWithRetry } from './retry.js';

function regressionSummary(data: Record<string, unknown>): string {
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

export function formatSlackPayload(evt: DispatchEvent): object {
    const { type, data } = evt;
    
    switch (type) {
      case 'onRunCompleted': {
        const statusEmoji = data.status === 'started' ? '🚀' : data.status === 'success' ? '✅' : '❌';
        return {
          text: `${statusEmoji} Run ${data.status}`,
          attachments: [{
            color: data.status === 'success' ? 'good' : data.status === 'started' ? '#36a64f' : 'danger',
            fields: [
              { title: 'Run ID', value: String(data.runId ?? 'n/a'), short: true },
              { title: 'Scenario', value: String(data.scenario ?? 'n/a'), short: true },
              { title: 'Models', value: (data.models as string[])?.join(', ') ?? 'n/a', short: false },
            ],
          }],
        };
      }
      
      case 'onBudgetThreshold': {
        const percentUsed = Number(data.percentUsed ?? 0);
        const spent = Number(data.spentUsd ?? data.spent ?? 0);
        const limit = Number(data.limitUsd ?? data.limit ?? 0);
        const warnEmoji = percentUsed >= 100 ? '🚨' : '⚠️';
        const thresholdLabel = data.threshold != null ? String(data.threshold) : `${Math.min(percentUsed, 100)}%`;
        return {
          text: `${warnEmoji} Budget Alert: ${thresholdLabel} threshold reached`,
          attachments: [{
            color: 'warning',
            fields: [
              { title: 'Model', value: String(data.model ?? 'global'), short: true },
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
              { title: 'Type', value: String(data.type ?? 'n/a'), short: true },
              { title: 'Severity', value: String(data.severity ?? 'n/a'), short: true },
              { title: 'Model', value: String(data.model ?? 'n/a'), short: true },
              { title: 'Run', value: String(data.runId ?? 'n/a'), short: false },
              { title: 'Description', value: String(data.description ?? 'n/a'), short: false },
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
              { title: 'Suite', value: String(data.suite ?? 'n/a'), short: true },
              { title: 'Model', value: String(data.model ?? 'n/a'), short: true },
              { title: 'Regressions', value: regressionSummary(data), short: false },
            ],
          }],
        };
      }
      
      default:
        return { text: JSON.stringify(data) };
    }
  }

export async function sendSlackNotification(
  webhookUrl: string,
  event: DispatchEvent,
  logger?: Logger
): Promise<NotificationResult> {
  const timestamp = new Date().toISOString();
  
  try {
    const response = await postWithRetry(webhookUrl, JSON.stringify(formatSlackPayload(event)), {}, logger);
    
    if (!response.ok) {
      const text = await response.text();
      return { channel: 'slack', success: false, error: text, timestamp };
    }
    
    logger?.debug('Slack notification sent', { type: event.type });
    return { channel: 'slack', success: true, timestamp };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger?.error('Failed to send Slack notification', { error });
    return { channel: 'slack', success: false, error, timestamp };
  }
}
