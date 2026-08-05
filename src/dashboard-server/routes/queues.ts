import type { Router, Request, Response } from 'express';
import type { RequestHandler } from 'express';
import { createQueue } from '../../queue/index.js';
import { requireRole } from '../../auth/rbac.js';
import { knownProviders } from '../../queue/router.js';
import { INTERNAL_ERROR } from '../error-sanitizer.js';

function maxReplicas(): number | null {
  const raw = process.env.ARENA_KEDA_MAX_REPLICAS;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function registerQueueRoutes(router: Router, auth: RequestHandler): void {
  router.get('/api/queues', auth, requireRole('admin'), async (_req: Request, res: Response) => {
    try {
      const replicas = maxReplicas();
      const queues = [];
      for (const provider of knownProviders) {
        const queue = createQueue(provider);
        const [depth, dlqDepth, consumerLag] = await Promise.all([
          queue.size(),
          queue.deadLetterSize ? queue.deadLetterSize() : Promise.resolve(null),
          queue.pendingCount ? queue.pendingCount() : Promise.resolve(null),
        ]);
        queues.push({ provider, depth, dlqDepth, consumerLag, maxReplicas: replicas });
      }
      res.json({ queues });
    } catch {
      res.json({ queues: [] });
    }
  });

  router.get('/api/queues/:provider/tasks', auth, requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const queue = createQueue(String(req.params.provider));
      const tasks = queue.deadLetterPeek ? await queue.deadLetterPeek(limit) : [];
      res.json({ provider: req.params.provider, tasks });
    } catch {
      res.json({ provider: req.params.provider, tasks: [] });
    }
  });

  router.post('/api/queues/:provider/tasks/:id/retry', auth, requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const taskId = String(req.params.id ?? '');
      const queue = createQueue(String(req.params.provider));
      if (queue.deadLetterRetry) {
        const retried = await queue.deadLetterRetry(taskId);
        if (retried) {
          res.json({ id: taskId, retried: true });
        } else {
          res.status(404).json({ id: taskId, retried: false, note: 'task not found in DLQ' });
        }
      } else {
        res.status(501).json({ id: req.params.id, retried: false, note: 'DLQ retry not supported by current queue driver' });
      }
    } catch {
      res.status(500).json({ id: req.params.id, retried: false, error: INTERNAL_ERROR });
    }
  });
}
