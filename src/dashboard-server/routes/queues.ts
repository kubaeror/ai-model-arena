import type { Router, Request, Response } from 'express';
import type { RequestHandler } from 'express';
import { createQueue } from '../../queue/index.js';
import { requireRole } from '../../auth/rbac.js';

export function registerQueueRoutes(router: Router, auth: RequestHandler): void {
  router.get('/api/queues', auth, requireRole('admin'), async (_req: Request, res: Response) => {
    try {
      const queue = createQueue();
      const size = await queue.size();
      const dlqSize = queue.deadLetterSize ? await queue.deadLetterSize() : null;
      res.json({ queues: [{ provider: 'default', depth: size, dlqDepth: dlqSize }] });
    } catch (e) {
      res.json({ queues: [] });
    }
  });

  router.get('/api/queues/:provider/tasks', auth, requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const queue = createQueue();
      const tasks = queue.deadLetterPeek ? await queue.deadLetterPeek(limit) : [];
      res.json({ provider: req.params.provider, tasks });
    } catch (e) {
      res.json({ provider: req.params.provider, tasks: [] });
    }
  });

  router.post('/api/queues/:provider/tasks/:id/retry', auth, requireRole('admin'), async (req: Request, res: Response) => {
    try {
      const taskId = String(req.params.id ?? '');
      const queue = createQueue();
      if (queue.deadLetterRetry) {
        await queue.deadLetterRetry(taskId);
        res.json({ id: taskId, retried: true });
      } else {
        res.status(501).json({ id: req.params.id, retried: false, note: 'DLQ retry not supported by current queue driver' });
      }
    } catch (err) {
      res.status(500).json({ id: req.params.id, retried: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
