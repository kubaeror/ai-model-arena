import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import type { Logger } from '../../types.js';
import type { RunIndexRecord } from '../run-index.js';
import type { ModelAdapter } from '../../providers/adapters/base.js';
import { runJudgeScoring, loadEvaluationConfig, writeJudgeResult } from '../../evaluation/judge.js';
import { insertJudgeScore } from '../../db/query.js';

/**
 * LLM judge scoring + persist judge_score.json (feeds silent_failure detector + regression baselines).
 * Never throws — failures are logged and swallowed (non-blocking, non-fatal).
 */
export async function runJudgeScoringPass(
  root: string,
  runId: string,
  rec: RunIndexRecord,
  logger: Logger,
  judgeAdapter?: ModelAdapter,
): Promise<void> {
  try {
    const evalCfg = loadEvaluationConfig(path.join(root, 'configs', 'evaluation.yaml'), logger);
    if (evalCfg.judge?.enabled) {
      for (const m of rec.perModel) {
        if (!fs.existsSync(m.resultPath)) continue;
        const scenarioPath = path.join(root, 'configs', 'scenarios', `${rec.scenario}.yaml`);
        const scenarioCfg = fs.existsSync(scenarioPath) ? (load(fs.readFileSync(scenarioPath, 'utf8')) as Record<string, unknown>) : null;
        const task = (scenarioCfg?.task as string) ?? '';
        const files: Record<string, string> = {};
        try {
          for (const f of fs.readdirSync(m.sandboxDir, { withFileTypes: true }).filter(e => e.isFile())) {
            files[f.name] = fs.readFileSync(path.join(m.sandboxDir, f.name), 'utf8').slice(0, 4000);
          }
        } catch { /* sandbox may not exist */ }
        const verdict = await runJudgeScoring(m.model, runId, task, files, evalCfg, logger, judgeAdapter);
        if (verdict) {
          writeJudgeResult(m.outputDir, verdict, logger);
          try {
            await insertJudgeScore({
              runId,
              model: m.model,
              judgeModel: verdict.judgeModel,
              averageScore: verdict.averageScore,
              summary: verdict.summary,
              scoresJson: JSON.stringify(verdict.scores),
              judgedAt: verdict.judgedAt,
            });
          } catch (e) {
            logger.warn('judge score DB persist failed (non-fatal)', { runId, err: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
  } catch (e) {
    logger.warn('judge scoring failed (non-fatal)', { runId, err: e instanceof Error ? e.message : String(e) });
  }
}
