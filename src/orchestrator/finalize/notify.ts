import path from 'node:path';
import type { Logger } from '../../types.js';
import type { RunIndexRecord } from '../run-index.js';

/**
 * Notifications + webhooks: single dispatch point for run completion.
 * Never throws — failures are swallowed (non-blocking).
 */
export async function notifyRunCompleted(
  root: string,
  runId: string,
  rec: RunIndexRecord,
  allSuccess: boolean,
  logger: Logger,
): Promise<void> {
  try {
    const { loadNotificationConfig, dispatchNotification, dispatchWebhooks, DispatchEventType } = await import('../../notifications/index.js');
    loadNotificationConfig(path.join(root, 'configs', 'notifications.yaml'), logger);
    const data = { runId, scenario: rec.scenario, models: rec.perModel.map((m) => m.model), status: allSuccess ? 'success' : 'failed' };
    await dispatchNotification({ type: DispatchEventType.onRunCompleted, data, timestamp: new Date().toISOString() }, logger);
    await dispatchWebhooks('run_completed', data, logger);
  } catch { /* non-blocking */ }
}
