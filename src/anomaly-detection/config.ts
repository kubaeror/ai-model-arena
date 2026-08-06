import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';
import { loadYamlConfigSync } from '../config-loader.js';
import { findProjectRoot } from '../paths.js';

/**
 * Anomaly-detection thresholds, loaded from
 * `configs/anomaly-detection.yaml`. Everything is a z-score (or multiple) so
 * the rules stay lightweight and explainable.
 */
const AnomalyTypeThresholdSchema = z.object({
  enabled: z.boolean().default(true),
  zScoreThreshold: z.number().min(1).default(3),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
});

export const AnomalyDetectionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  slidingWindow: z.number().int().min(3).default(20),
  minSampleSize: z.number().int().min(2).default(5),
  latency: AnomalyTypeThresholdSchema.default({
    enabled: true, zScoreThreshold: 3, severity: 'high',
  }),
  loop: z.object({
    enabled: z.boolean().default(true),
    consecutiveRepeats: z.number().int().min(2).default(3),
    severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  }).default({
    enabled: true, consecutiveRepeats: 3, severity: 'medium',
  }),
  tokenSpike: z.object({
    enabled: z.boolean().default(true),
    multiple: z.number().min(1).default(3),
    severity: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
  }).default({
    enabled: true, multiple: 3, severity: 'high',
  }),
  costSpike: z.object({
    enabled: z.boolean().default(true),
    multiple: z.number().min(1).default(3),
    severity: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
  }).default({
    enabled: true, multiple: 3, severity: 'high',
  }),
  errorRate: AnomalyTypeThresholdSchema.default({
    enabled: true, zScoreThreshold: 3, severity: 'high',
  }),
  silentFailure: z.object({
    enabled: z.boolean().default(true),
    lowJudgeScore: z.number().min(0).max(100).default(40),
    highJudgeScore: z.number().min(0).max(100).default(70),
    severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  }).default({
    enabled: true, lowJudgeScore: 40, highJudgeScore: 70, severity: 'medium',
  }),
});

export type AnomalyDetectionConfig = z.output<typeof AnomalyDetectionConfigSchema>;

let cached: AnomalyDetectionConfig | null = null;

function configPath(): string {
  return process.env.AI_ARENA_ANOMALY_CONFIG ?? path.join(findProjectRoot(), 'configs', 'anomaly-detection.yaml');
}

export function loadAnomalyConfig(): AnomalyDetectionConfig {
  if (cached) return cached;
  cached = loadYamlConfigSync({
    filePath: configPath(),
    schema: AnomalyDetectionConfigSchema,
    fallback: AnomalyDetectionConfigSchema.parse({}),
    cache: true,
  });
  return cached;
}
