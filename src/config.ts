import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ── Schemas ────────────────────────────────────────────────────────────────

const RetrySchema = z.object({
  maxRetries: z.number().int().min(0).default(3),
  initialDelayMs: z.number().min(0).default(1000),
  maxDelayMs: z.number().min(0).default(30000),
});

export const ModelConfigSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(['openai', 'anthropic', 'google', 'ollama', 'openai-compatible']),
  model: z.string().min(1),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().url().optional(),
  maxTurns: z.number().int().positive().default(20),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().default(4096),
  retry: RetrySchema.optional().default({}),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ModelsFileSchema = z.object({
  models: z.array(ModelConfigSchema).min(1),
});
export type ModelsFile = z.infer<typeof ModelsFileSchema>;

export const SuccessCriteriaSchema = z.object({
  command: z.string().optional(),
  expectedExitCode: z.number().int().default(0),
  expectedOutputContains: z.string().optional(),
});
export type SuccessCriteria = z.infer<typeof SuccessCriteriaSchema>;

export const ScenarioConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  systemPrompt: z.string().min(1),
  task: z.string().min(1),
  starterFiles: z.string().optional(),
  successCriteria: SuccessCriteriaSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  shellTimeoutMs: z.number().int().positive().default(30000),
  maxShellOutputBytes: z.number().int().positive().default(524288), // 512 KB
});
export type ScenarioConfig = z.infer<typeof ScenarioConfigSchema>;

// ── Loaders ─────────────────────────────────────────────────────────────────

function readYaml(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return yaml.load(raw);
}

export function loadModelsConfig(filePath: string): ModelsFile {
  const parsed = ModelsFileSchema.parse(readYaml(filePath));
  // Enforce unique names.
  const names = parsed.models.map((m) => m.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`Duplicate model name "${dup}" in ${filePath}.`);
  return parsed;
}

export function loadScenario(filePath: string): ScenarioConfig {
  return ScenarioConfigSchema.parse(readYaml(filePath));
}

export function findModel(models: ModelConfig[], name: string): ModelConfig {
  const m = models.find((x) => x.name === name);
  if (!m) {
    throw new Error(
      `Model "${name}" not found in config. Known models: ${models.map((x) => x.name).join(', ')}`,
    );
  }
  return m;
}

/** Resolve a scenario by bare name ("express-rest") or explicit yaml path. */
export function resolveScenarioPath(scenariosDir: string, name: string): string {
  if (name.endsWith('.yaml') || name.endsWith('.yml')) {
    return path.isAbsolute(name) ? name : path.resolve(scenariosDir, name);
  }
  return path.join(scenariosDir, `${name}.yaml`);
}
