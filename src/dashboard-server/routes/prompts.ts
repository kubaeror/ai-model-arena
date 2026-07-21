import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';

export function registerPromptRoutes(app: Express): void {
  app.post('/api/prompts/enqueue', (req: Request, res: Response) => {
    const { promptId, promptVersion, models, scenario } = req.body;
    if (!promptId || !models || !scenario) {
      res.status(400).json({ error: 'promptId, models, and scenario are required' });
      return;
    }
    const tasks = models.map((m: string) => ({
      taskId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      model: m,
      promptId,
      promptVersion: promptVersion ?? 1,
      scenario,
    }));
    res.json({ tasks, count: tasks.length });
  });
}
