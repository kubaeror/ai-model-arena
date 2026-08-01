import { Router } from 'express';
import { listModelsWithPricing } from '../../db/query.js';
import { upsertCustomProvider, deleteCustomProvider } from '../../providers/custom.js';
import { auditSafe, requireRole } from '../../auth/rbac.js';
import { z } from 'zod';
import type { AuthedRequest } from '../auth.js';

export function createModelsRouter(): Router {
  const router = Router();

  // GET /api/models - list catalog models
  router.get('/', async (_req, res) => {
    const rows = await listModelsWithPricing();
    res.json({ models: rows });
  });

  // POST /api/models - register a custom OpenAI-compatible provider/model entry
  router.post('/', requireRole('editor'), async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).max(128),
      apiBase: z.string().url().optional(),
      authScheme: z.enum(['bearer', 'x-api-key', 'none']).default('bearer'),
      envVar: z.string().optional(),
      adapter: z.enum(['openai-compat', 'anthropic', 'google', 'bedrock']).default('openai-compat'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid model input', details: parsed.error.flatten() });
      return;
    }
    const id = parsed.data.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    await upsertCustomProvider({ id, name: parsed.data.name, apiBase: parsed.data.apiBase, authScheme: parsed.data.authScheme, envVar: parsed.data.envVar, adapter: parsed.data.adapter });
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'model.create', { type: 'model', id }, undefined, { name: parsed.data.name, adapter: parsed.data.adapter });
    res.status(201).json({ ok: true, id });
  });

  // DELETE /api/models/:name - remove a custom provider by id
  router.delete('/:name', requireRole('editor'), async (req, res) => {
    const name = String(req.params.name);
    await deleteCustomProvider(name);
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'model.delete', { type: 'model', id: name });
    res.json({ ok: true });
  });

  return router;
}
