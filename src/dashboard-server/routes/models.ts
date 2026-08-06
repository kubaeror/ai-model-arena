import { Router } from 'express';
import { listCatalogModels } from '../../db/query.js';
import { upsertCustomProvider, deleteCustomProvider } from '../../providers/custom.js';
import { auditSafe, requireRole } from '../../auth/rbac.js';
import { z } from 'zod';
import type { AuthedRequest } from '../auth.js';
import { parseBody } from '../helpers.js';

export function createModelsRouter(): Router {
  const router = Router();

  // GET /api/models - list catalog models (config-consumer shape: { models })
  router.get('/', async (_req, res) => {
    const rows = await listCatalogModels({});
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
    const parsed = parseBody(schema, req, res, 'Invalid model input');
    if (!parsed) return;
    const id = parsed.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    await upsertCustomProvider({ id, name: parsed.name, apiBase: parsed.apiBase, authScheme: parsed.authScheme, envVar: parsed.envVar, adapter: parsed.adapter });
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'model.create', { type: 'model', id }, undefined, { name: parsed.name, adapter: parsed.adapter });
    res.status(201).json({ models: await listCatalogModels({}) });
  });

  // DELETE /api/models/:name - remove a custom provider by id
  router.delete('/:name', requireRole('editor'), async (req, res) => {
    const name = String(req.params.name);
    await deleteCustomProvider(name);
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'model.delete', { type: 'model', id: name });
    res.json({ models: await listCatalogModels({}) });
  });

  return router;
}
