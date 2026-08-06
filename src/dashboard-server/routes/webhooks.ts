import { Router } from 'express';
import { insertWebhook, listWebhooks, deleteWebhook, type NewWebhook } from '../../db/query.js';
import { auditSafe } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { asyncHandler, notFound } from '../helpers.js';

export function createWebhooksRouter(): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => {
    res.json({ webhooks: await listWebhooks(false) });
  }));

  router.post('/', asyncHandler(async (req, res) => {
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
    const input: NewWebhook = { url, events, secret };
    const result = await insertWebhook(input);
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'webhook.create', { type: 'webhook', id: String(result.id) }, undefined, { url, events });
    res.status(201).json({ webhook: result });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid webhook id' });
      return;
    }
    const ok = await deleteWebhook(id);
    if (!ok) {
      notFound(res, `Webhook ${id}`, String(id));
      return;
    }
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'webhook.delete', { type: 'webhook', id: String(id) });
    res.status(204).send();
  }));

  return router;
}
