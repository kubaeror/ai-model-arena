import type { Request, Response } from 'express';

export function registerRunnerRoutes(app: any): void {
  app.get('/api/runners', (_req: Request, res: Response) => {
    res.json({
      runners: [
        { name: 'runner-openai', provider: 'openai', replicas: 1, status: 'running' },
        { name: 'runner-anthropic', provider: 'anthropic', replicas: 1, status: 'running' },
      ],
    });
  });

  app.post('/api/runners/:name/scale', (req: Request, res: Response) => {
    res.json({ name: req.params.name, replicas: req.body.replicas });
  });

  app.post('/api/runners/:name/drain', (req: Request, res: Response) => {
    res.json({ name: req.params.name, drained: true });
  });
}
