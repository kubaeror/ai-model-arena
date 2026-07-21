import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';

// ── Schemas ────────────────────────────────────────────────────────────────

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
  shellPolicy: z.enum(['strict', 'permissive']).default('strict'),
  maxShellOutputBytes: z.number().int().positive().default(524288), // 512 KB
});
export type ScenarioConfig = z.infer<typeof ScenarioConfigSchema>;

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
