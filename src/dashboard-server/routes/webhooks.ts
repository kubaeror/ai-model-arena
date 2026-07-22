import { Router } from 'express';
import { insertWebhook, listWebhooks, deleteWebhook, type NewWebhook } from '../../anomaly-detection/db.js';
import { audit } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';

/**
 * Webhook subscriptions API:
 *  POST   /api/v1/webhooks      — register a URL for events (run_completed,
 *                                 anomaly_detected, budget_exceeded)
 *  GET    /api/v1/webhooks      — list registered webhooks
 *  DELETE /api/v1/webhooks/:id  — remove a webhook
 */
export function createWebhooksRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    try {
      res.json({ webhooks: listWebhooks(false) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/', (req, res) => {
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
      const result = insertWebhook(input);
      audit((req as AuthedRequest).user?.sub ?? 'system', 'webhook.create', { type: 'webhook', id: String(result.id) }, undefined, { url, events }).catch(() => {});
      res.status(201).json({ webhook: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid webhook id' });
      return;
    }
    try {
      const ok = deleteWebhook(id);
      if (!ok) {
        res.status(404).json({ error: `Webhook ${id} not found` });
        return;
      }
      audit((req as AuthedRequest).user?.sub ?? 'system', 'webhook.delete', { type: 'webhook', id: String(id) }).catch(() => {});
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
