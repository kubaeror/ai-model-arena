import type { Logger } from '../../types.js';
import { analyzeRun } from '../../anomaly-detection/index.js';
import { writeRunStats } from '../../metrics/writeback.js';

let anomalyAnalysisFailures = 0;
let statsWritebackFailures = 0;

/** Run anomaly detection over a just-completed run (best-effort, non-blocking). */
export async function runAnomalyAnalysis(runId: string, logger: Logger): Promise<void> {
  try {
    await analyzeRun(runId, logger);
  } catch (e) {
    anomalyAnalysisFailures++;
    logger.warn('Anomaly analysis failed', { runId, error: e instanceof Error ? e.message : String(e), totalFailures: anomalyAnalysisFailures });
  }
}

/** Write per-model runtime stats back to the SQLite catalog (best-effort, non-fatal). */
export async function writebackRuntimeStats(runId: string, root: string, logger: Logger): Promise<void> {
  try {
    await writeRunStats(runId, root);
  } catch (e) {
    statsWritebackFailures++;
    logger.warn('writeRunStats failed (non-fatal)', { runId, err: e instanceof Error ? e.message : String(e), totalFailures: statsWritebackFailures });
  }
}
