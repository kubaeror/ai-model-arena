import type { Express, Request, Response } from 'express';

// TODO: Wire to real Redis queue depths when Redis is available.
// The queue module's RedisStreamQueue has xLen/xInfo methods that
// could power this — needs a per-provider summary endpoint.
const mockQueues = [
  { provider: 'openai', depth: 0, dlqDepth: 0, consumerLag: 0, maxReplicas: 10 },
  { provider: 'anthropic', depth: 0, dlqDepth: 0, consumerLag: 0, maxReplicas: 10 },
];

export function registerQueueRoutes(app: Express): void {
  app.get('/api/queues', (_req: Request, res: Response) => {
    res.json({ queues: mockQueues });
  });

  app.get('/api/queues/:provider/tasks', (req: Request, res: Response) => {
    res.json({ provider: req.params.provider, tasks: [] });
  });

  app.post('/api/queues/:provider/tasks/:id/retry', (req: Request, res: Response) => {
    res.json({ id: req.params.id, retried: true });
  });
}
