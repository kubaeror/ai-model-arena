import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';
import type { SendOpts } from './providers/adapters/base.js';

// ── Schemas ────────────────────────────────────────────────────────────────

export const SuccessCriteriaSchema = z.object({
  command: z.string().optional(),
  expectedExitCode: z.number().int().default(0),
  expectedOutputContains: z.string().optional(),
});

export const ReasoningConfigSchema = z.object({
  effort: z.enum(['low', 'medium', 'high']).optional(),
  toggle: z.boolean().optional(),
  budget_tokens: z.number().int().positive().optional(),
});
export type ReasoningConfig = z.infer<typeof ReasoningConfigSchema>;

/**
 * Convert the user-friendly scenario reasoning config to the adapter-level
 * discriminated union. Only one option is expected in practice; if multiple
 * are set the precedence is: effort > budget_tokens > toggle. `toggle` is
 * presence-based (any defined value enables provider reasoning, matching the
 * adapters' behavior from T17). Returns undefined when nothing is configured.
 */
export function toSendOptsReasoning(cfg: ReasoningConfig | undefined): SendOpts['reasoning'] {
  if (!cfg) return undefined;
  if (cfg.effort !== undefined) return { type: 'effort', value: cfg.effort };
  if (cfg.budget_tokens !== undefined) return { type: 'budget_tokens', value: cfg.budget_tokens };
  if (cfg.toggle !== undefined) return { type: 'toggle', value: undefined };
  return undefined;
}

export const ScenarioConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  systemPrompt: z.string().min(1),
  task: z.string().min(1),
  starterFiles: z.string().optional(),
  successCriteria: SuccessCriteriaSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  shellTimeoutMs: z.number().int().positive().default(30000),
  shellPolicy: z.enum(['strict', 'permissive']).default('strict'),
  maxShellOutputBytes: z.number().int().positive().default(524288), // 512 KB
  webAccess: z.boolean().default(false),
  reasoning: ReasoningConfigSchema.optional(),
  executionProfile: z.enum([
    'read-only-analysis',
    'code-generation',
    'test-runner',
    'networked-research',
    'artifact-validation',
    'restricted-production-support',
  ]).default('read-only-analysis'),
});
export type ScenarioConfig = z.output<typeof ScenarioConfigSchema>;

// ── Loaders ─────────────────────────────────────────────────────────────────

function readYaml(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return load(raw);
}

export function loadScenario(filePath: string): ScenarioConfig {
  return ScenarioConfigSchema.parse(readYaml(filePath));
}

/** Resolve a scenario by bare name ("express-rest") or explicit yaml path. */
export function resolveScenarioPath(scenariosDir: string, name: string): string {
  if (name.endsWith('.yaml') || name.endsWith('.yml')) {
    return path.isAbsolute(name) ? name : path.resolve(scenariosDir, name);
  }
  return path.join(scenariosDir, `${name}.yaml`);
}
