import { Router } from 'express';
import { getDb } from '../../db/client.js';
import { listCustomProviders, upsertCustomProvider, deleteCustomProvider } from '../../providers/custom.js';
import { BUILTIN_PROVIDERS } from '../../providers/index.js';
import { audit } from '../../auth/rbac.js';
import { z } from 'zod';

const CustomProviderInputSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'id must be lowercase kebab-case'),
  name: z.string().min(1).max(128),
  apiBase: z.string().url().optional(),
  authScheme: z.enum(['bearer', 'x-api-key', 'none']),
  envVar: z.string().optional(),
  headerName: z.string().optional(),
  adapter: z.enum(['openai-compat', 'anthropic', 'google', 'bedrock']),
});

export function createProvidersRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    const custom = listCustomProviders(getDb()).map(r => ({ ...r, is_builtin: Boolean(r.is_builtin) }));
    res.json({ builtin: BUILTIN_PROVIDERS, custom });
  });
  router.post('/', (req, res) => {
    const parsed = CustomProviderInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid provider input', details: parsed.error.flatten() });
      return;
    }
    upsertCustomProvider(getDb(), parsed.data);
    audit((req as any).user?.sub ?? 'system', 'provider.create', { type: 'provider', id: parsed.data.id }, undefined, { name: parsed.data.name, adapter: parsed.data.adapter }).catch(() => {});
    res.status(201).json({ ok: true, id: parsed.data.id });
  });
  router.delete('/:id', (req, res) => {
    deleteCustomProvider(getDb(), req.params.id);
    res.json({ ok: true });
  });
  return router;
}
