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

  app.post('/api/queues/:provider/tasks/:id/retry', (req: Request, res: Response) => {
    res.json({ id: req.params.id, retried: true, note: 'Re-queue not implemented yet' });
  });
}
