import { Router } from 'express';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import type { AuthedRequest } from '../auth.js';
import { audit } from '../../auth/rbac.js';
import { secretStore } from '../../secrets/store.js';
import { isKubernetes, getKubeNamespace, getKubeSecretName } from '../../env/detect.js';
import type { Request, Response } from 'express';

let k8sApi: CoreV1Api | null = null;
let k8sReady = false;

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

export function createSecretsRouter(): Router {
  const router = Router();

  initK8s();

  // GET /api/secrets — list all provider secrets with masked values
  router.get('/', ((_req: Request, res: Response) => {
    const entries = secretStore.list();
    res.json({ platform: isKubernetes() ? 'kubernetes' : 'bare-metal', secrets: entries });
  }) as unknown as Router);

  // PUT /api/secrets/:envVar — set a secret value
  router.put('/:envVar', (async (req: Request, res: Response) => {
    const envVar = req.params.envVar as string;
    const { value } = req.body as { value?: string };

    if (!envVar || typeof value !== 'string' || !value) {
      res.status(400).json({ error: 'envVar and value are required' });
      return;
    }

    try {
      if (isKubernetes() && k8sApi) {
        const ns = getKubeNamespace();
        const name = getKubeSecretName();

        await k8sApi.patchNamespacedSecret({
          name,
          namespace: ns,
          body: { stringData: { [envVar]: value } },
        });

        audit((req as unknown as AuthedRequest).user?.sub ?? 'system', 'secret.set', { type: 'secret', id: envVar }).catch(() => {});
        res.json({ ok: true, envVar, message: 'Secret updated — kubelet will refresh mounts within ~60s' });
      } else {
        await secretStore.set(envVar, value);
        audit((req as unknown as AuthedRequest).user?.sub ?? 'system', 'secret.set', { type: 'secret', id: envVar }).catch(() => {});
        res.json({ ok: true, envVar });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  }) as unknown as Router);

  // DELETE /api/secrets/:envVar — remove a secret
  router.delete('/:envVar', (async (req: Request, res: Response) => {
    const envVar = req.params.envVar as string;

    if (!envVar) {
      res.status(400).json({ error: 'envVar is required' });
      return;
    }

    try {
      if (isKubernetes() && k8sApi) {
        const ns = getKubeNamespace();
        const name = getKubeSecretName();

        // Remove key via merge patch with null value
        await k8sApi.patchNamespacedSecret({
          name,
          namespace: ns,
          body: { stringData: { [envVar]: null } },
        });

        audit((req as unknown as AuthedRequest).user?.sub ?? 'system', 'secret.delete', { type: 'secret', id: envVar }).catch(() => {});
        res.json({ ok: true, envVar, message: 'Secret removed — kubelet will refresh mounts within ~60s' });
      } else {
        await secretStore.delete(envVar);
        audit((req as unknown as AuthedRequest).user?.sub ?? 'system', 'secret.delete', { type: 'secret', id: envVar }).catch(() => {});
        res.json({ ok: true, envVar });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  }) as unknown as Router);

  return router;
}
