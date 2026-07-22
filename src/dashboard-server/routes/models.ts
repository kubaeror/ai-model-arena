import { Router } from 'express';
import { getDb } from '../../db/client.js';
import { listCustomProviders, upsertCustomProvider, deleteCustomProvider } from '../../providers/custom.js';
import { BUILTIN_PROVIDERS } from '../../providers/index.js';
import { audit, requireRole } from '../../auth/rbac.js';
import { z } from 'zod';
import type { AuthedRequest } from '../auth.js';

/**
 * Legacy model-management router. Previously read/wrote configs/models.yaml.
 * Now proxies to the SQLite catalog: lists catalog models, and treats
 * "add/update/delete model" as custom-provider operations (since models
 * themselves come from the models.dev sync).
 */
export function createModelsRouter(): Router {
  const router = Router();

  // GET /api/models - list catalog models
  router.get('/', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.id, m.name, m.family, m.provider_id, m.reasoning, m.tool_call,
        m.context_limit, m.output_limit, m.status, p.input, p.output, p.cache_read, p.cache_write
      FROM models m LEFT JOIN pricing p ON p.model_id = m.id AND p.tier_size IS NULL
      ORDER BY m.name ASC
    `).all();
    res.json({ models: rows });
  });

  // POST /api/models - register a custom OpenAI-compatible provider/model entry
  router.post('/', requireRole('editor'), (req, res) => {
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
    upsertCustomProvider(getDb(), { id, name: parsed.data.name, apiBase: parsed.data.apiBase, authScheme: parsed.data.authScheme, envVar: parsed.data.envVar, adapter: parsed.data.adapter });
    audit((req as AuthedRequest).user?.sub ?? 'system', 'model.create', { type: 'model', id }, undefined, { name: parsed.data.name, adapter: parsed.data.adapter }).catch(() => {});
    res.status(201).json({ ok: true, id });
  });

  // DELETE /api/models/:name - remove a custom provider by id
  router.delete('/:name', requireRole('editor'), (req, res) => {
    const name = String(req.params.name);
    deleteCustomProvider(getDb(), name);
    audit((req as AuthedRequest).user?.sub ?? 'system', 'model.delete', { type: 'model', id: name }).catch(() => {});
    res.json({ ok: true });
  });

  // Expose built-in + custom providers alongside models for the launcher UI.
  router.get('/providers', (_req, res) => {
    const custom = listCustomProviders(getDb()).map(r => ({ ...r, is_builtin: Boolean(r.is_builtin) }));
    res.json({ builtin: BUILTIN_PROVIDERS, custom });
  });

  return router;
}
