import { Router } from 'express';
import { getDb } from '../../db/client.js';
import { listCustomProviders, upsertCustomProvider, deleteCustomProvider } from '../../providers/custom.js';
import { BUILTIN_PROVIDERS } from '../../providers/index.js';
import { validateProviderUrl } from '../../providers/url-validator.js';
import { probeOpenAICompatEndpoint } from '../../providers/capability-probe.js';
import { audit } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import type { ApiKeyRequest } from '../auth-api-types.js';
import { z } from 'zod';

const CustomProviderInputSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'id must be lowercase kebab-case'),
  name: z.string().min(1).max(128),
  apiBase: z.string().refine((url) => {
    const v = validateProviderUrl(url);
    return v.ok;
  }, { message: 'URL targets a blocked address or uses an unsupported scheme/port' }).optional(),
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
  router.post('/', async (req, res) => {
    // If using API key auth, require providers:write scope for mutations
    const apiKeyCtx = (req as ApiKeyRequest).apiKey;
    if (apiKeyCtx && !apiKeyCtx.permissions.includes('providers:write')) {
      res.status(403).json({ error: 'Missing permission: providers:write' });
      return;
    }
    const parsed = CustomProviderInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid provider input', details: parsed.error.flatten() });
      return;
    }

    // Runtime capability detection for OpenAI-compatible providers
    let health: { reachable?: boolean; error?: string } | null = null;
    if (parsed.data.adapter === 'openai-compat' && parsed.data.apiBase) {
      const apiKey = parsed.data.envVar ? process.env[parsed.data.envVar] : undefined;
      if (apiKey) {
        try {
          const result = await probeOpenAICompatEndpoint(parsed.data.apiBase, apiKey, 5_000);
          health = { reachable: result.reachable, error: result.error };
        } catch {
          health = { reachable: false, error: 'probe failed' };
        }
      }
    }

    upsertCustomProvider(getDb(), parsed.data);
    audit((req as AuthedRequest).user?.sub ?? 'system', 'provider.create', { type: 'provider', id: parsed.data.id }, undefined, { name: parsed.data.name, adapter: parsed.data.adapter }).catch(() => {});
    res.status(201).json({
      ok: true,
      id: parsed.data.id,
      health: health ? health : undefined,
    });
  });
  router.delete('/:id', (req, res) => {
    const apiKeyCtx = (req as ApiKeyRequest).apiKey;
    if (apiKeyCtx && !apiKeyCtx.permissions.includes('providers:write')) {
      res.status(403).json({ error: 'Missing permission: providers:write' });
      return;
    }
    deleteCustomProvider(getDb(), req.params.id);
    audit((req as AuthedRequest).user?.sub ?? 'system', 'provider.delete', { type: 'provider', id: req.params.id }).catch(() => {});
    res.json({ ok: true });
  });
  return router;
}
