import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import type { Logger } from '../types.js';
import type { NotificationConfig, NotificationResult, DispatchEvent } from './types.js';
import { NotificationConfigSchema, DispatchEventType } from './types.js';
import { sendSlackNotification } from './slack.js';
import { sendDiscordNotification } from './discord.js';

let notificationConfig: NotificationConfig | null = null;

function expandEnvVars(str: string): string {
  return str.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
}

export function loadNotificationConfig(configPath: string, logger?: Logger): NotificationConfig {
  if (notificationConfig) return notificationConfig;
  
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    const fallback = NotificationConfigSchema.parse({ channels: {} });
    logger?.warn(`Notification config not found at ${resolvedPath}, notifications disabled`);
    notificationConfig = fallback;
    return fallback;
  }
  
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const expanded = expandEnvVars(content);
  const parsed = load(expanded);
  const validated = NotificationConfigSchema.parse(parsed);
  notificationConfig = validated;
  return validated;
}

export function getChannel(name: string): { type: string; webhookUrl: string } | null {
  if (!notificationConfig) return null;
  const channel = notificationConfig.channels[name];
  if (!channel) return null;
  return { type: channel.type, webhookUrl: channel.webhookUrl };
}

export function getRoutingForEvent(eventType: DispatchEventType): string[] {
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
  
  const results: NotificationResult[] = [];
  const settled = await Promise.allSettled(
    channelNames.map((name) => sendNotification(name, event, logger)),
  );
  for (const outcome of settled) {
    results.push(
      outcome.status === 'fulfilled'
        ? outcome.value
        : { channel: 'unknown', success: false, error: String(outcome.reason), timestamp: new Date().toISOString() },
    );
  }
  
  return results;
}

export { DispatchEventType };
export * from './types.js';
export { dispatchWebhooks, type WebhookEvent } from './webhooks.js';
