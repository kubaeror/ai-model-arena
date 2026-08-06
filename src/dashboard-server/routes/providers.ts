import { Router } from 'express';
import { listCustomProviders, upsertCustomProvider, deleteCustomProvider } from '../../providers/custom.js';
import { BUILTIN_PROVIDERS } from '../../providers/index.js';
import { validateProviderUrl } from '../../providers/url-validator.js';
import { probeProvider } from '../../providers/capability-probe.js';
import { auditSafe } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import type { ApiKeyRequest } from '../auth-api-types.js';
import { z } from 'zod';
import { parseBody } from '../helpers.js';

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
  router.get('/', async (_req, res) => {
    const custom = (await listCustomProviders()).map(r => ({ ...r, is_builtin: Boolean(r.is_builtin) }));
    res.json({ builtin: BUILTIN_PROVIDERS, custom });
  });
  router.post('/', async (req, res) => {
    // If using API key auth, require providers:write scope for mutations
    const apiKeyCtx = (req as ApiKeyRequest).apiKey;
    if (apiKeyCtx && !apiKeyCtx.permissions.includes('providers:write')) {
      res.status(403).json({ error: 'Missing permission: providers:write' });
      return;
    }
    const parsed = parseBody(CustomProviderInputSchema, req, res, 'Invalid provider input');
    if (!parsed) return;

    // Runtime reachability probe, dispatched per adapter kind (openai-compat
    // GET /models, anthropic count_tokens, google models.list, bedrock gateway
    // /health). Probes run only when an apiBase is configured (native-SigV4
    // bedrock and keyless providers skip probing).
    let health: { reachable?: boolean; error?: string } | null = null;
    if (parsed.apiBase) {
      const apiKey = parsed.envVar ? process.env[parsed.envVar] : undefined;
      try {
        const result = await probeProvider({
          id: parsed.id,
          name: parsed.name,
          apiBase: parsed.apiBase,
          authScheme: parsed.authScheme,
          envVar: parsed.envVar,
          headerName: parsed.headerName,
          adapter: parsed.adapter,
          isBuiltin: false,
        }, { apiKey, timeoutMs: 5_000 });
        health = { reachable: result.reachable, error: result.error };
      } catch {
        health = { reachable: false, error: 'probe failed' };
      }
    }

    // Persist before responding. Previously this was a floating promise
    // (`upsertCustomProvider(parsed);` without await), so the API
    // returned 201 before the DB write completed — a client would get a
    // success status even if the write later failed. Await and surface 500.
    try {
      await upsertCustomProvider(parsed);
    } catch (e) {
      res.status(500).json({ error: 'Failed to persist provider', detail: e instanceof Error ? e.message : String(e) });
      return;
    }
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'provider.create', { type: 'provider', id: parsed.id }, undefined, { name: parsed.name, adapter: parsed.adapter });
    res.status(201).json({
      ok: true,
      id: parsed.id,
      health: health ? health : undefined,
    });
  });
  router.delete('/:id', async (req, res) => {
    const apiKeyCtx = (req as ApiKeyRequest).apiKey;
    if (apiKeyCtx && !apiKeyCtx.permissions.includes('providers:write')) {
      res.status(403).json({ error: 'Missing permission: providers:write' });
      return;
    }
    // Await the delete (was a floating promise; see POST handler above).
    try {
      await deleteCustomProvider(req.params.id);
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete provider', detail: e instanceof Error ? e.message : String(e) });
      return;
    }
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'provider.delete', { type: 'provider', id: req.params.id });
    res.json({ ok: true });
  });
  return router;
}
