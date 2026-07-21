import type { Express, Request, Response } from 'express';

export function registerOutputRoutes(app: Express): void {
  app.get('/api/output-mappings', (_req: Request, res: Response) => {
    res.json({ mappings: [] });
  });

  app.put('/api/output-mappings/:id', (req: Request, res: Response) => {
    res.json({ id: req.params.id, ...req.body });
  });
}
