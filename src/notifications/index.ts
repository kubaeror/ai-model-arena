import path from 'node:path';
import type { Logger } from '../types.js';
import { loadYamlConfigSync } from '../config-loader.js';
import type { NotificationConfig, NotificationResult, DispatchEvent } from './types.js';
import { NotificationConfigSchema, DispatchEventType } from './types.js';
import { sendSlackNotification } from './slack.js';
import { sendDiscordNotification } from './discord.js';

let notificationConfig: NotificationConfig | null = null;

export function loadNotificationConfig(configPath: string, logger?: Logger): NotificationConfig {
  if (notificationConfig) return notificationConfig;

  notificationConfig = loadYamlConfigSync({
    filePath: configPath,
    schema: NotificationConfigSchema,
    fallback: NotificationConfigSchema.parse({ channels: {} }),
    expandEnv: true,
    cache: true,
    logger,
    missingMessage: `Notification config not found at ${path.resolve(configPath)}, notifications disabled`,
  });
  return notificationConfig;
}

function getChannel(name: string): { type: string; webhookUrl: string } | null {
  if (!notificationConfig) return null;
  const channel = notificationConfig.channels[name];
  if (!channel) return null;
  return { type: channel.type, webhookUrl: channel.webhookUrl };
}

function getRoutingForEvent(eventType: DispatchEventType): string[] {
  if (!notificationConfig?.routing) return [];
  return notificationConfig.routing[eventType] ?? [];
}

export async function sendNotification(
  channelName: string,
  event: DispatchEvent,
  logger?: Logger
): Promise<NotificationResult> {
  const channel = getChannel(channelName);
  if (!channel) {
    return {
      channel: channelName,
      success: false,
      error: `Channel "${channelName}" not found`,
      timestamp: new Date().toISOString(),
    };
  }
  
  switch (channel.type) {
    case 'slack':
      return sendSlackNotification(channel.webhookUrl, event, logger);
    case 'discord':
      return sendDiscordNotification(channel.webhookUrl, event, logger);
    default:
      return {
        channel: channelName,
        success: false,
        error: `Unknown channel type: ${channel.type}`,
        timestamp: new Date().toISOString(),
      };
  }
}

export async function dispatchNotification(
  event: DispatchEvent,
  logger?: Logger
): Promise<NotificationResult[]> {
  const channelNames = getRoutingForEvent(event.type);
  if (channelNames.length === 0) {
    return [];
  }

  // Delivery outbox (F10): every dispatch is persisted first, then an
  // immediate best-effort send is attempted through deliverDueNotifications
  // (which picks up the just-persisted row because next_attempt_at is null).
  // Failed rows stay pending and the dashboard's 30s loop retries them with
  // exponential backoff. Per-channel failures (persist or send) never throw
  // out of dispatchNotification — they surface as failed NotificationResults.
  const { persistNotification, deliverDueNotifications, getNotificationById } = await import('./outbox.js');
  const results: NotificationResult[] = [];
  for (const channelName of channelNames) {
    try {
      const id = await persistNotification(event, channelName);
      await deliverDueNotifications(logger, async (ch, ev) => sendNotification(ch, ev, logger));
      const row = await getNotificationById(id);
      results.push({
        channel: channelName,
        success: row?.status === 'delivered',
        error: row?.lastError ?? undefined,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      results.push({
        channel: channelName,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  }

  return results;
}

export { DispatchEventType };
export { dispatchWebhooks } from './webhooks.js';
