import { Router } from 'express';
import { insertWebhook, listWebhooks, deleteWebhook, type NewWebhook } from '../../anomaly-detection/db.js';
import { auditSafe } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { INTERNAL_ERROR } from '../error-sanitizer.js';

export function createWebhooksRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      res.json({ webhooks: await listWebhooks(false) });
    } catch {
      res.status(500).json({ error: INTERNAL_ERROR });
    }
  });

  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = typeof body.url === 'string' ? body.url : '';
    const events = Array.isArray(body.events) ? body.events.filter((e): e is string => typeof e === 'string') : [];
    const secret = typeof body.secret === 'string' ? body.secret : undefined;
    if (!url || !/^https?:\/\//.test(url)) {
      res.status(400).json({ error: 'A valid http(s) "url" is required' });
      return;
    }
    if (events.length === 0) {
      res.status(400).json({ error: 'At least one "events" entry is required (run_completed, anomaly_detected, budget_exceeded)' });
      return;
    }
    try {
      const input: NewWebhook = { url, events, secret };
      const result = await insertWebhook(input);
      auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'webhook.create', { type: 'webhook', id: String(result.id) }, undefined, { url, events });
      res.status(201).json({ webhook: result });
    } catch {
      res.status(500).json({ error: INTERNAL_ERROR });
    }
  });

  router.delete('/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid webhook id' });
      return;
    }
    try {
      const ok = await deleteWebhook(id);
      if (!ok) {
        res.status(404).json({ error: `Webhook ${id} not found` });
        return;
      }
      auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'webhook.delete', { type: 'webhook', id: String(id) });
      res.status(204).send();
    } catch {
      res.status(500).json({ error: INTERNAL_ERROR });
    }
  });

  return router;
}
