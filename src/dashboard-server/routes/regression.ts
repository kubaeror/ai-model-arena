import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { requireRole } from '../../auth/rbac.js';
import { findProjectRoot, dbPath } from '../../paths.js';
import { createLogger } from '../../logger/pino-logger.js';
import { listRuns } from '../../orchestrator/orchestrator.js';
import { RegressionSuiteConfigSchema, type RegressionSuiteConfig } from '../../evaluation/regression-config.js';
import { runRegressionSuite, createBaselineSnapshot, saveBaselineSnapshot, getBaselinePath } from '../../evaluation/regression.js';
import { initDb } from '../../db/index.js';

function regressionDir(): string {
  return path.join(findProjectRoot(), 'configs', 'regression');
}

function listSuites(): string[] {
  const dir = regressionDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).map((f) => f.replace(/\.(yaml|yml)$/, ''));
}

function loadSuiteConfig(suiteName: string): RegressionSuiteConfig | null {
  const p = path.join(regressionDir(), `${suiteName}.yaml`);
  if (!fs.existsSync(p)) return null;
  try {
    return RegressionSuiteConfigSchema.parse(load(fs.readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

export function createRegressionRouter(): Router {
  const router = Router();
  const logger = createLogger('ai-arena:routes:regression');

  initDb(dbPath());

  router.get('/suites', (_req, res) => {
    const suites = listSuites();
    res.json({ suites });
  });

  router.get('/suites/:name', (req, res) => {
    const cfg = loadSuiteConfig(req.params.name as string);
    if (!cfg) {
      res.status(404).json({ error: 'Suite not found' });
      return;
    }
    res.json(cfg);
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    const { suite: suiteName, model: filterModel, updateBaseline } = req.body ?? {};
    if (!suiteName) {
      res.status(400).json({ error: 'suite name is required' });
      return;
    }

    const config = loadSuiteConfig(suiteName);
    if (!config) {
      res.status(404).json({ error: `Suite "${suiteName}" not found` });
      return;
    }

    const models = filterModel ? config.models.filter((m) => m === filterModel) : config.models;
    if (models.length === 0) {
      res.status(400).json({ error: `No matching models (filter: ${filterModel ?? 'none'})` });
      return;
    }

    const baselineDir = path.resolve(findProjectRoot(), config.baselineDir);

    const result = await runRegressionSuite(
      suiteName,
      models,
      config.scenarios,
      baselineDir,
      config.thresholds,
      async (mdl, scenario) => {
        const runs = listRuns().filter(
          (r) => r.scenario === scenario && r.models.includes(mdl) && r.status === 'completed',
        );
        if (runs.length === 0) return null;
        const rec = runs[0]!;
        const perModel = rec.perModel.find((m) => m.model === mdl);
        if (!perModel) return null;
        try {
          return JSON.parse(fs.readFileSync(perModel.resultPath, 'utf8'));
        } catch {
          return null;
        }
      },
      logger,
    );

    if (updateBaseline) {
      for (const sr of result.scenarioResults) {
        if (sr.success && sr.current) {
          const snap = createBaselineSnapshot(sr.current, sr.judge ?? null);
          const bPath = getBaselinePath(baselineDir, sr.current.model, sr.scenario);
          saveBaselineSnapshot(bPath, snap, logger);
        }
      }
    }

    res.json(result);
  });

  return router;
}
