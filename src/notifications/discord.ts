import type { DispatchEvent, NotificationResult } from './types.js';
import type { Logger } from '../types.js';

function regressionSummary(data: Record<string, unknown>): string {
  const regressions = data.regressions;
  if (Array.isArray(regressions)) {
    return regressions.map((r) => {
      const x = r as { metric?: string; baseline?: number; current?: number };
      return `${x.metric}`;
    }).join(', ');
  }
  if (regressions == null) return 'n/a';
  return JSON.stringify(regressions);
}

export function formatDiscordPayload(evt: DispatchEvent): object {
    const { type, data } = evt;
    const toField = (name: string, value: string, inline: boolean = true) => ({ name, value, inline });
    
    let title = '';
    let description = '';
    let color = 0x000000;
    const fields: object[] = [];
    
    switch (type) {
      case 'onRunCompleted': {
        const status = String(data.status ?? 'unknown');
        title = `Run ${status}`;
        description = status === 'started' ? 'Scheduled run started' : `Run completed with status: ${status}`;
        color = status === 'success' ? 0x00ff00 : status === 'started' ? 0x36a64f : 0xff0000;
        fields.push(
          toField('Run ID', String(data.runId ?? 'n/a')),
          toField('Scenario', String(data.scenario ?? 'n/a')),
          { name: 'Models', value: (data.models as string[])?.join(', ') ?? 'n/a', inline: false }
        );
        break;
      }
      
      case 'onBudgetThreshold': {
        const percentUsed = Number(data.percentUsed ?? 0);
        const spent = Number(data.spentUsd ?? data.spent ?? 0);
        const limit = Number(data.limitUsd ?? data.limit ?? 0);
        const thresholdVal = data.threshold != null ? String(data.threshold) : `${Math.min(percentUsed, 100)}%`;
        title = 'Budget Alert';
        description = `${thresholdVal} threshold reached`;
        color = percentUsed >= 100 ? 0xff0000 : 0xffff00;
        fields.push(
          toField('Model', String(data.model ?? 'global')),
          toField('Spent', `$${spent.toFixed(2)}`),
          toField('Limit', `$${limit.toFixed(2)}`)
        );
        break;
      }
      
      case 'onAnomalyDetected': {
        title = 'Anomaly Detected';
        description = String(data.description ?? 'n/a');
        color = 0xffff00;
        fields.push(
          toField('Type', String(data.type ?? 'n/a')),
          toField('Severity', String(data.severity ?? 'n/a')),
          toField('Model', String(data.model ?? 'n/a')),
          { name: 'Run', value: String(data.runId ?? 'n/a'), inline: false },
          { name: 'Description', value: String(data.description ?? 'n/a'), inline: false }
        );
        break;
      }
      
      case 'onRegressionFailed': {
        title = 'Regression Test Failed';
        description = 'One or more regressions detected';
        color = 0xff0000;
        fields.push(
          toField('Suite', String(data.suite ?? 'n/a')),
          toField('Model', String(data.model ?? 'n/a')),
          { name: 'Regressions', value: regressionSummary(data), inline: false }
        );
        break;
      }
      
      default:
        title = 'Notification';
        description = JSON.stringify(data);
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
  const timestamp = new Date().toISOString();
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formatDiscordPayload(event)),
    });
    
    if (!response.ok) {
      const text = await response.text();
      return { channel: 'discord', success: false, error: text, timestamp };
    }
    
    logger?.debug('Discord notification sent', { type: event.type });
    return { channel: 'discord', success: true, timestamp };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger?.error('Failed to send Discord notification', { error });
    return { channel: 'discord', success: false, error, timestamp };
  }
}
