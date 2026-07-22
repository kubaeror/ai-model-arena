import type { Express, Request, Response } from 'express';
import { createQueue } from '../../queue/index.js';

export function registerQueueRoutes(app: Express): void {
  app.get('/api/queues', async (_req: Request, res: Response) => {
    try {
      const queue = createQueue();
      const size = await queue.size();
      const dlqSize = queue.deadLetterSize ? await queue.deadLetterSize() : null;
      res.json({ queues: [{ provider: 'default', depth: size, dlqDepth: dlqSize }] });
    } catch (e) {
      res.json({ queues: [] });
    }
  });

  app.get('/api/queues/:provider/tasks', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const queue = createQueue();
      const tasks = queue.deadLetterPeek ? await queue.deadLetterPeek(limit) : [];
      res.json({ provider: req.params.provider, tasks });
    } catch (e) {
      res.json({ provider: req.params.provider, tasks: [] });
    }
  });

  app.post('/api/queues/:provider/tasks/:id/retry', async (req: Request, res: Response) => {
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
