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
import { isWithin } from '../../sandbox/sandbox.js';

function regressionDir(): string {
  return path.join(findProjectRoot(), 'configs', 'regression');
}

function listSuites(): string[] {
  const dir = regressionDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).map((f) => f.replace(/\.(yaml|yml)$/, ''));
}

/**
 * Resolve a bare suite name to a safe filesystem path inside regressionDir.
 *
 * Previously loadSuiteConfig() did `path.join(regressionDir(), \`${suiteName}.yaml\`)`
 * with no validation on suiteName. Express URL-decodes route params, so a
 * request like `GET /api/regression/suites/..%2F..%2Fapi-keys` would resolve
 * to `configs/api-keys.yaml` — letting any viewer-role user read arbitrary
 * YAML files under the project root (including configs/api-keys.yaml with
 * API-key definitions and configs/webhooks.yaml with HMAC secrets).
 *
 * This helper enforces a bare alphanumeric suite name and isWithin() on the
 * resolved path, matching the scenarios.ts resolveAndValidate pattern.
 *
 * @returns the validated path, or null if the name is invalid or escapes
 *          regressionDir.
 */
export function resolveSuitePath(suiteName: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(suiteName)) return null;
  const resolved = path.join(regressionDir(), `${suiteName}.yaml`);
  if (!isWithin(regressionDir(), resolved)) return null;
  return resolved;
}

function loadSuiteConfig(suiteName: string): RegressionSuiteConfig | null {
  const p = resolveSuitePath(suiteName);
  if (!p) return null;
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
        const runs = (await listRuns()).filter(
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
