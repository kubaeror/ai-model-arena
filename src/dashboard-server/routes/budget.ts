import { Router } from 'express';
import { findProjectRoot, outputRoot } from '../../paths.js';
import { getBudgetStatus, loadBudgetConfig } from '../../cost-tracking/index.js';
import { createLogger } from '../../logger/pino-logger.js';

export function createBudgetRouter(): Router {
  const router = Router();
  const logger = createLogger('ai-arena:routes:budget');

  router.get('/', (_req, res) => {
    const root = findProjectRoot();
    loadBudgetConfig(`${root}/configs/budget.yaml`, logger);
    const status = getBudgetStatus(outputRoot(), logger);
    res.json(status);
  });

  return router;
}
