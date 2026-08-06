import { Router } from 'express';
import { listNotifications, retryNotification } from '../../notifications/outbox.js';

/**
 * Notification delivery outbox (F10) routes. Admin-only: exposes internal
 * delivery state (payload, errors, retry schedule) and a manual retry trigger.
 */
export function createNotificationsRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const notifications = await listNotifications(100);
    res.json({ notifications });
  });

  router.post('/:id/retry', async (req, res) => {
    const id = req.params.id as string;
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    await retryNotification(id);
    res.json({ ok: true });
  });

  return router;
}
