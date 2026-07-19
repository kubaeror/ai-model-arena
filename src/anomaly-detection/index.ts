import fs from 'node:fs';
import { createLogger } from '../logger/pino-logger.js';
import type { Logger } from '../types.js';
import { getRunRecord } from '../orchestrator/run-index.js';
import { readResultJson, type RunResult } from '../logger/result-logger.js';
import { readTraceMeta } from '../observability/trace-meta.js';
import { loadAnomalyConfig } from './config.js';
import { buildRunHistory, type RunHistory } from './baselines.js';
import {
  ALL_DETECTORS,
  extractToolCallsFromConversation,
  readJudgeScore,
  type RunAnalysisInput,
} from './detectors.js';
import { insertAnomaly, listAnomaliesForRun, type AnomalyRecord, type NewAnomaly } from './db.js';
import { dispatchNotification, dispatchWebhooks, DispatchEventType } from '../notifications/index.js';

const logger = createLogger('ai-arena:anomaly');

/**
 * Run anomaly detection for a completed run (across every model that
 * participated). Non-blocking-safe: every failure is caught and logged so it
 * never breaks run finalisation. Callers (orchestrator/dashboard watcher)
 * invoke this after a run is finalised.
 */
export async function analyzeRun(runId: string, externalLogger?: Logger): Promise<AnomalyRecord[]> {
  const log = externalLogger ?? logger;
  let cfg;
  try {
    cfg = loadAnomalyConfig();
  } catch (err) {
    log.warn('Failed to load anomaly config; skipping', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (!cfg.enabled) return [];

  const record = getRunRecord(runId);
  if (!record) {
    log.debug('No run record for anomaly analysis', { runId });
    return [];
  }

  const created: AnomalyRecord[] = [];
  for (const perModel of record.perModel) {
    const model = perModel.model;
    try {
      const result = readResultJsonSafe(perModel.resultPath);
      const trace = readTraceMeta(perModel.outputDir);
      const toolCalls = extractToolCallsFromConversation(perModel.conversationPath);
      const judgeScore = readJudgeScore(perModel.outputDir);

      const input: RunAnalysisInput = {
        runId,
        model,
        scenario: record.scenario,
        outputDir: perModel.outputDir,
        result,
        trace,
        toolCalls,
        judgeScore,
      };

      let history: RunHistory;
      try {
        history = buildRunHistory(model, record.scenario, cfg.slidingWindow, runId);
      } catch (err) {
        log.warn('Failed to build run history', { runId, model, error: err instanceof Error ? err.message : String(err) });
        history = { toolLatency: new Map(), tokenTotals: new Map(), costs: new Map(), toolErrorRates: new Map(), durations: new Map() };
      }

      const anomalies: NewAnomaly[] = [];
      for (const detector of ALL_DETECTORS) {
        try {
          const found = detector(input, cfg, history);
          anomalies.push(...found);
        } catch (err) {
          log.warn('Detector threw', { runId, model, error: err instanceof Error ? err.message : String(err) });
        }
      }

      for (const a of anomalies) {
        try {
          const rec = insertAnomaly(a);
          created.push(rec);
          log.warn('Anomaly detected', { runId, model, type: a.type, severity: a.severity, description: a.description });
          // Slack/Discord channel dispatch.
          dispatchNotification(
            {
              type: DispatchEventType.onAnomalyDetected,
              data: { runId, model, type: a.type, severity: a.severity, description: a.description, anomalyId: rec.id },
              timestamp: new Date().toISOString(),
            },
            log,
          ).catch(() => undefined);
          // Webhook fanout (registered via API).
          dispatchWebhooks('anomaly_detected', { runId, model, type: a.type, severity: a.severity, description: a.description, anomalyId: rec.id }, log).catch(() => undefined);
        } catch (err) {
          log.warn('Failed to persist anomaly', { runId, model, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      log.warn('Anomaly analysis failed for model', { runId, model, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return created;
}

function readResultJsonSafe(resultPath: string): RunResult | null {
  try {
    if (!fs.existsSync(resultPath)) return null;
    return readResultJson(resultPath);
  } catch {
    return null;
  }
}

/** Convenience: anomalies already stored for a run. */
export function anomaliesForRun(runId: string): AnomalyRecord[] {
  try {
    return listAnomaliesForRun(runId);
  } catch {
    return [];
  }
}

export { dbPath } from './db.js';
export type { NewAnomaly, AnomalyRecord, AnomalyType, AnomalySeverity } from './db.js';
