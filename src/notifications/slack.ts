import type { DispatchEvent, NotificationResult } from './types.js';
import type { Logger } from '../types.js';

export async function sendSlackNotification(
  webhookUrl: string,
  event: DispatchEvent,
  logger?: Logger
): Promise<NotificationResult> {
  const timestamp = new Date().toISOString();
  
  const formatPayload = (evt: DispatchEvent): object => {
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
        const warnEmoji = data.threshold === '100%' ? '🚨' : '⚠️';
        return {
          text: `${warnEmoji} Budget Alert: ${data.threshold} threshold reached`,
          attachments: [{
            color: 'warning',
            fields: [
              { title: 'Model', value: String(data.model ?? 'global'), short: true },
              { title: 'Spent', value: `$${Number(data.spent ?? 0).toFixed(2)}`, short: true },
              { title: 'Limit', value: `$${Number(data.limit ?? 0).toFixed(2)}`, short: true },
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
              { title: 'Regressions', value: String(data.regressions ?? 'n/a'), short: false },
            ],
          }],
        };
      }
      
      default:
        return { text: JSON.stringify(data) };
    }
  };
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formatPayload(event)),
    });
    
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
