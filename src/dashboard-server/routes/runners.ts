import type { Router, Request, Response } from 'express';
import { KubeConfig, AppsV1Api, CoreV1Api } from '@kubernetes/client-node';
import type { RequestHandler } from 'express';
import { requireRole } from '../../auth/rbac.js';
import { asyncHandler } from '../helpers.js';

const NAMESPACE = process.env.KUBE_NAMESPACE ?? 'ai-arena';

let cachedKube: KubeConfig | null = null;

function getKube(): KubeConfig | null {
  if (cachedKube) return cachedKube;
  try {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    cachedKube = kc;
    return kc;
  } catch {
    return null;
  }
}

export function registerRunnerRoutes(router: Router, auth: RequestHandler): void {
  // GET /api/runners — list runner deployments + their pods
  router.get('/api/runners', auth, requireRole('admin'), asyncHandler(async (_req: Request, res: Response) => {
    const kube = getKube();
    if (!kube) {
      res.status(503).json({ error: 'k8s API unavailable' });
      return;
    }
    const appsApi = kube.makeApiClient(AppsV1Api);
    const coreApi = kube.makeApiClient(CoreV1Api);
      const deploys = await appsApi.listNamespacedDeployment({ namespace: NAMESPACE, labelSelector: 'app=runner' });
      const pods = await coreApi.listNamespacedPod({ namespace: NAMESPACE, labelSelector: 'app=runner' });

      const runners = deploys.items.map((d) => {
        const name = d.metadata?.name ?? 'unknown';
        const provider = d.metadata?.labels?.provider ?? 'unknown';
        const replicas = d.status?.readyReplicas ?? 0;
        const desiredReplicas = d.spec?.replicas ?? 0;
        const podList = pods.items.filter((p) =>
          p.metadata?.labels?.['app'] === 'runner' && p.metadata?.labels?.provider === provider,
        );
        return {
          name,
          provider,
          replicas,
          desiredReplicas,
          status: replicas > 0 ? 'running' : 'idle',
          pods: podList.map((p) => ({
            name: p.metadata?.name,
            status: p.status?.phase,
            node: p.spec?.nodeName,
            startedAt: p.status?.startTime,
          })),
        };
      });

      res.json({ runners });
  }));

  // POST /api/runners/:name/scale — patch deployment replicas
  router.post('/api/runners/:name/scale', auth, requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
    const { replicas } = req.body ?? {};
    if (typeof replicas !== 'number' || replicas < 0) {
      res.status(400).json({ error: 'replicas must be a non-negative number' });
      return;
    }
    const kube = getKube();
    if (!kube) {
      res.status(503).json({ error: 'k8s API unavailable' });
      return;
    }
    const appsApi = kube.makeApiClient(AppsV1Api);
    const name = String(req.params.name);
    await appsApi.patchNamespacedDeployment({
      name,
      namespace: NAMESPACE,
      body: { spec: { replicas } },
    });
    res.json({ name, replicas });
  }));

  // POST /api/runners/:name/drain — scale to 0
  router.post('/api/runners/:name/drain', auth, requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
    const kube = getKube();
    if (!kube) {
      res.status(503).json({ error: 'k8s API unavailable' });
      return;
    }
    const appsApi = kube.makeApiClient(AppsV1Api);
    const name = String(req.params.name);
    await appsApi.patchNamespacedDeployment({
      name,
      namespace: NAMESPACE,
      body: { spec: { replicas: 0 } },
    });
    res.json({ name, drained: true });
  }));

  // GET /api/runners/:name/logs — stream pod logs
  router.get('/api/runners/:name/logs', auth, requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
    const kube = getKube();
    if (!kube) {
      res.status(503).json({ error: 'k8s API unavailable' });
      return;
    }
    const coreApi = kube.makeApiClient(CoreV1Api);
    const provider = String(req.params.name).replace('runner-', '');
    const pods = await coreApi.listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: `app=runner,provider=${provider}`,
    });
    const pod = pods.items[0];
    if (!pod?.metadata?.name) {
      res.status(404).json({ error: 'No pods found' });
      return;
    }
    const logs = await coreApi.readNamespacedPodLog({
      name: pod.metadata.name,
      namespace: NAMESPACE,
      tailLines: 100,
    });
    res.type('text/plain').send(logs);
  }));
}
