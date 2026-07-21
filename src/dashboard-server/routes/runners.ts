import type { Express, Request, Response } from 'express';
import { KubeConfig, AppsV1Api, CoreV1Api } from '@kubernetes/client-node';

const kc = new KubeConfig();
kc.loadFromDefault();
const appsApi = kc.makeApiClient(AppsV1Api);
const coreApi = kc.makeApiClient(CoreV1Api);
const NAMESPACE = process.env.KUBE_NAMESPACE ?? 'ai-arena';

export function registerRunnerRoutes(app: Express): void {
  // GET /api/runners — list runner deployments + their pods
  app.get('/api/runners', async (_req: Request, res: Response) => {
    try {
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
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/runners/:name/scale — patch deployment replicas
  app.post('/api/runners/:name/scale', async (req: Request, res: Response) => {
    const { replicas } = req.body ?? {};
    if (typeof replicas !== 'number' || replicas < 0) {
      res.status(400).json({ error: 'replicas must be a non-negative number' });
      return;
    }
    try {
      const name = String(req.params.name);
      await appsApi.patchNamespacedDeployment({
        name,
        namespace: NAMESPACE,
        body: { spec: { replicas } },
      });
      res.json({ name, replicas });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/runners/:name/drain — scale to 0
  app.post('/api/runners/:name/drain', async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name);
      await appsApi.patchNamespacedDeployment({
        name,
        namespace: NAMESPACE,
        body: { spec: { replicas: 0 } },
      });
      res.json({ name, drained: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/runners/:name/logs — stream pod logs
  app.get('/api/runners/:name/logs', async (req: Request, res: Response) => {
    try {
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
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
