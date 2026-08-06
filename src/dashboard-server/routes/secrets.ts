import { Router } from 'express';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import type { AuthedRequest } from '../auth.js';
import { auditSafe } from '../../auth/rbac.js';
import { secretStore, type SecretEntry } from '../../secrets/store.js';
import { isKubernetes, getKubeNamespace, getKubeSecretName } from '../../env/detect.js';
import type { Request, Response } from 'express';
import { asyncHandler } from '../helpers.js';

let k8sApi: CoreV1Api | null = null;
let k8sReady = false;

function mask(v: string): string {
  if (v.length <= 4) return '****';
  return v.slice(0, 4) + '...' + v.slice(-4);
}

/**
 * Object.prototype keys that must never be used as env var / secret names —
 * writing them as object properties could mutate the prototype chain.
 */
const RESERVED_ENV_VAR_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Reject envVar keys that could break .env parsing, inject lines into the
 * file (bare-metal store), collide with Object.prototype keys, or fail k8s
 * secret key validation. Only k8s-compatible names (alphanumeric, '-', '_',
 * '.') are settable.
 */
export function isValidEnvVarName(name: string): boolean {
  return /^[-._A-Za-z0-9]+$/.test(name) && !RESERVED_ENV_VAR_NAMES.has(name);
}

/** Secret values must not contain line breaks (would break .env quoting). */
export function hasControlChars(value: string): boolean {
  return /[\r\n]/.test(value);
}

function initK8s(): void {
  if (k8sReady) return;
  if (!isKubernetes()) return;
  try {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    k8sApi = kc.makeApiClient(CoreV1Api);
    k8sReady = true;
  } catch {
    // k8s not available — dashboard may still run outside cluster
  }
}

function decodeSecretData(data: Record<string, string>): SecretEntry[] {
  const entries: SecretEntry[] = [];
  for (const [k, v] of Object.entries(data)) {
    const decoded = Buffer.from(v, 'base64').toString('utf-8');
    entries.push({
      envVar: k,
      status: decoded ? 'set' : 'missing',
      maskedValue: decoded ? mask(decoded) : undefined,
    });
  }
  return entries;
}

export function createSecretsRouter(): Router {
  const router = Router();

  initK8s();

  // GET /api/secrets — list all provider secrets with masked values
  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    if (isKubernetes() && k8sApi) {
      try {
        const ns = getKubeNamespace();
        const name = getKubeSecretName();
        const secret = await k8sApi.readNamespacedSecret({ name, namespace: ns });
        const data = secret.data ?? {};
        res.json({ platform: 'kubernetes', secrets: decodeSecretData(data) });
        return;
      } catch (err: unknown) {
        const e = err as { response?: { statusCode?: number }; statusCode?: number };
        if (e?.response?.statusCode === 404 || e?.statusCode === 404) {
          res.json({ platform: 'kubernetes', secrets: [] });
          return;
        }
        if (e?.response?.statusCode === 403) {
          // Dashboard SA no longer has secret read access — use env-based fallback
          const entries = secretStore.list();
          res.json({ platform: 'kubernetes', secrets: entries, note: 'Secret listing uses env-based fallback (dashboard SA lacks read access)' });
          return;
        }
        throw err;
      }
    }
    const entries = secretStore.list();
    res.json({ platform: 'bare-metal', secrets: entries });
  }));

  // PUT /api/secrets/:envVar — set a secret value
  router.put('/:envVar', asyncHandler(async (req: Request, res: Response) => {
    const envVar = req.params.envVar as string;
    const { value } = req.body as { value?: string };

    if (!envVar || typeof value !== 'string' || !value) {
      res.status(400).json({ error: 'envVar and value are required' });
      return;
    }

    if (!isValidEnvVarName(envVar)) {
      res.status(400).json({ error: 'Invalid envVar; must not contain whitespace or "="' });
      return;
    }
    if (hasControlChars(value)) {
      res.status(400).json({ error: 'Secret value must not contain newlines' });
      return;
    }

    if (isKubernetes() && k8sApi) {
      const ns = getKubeNamespace();
      const name = getKubeSecretName();

      try {
        await k8sApi.patchNamespacedSecret({
          name,
          namespace: ns,
          body: { stringData: Object.fromEntries([[envVar, value]]) },
        });
      } catch (patchErr: unknown) {
        const e = patchErr as { response?: { statusCode?: number }; statusCode?: number };
        if (e?.response?.statusCode === 404 || e?.statusCode === 404) {
          await k8sApi.createNamespacedSecret({
            namespace: ns,
            body: {
              metadata: { name, namespace: ns },
              stringData: Object.fromEntries([[envVar, value]]),
            },
          });
        } else {
          throw patchErr;
        }
      }

      auditSafe((req as unknown as AuthedRequest).user?.sub ?? 'system', 'secret.set', { type: 'secret', id: envVar });
      res.json({ ok: true, envVar, message: 'Secret updated — kubelet will refresh mounts within ~60s' });
    } else {
      await secretStore.set(envVar, value);
      auditSafe((req as unknown as AuthedRequest).user?.sub ?? 'system', 'secret.set', { type: 'secret', id: envVar });
      res.json({ ok: true, envVar });
    }
  }));

  // DELETE /api/secrets/:envVar — remove a secret
  router.delete('/:envVar', asyncHandler(async (req: Request, res: Response) => {
    const envVar = req.params.envVar as string;

    if (!envVar) {
      res.status(400).json({ error: 'envVar is required' });
      return;
    }

    if (isKubernetes() && k8sApi) {
      const ns = getKubeNamespace();
      const name = getKubeSecretName();

      try {
        await k8sApi.patchNamespacedSecret({
          name,
          namespace: ns,
          body: { stringData: Object.fromEntries([[envVar, null]]) },
        });
      } catch (err: unknown) {
        const e = err as { response?: { statusCode?: number }; statusCode?: number };
        if (e?.response?.statusCode === 404 || e?.statusCode === 404) {
          res.json({ ok: true, envVar, message: 'Secret already removed' });
          return;
        }
        throw err;
      }

      auditSafe((req as unknown as AuthedRequest).user?.sub ?? 'system', 'secret.delete', { type: 'secret', id: envVar });
      res.json({ ok: true, envVar, message: 'Secret removed — kubelet will refresh mounts within ~60s' });
    } else {
      await secretStore.delete(envVar);
      auditSafe((req as unknown as AuthedRequest).user?.sub ?? 'system', 'secret.delete', { type: 'secret', id: envVar });
      res.json({ ok: true, envVar });
    }
  }));

  return router;
}
