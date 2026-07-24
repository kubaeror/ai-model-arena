import { Router } from 'express';
import {
  listSessionsWithCounts, getSessionWithCounts, listMessagesBySession,
  listModelCallsForSession, deleteSessionCascade,
} from '../../db/query.js';
import { requireRole, audit } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';

export function createSessionsRouter(): Router {
  const router = Router();

  // GET /api/sessions - list sessions, paginated + filterable
  router.get('/', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const model = typeof req.query.model === 'string' ? req.query.model : undefined;

    const { sessions, total } = await listSessionsWithCounts({ status, model, limit, offset });

    res.json({ sessions, total, limit, offset });
  });

  // GET /api/sessions/:id - single session detail
  router.get('/:id', async (req, res) => {
    const session = await getSessionWithCounts(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  });

  // GET /api/sessions/:id/messages - all messages ordered by turn
  router.get('/:id/messages', async (req, res) => {
    const session = await getSessionWithCounts(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const messages = await listMessagesBySession(req.params.id);
    res.json({ messages });
  });

  // GET /api/sessions/:id/calls - all model_calls ordered by turn
  router.get('/:id/calls', async (req, res) => {
    const session = await getSessionWithCounts(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const calls = await listModelCallsForSession(req.params.id);
    res.json({ calls });
  });

  // DELETE /api/sessions/:id - delete session + cascade
  router.delete('/:id', requireRole('admin'), async (req, res) => {
    const existing = await getSessionWithCounts(String(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const sessionId = String(req.params.id);
    await deleteSessionCascade(sessionId);

    audit((req as AuthedRequest).user?.sub ?? 'system', 'session.delete', { type: 'session', id: sessionId }).catch(() => {});
    res.json({ ok: true });
  });

  return router;
}
