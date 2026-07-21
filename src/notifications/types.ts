import { z } from 'zod';

export type NotificationChannelType = 'slack' | 'discord';

export const NotificationChannelSchema = z.object({
  type: z.enum(['slack', 'discord']),
  webhookUrl: z.string(),
});

export const NotificationConfigSchema = z.object({
  channels: z.record(z.string(), NotificationChannelSchema),
  routing: z.record(z.string(), z.array(z.string())).optional(),
});

export type NotificationChannel = z.output<typeof NotificationChannelSchema>;
export type NotificationConfig = z.output<typeof NotificationConfigSchema>;

export enum DispatchEventType {
  onRunCompleted = 'onRunCompleted',
  onBudgetThreshold = 'onBudgetThreshold',
  onRegressionFailed = 'onRegressionFailed',
  onAnomalyDetected = 'onAnomalyDetected',
}

export interface DispatchEvent {
  type: DispatchEventType;
  data: Record<string, unknown>;
  timestamp?: string;
}

export interface NotificationResult {
  channel: string;
  success: boolean;
  error?: string;
  timestamp: string;
}
