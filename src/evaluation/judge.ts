import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Logger } from '../types.js';
import type { ModelConfig } from '../config.js';
import { createAdapter } from '../adapters/index.js';
import type { EvaluationConfig, JudgeResult, JudgeScore, Rubric } from './types.js';
import { EvaluationConfigSchema } from './types.js';

let evalConfig: EvaluationConfig | null = null;

export function loadEvaluationConfig(configPath: string, logger?: Logger): EvaluationConfig {
  if (evalConfig) return evalConfig;
  
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    const fallback = EvaluationConfigSchema.parse({});
    logger?.warn(`Evaluation config not found at ${resolvedPath}, using defaults`);
    evalConfig = fallback;
    return fallback;
  }
  
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = yaml.load(content);
  const validated = EvaluationConfigSchema.parse(parsed);
  evalConfig = validated;
  return validated;
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
  modelConfig: ModelConfig,
  config: EvaluationConfig,
  logger?: Logger
): Promise<JudgeResult | null> {
  const judgeConfig = config.judge;
  if (!judgeConfig?.enabled) return null;

  const adapter = createAdapter(modelConfig, logger?.child('judge'));
  
  const prompt = buildJudgePrompt(config.rubric, task, files);
  
  try {
    const response = await adapter.sendMessage(
      [{ role: 'user', content: prompt }],
      []
    );
    
    const text = response.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger?.warn('Judge response did not contain valid JSON');
      return null;
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    const scores: JudgeScore[] = parsed.scores ?? [];
    const averageScore = scores.reduce((sum: number, s: JudgeScore) => sum + s.score, 0) / Math.max(scores.length, 1);
    
    const result: JudgeResult = {
      model,
      runId,
      scores,
      averageScore,
      summary: parsed.summary ?? 'No summary provided',
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
