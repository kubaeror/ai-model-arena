import type { DispatchEvent, NotificationResult } from './types.js';
import type { Logger } from '../types.js';

export async function sendDiscordNotification(
  webhookUrl: string,
  event: DispatchEvent,
  logger?: Logger
): Promise<NotificationResult> {
  const timestamp = new Date().toISOString();
  
  const formatPayload = (evt: DispatchEvent): object => {
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
        const thresholdVal = String(data.threshold ?? '80%');
        title = 'Budget Alert';
        description = `${thresholdVal} threshold reached`;
        color = thresholdVal === '100%' ? 0xff0000 : 0xffff00;
        fields.push(
          toField('Model', String(data.model ?? 'global')),
          toField('Spent', `$${Number(data.spent ?? 0).toFixed(2)}`),
          toField('Limit', `$${Number(data.limit ?? 0).toFixed(2)}`)
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
          { name: 'Regressions', value: String(data.regressions ?? 'n/a'), inline: false }
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
        timestamp,
      }],
    };
  };
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formatPayload(event)),
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
