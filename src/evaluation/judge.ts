import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../types.js';
import { loadYamlConfigSync } from '../config-loader.js';
import { resolveModelForRun } from '../db/model-resolver.js';
import { secretStore } from '../secrets/store.js';
import type { ModelAdapter } from '../providers/adapters/base.js';
import type { EvaluationConfig, JudgeResult, JudgeScore, Rubric } from './types.js';
import { EvaluationConfigSchema } from './types.js';

export function loadEvaluationConfig(configPath: string, logger?: Logger): EvaluationConfig {
  return loadYamlConfigSync({
    filePath: configPath,
    schema: EvaluationConfigSchema,
    fallback: EvaluationConfigSchema.parse({}),
    cache: false,
    logger,
    missingMessage: `Evaluation config not found at ${path.resolve(configPath)}, using defaults`,
  });
}

export function clampScore(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Resolve a judge model's API key via the secret store (k8s file mounts or .env). */
export function resolveJudgeApiKey(envVar: string): string | undefined {
  return secretStore.get(envVar);
}

/**
 * Extract the first JSON object from a model response.
 * Tries, in order: direct parse, fenced block (```json ... ```), balanced-brace
 * scan (handles trailing prose), then null when no valid JSON is present.
 */
export function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(candidate.trim());
  } catch { /* fall through */ }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Weighted average: Σ(score·maxScore)/Σ(maxScore). Falls back to a plain mean
 * when any score is missing a usable maxScore.
 */
export function computeAverageScore(scores: JudgeScore[]): number {
  if (scores.length === 0) return 0;
  const allWeighted = scores.every((s) => typeof s.maxScore === 'number' && s.maxScore > 0);
  if (allWeighted) {
    const weighted = scores.reduce((sum, s) => sum + s.score * s.maxScore!, 0);
    const weights = scores.reduce((sum, s) => sum + s.maxScore!, 0);
    return weighted / weights;
  }
  return scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
}

function buildJudgePrompt(rubric: Rubric | undefined, task: string, files: Record<string, string>): string {
  const rubricText = rubric
    ? Object.entries(rubric)
        .map(([key, item]) => `- ${key} (0-${item.maxScore}): ${item.description}`)
        .join('\n')
    : `- correctness (0-10): Code correctness
- fidelity (0-10): Instruction fidelity
- style (0-10): Code quality and style
- efficiency (0-10): Efficiency of approach`;

  const filesText = Object.entries(files)
    .slice(0, 10)
    .map(([name, content]) => `--- ${name} ---\n${content.slice(0, 2000)}`)
    .join('\n\n');

  return `You are an expert code reviewer evaluating an AI model's solution.

## Task
${task}

## Rubric
${rubricText}

## Generated Files
${filesText}

## Instructions
Score each rubric category from 0 to its maxScore. Provide a brief reasoning for each score.
Format your response as JSON:
{
  "scores": [
    {"category": "correctness", "score": 8, "maxScore": 10, "reasoning": "..."},
    ...
  ],
  "summary": "Overall assessment..."
}`;
}

export async function runJudgeScoring(
  model: string,
  runId: string,
  task: string,
  files: Record<string, string>,
  config: EvaluationConfig,
  logger?: Logger,
  adapter?: ModelAdapter
): Promise<JudgeResult | null> {
  const judgeConfig = config.judge;
  if (!judgeConfig?.enabled) return null;

  let llmAdapter = adapter;
  if (!llmAdapter) {
    const resolved = await resolveModelForRun(judgeConfig.model);
    if (!resolved) {
      logger?.warn('Judge model not found in catalog', { model: judgeConfig.model });
      return null;
    }
    const apiKey = resolved.envVar ? resolveJudgeApiKey(resolved.envVar) : undefined;
    const { ProviderRegistry, loadBuiltins } = await import('../providers/index.js');
    const registry = new ProviderRegistry();
    loadBuiltins(registry);
    await registry.loadCustomFromDb();
    llmAdapter = registry.createAdapter(resolved.providerId, resolved.apiModelId, { apiKey, logger: logger?.child('judge') });
  }

  const prompt = buildJudgePrompt(config.rubric, task, files);
  
  try {
    const response = await llmAdapter.sendMessage(
      [{ role: 'user', content: prompt }],
      []
    );
    
    const text = response.text ?? '';
    const parsed = extractJsonObject(text);
    if (!parsed) {
      logger?.warn('Judge response did not contain valid JSON');
      return null;
    }
    const json = parsed as { scores?: JudgeScore[]; summary?: string };
    const scores: JudgeScore[] = json.scores ?? [];
    const averageScore = clampScore(computeAverageScore(scores));

    const result: JudgeResult = {
      model,
      runId,
      scores,
      averageScore,
      summary: json.summary ?? 'No summary provided',
      judgedAt: new Date().toISOString(),
      judgeModel: judgeConfig.model,
    };

    return result;
  } catch (err) {
    logger?.error('Judge scoring failed', { error: String(err) });
    return null;
  }
}

export function writeJudgeResult(outputDir: string, result: JudgeResult, logger?: Logger): void {
  const outputPath = path.join(outputDir, 'judge_score.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  logger?.info('Wrote judge_score.json', { path: outputPath });
}

export function readJudgeResult(outputDir: string): JudgeResult | null {
  const filePath = path.join(outputDir, 'judge_score.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as JudgeResult;
  } catch {
    return null;
  }
}
