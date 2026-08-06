import { Router } from 'express';
import {
  listSessionsWithCounts, getSessionWithCounts, listMessagesBySession,
  listModelCallsForSession,
} from '../../db/query.js';
import { createSessionStore } from '../../session/store.js';
import { requireRole, auditSafe } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { notFound, parsePagination } from '../helpers.js';

export function createSessionsRouter(): Router {
  const router = Router();

  // GET /api/sessions - list sessions, paginated + filterable
  router.get('/', async (req, res) => {
    const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const model = typeof req.query.model === 'string' ? req.query.model : undefined;

    const { sessions, total } = await listSessionsWithCounts({ status, model, limit, offset });

    res.json({ sessions, total, limit, offset });
  });

  // GET /api/sessions/:id - single session detail
  router.get('/:id', async (req, res) => {
    const session = await getSessionWithCounts(req.params.id);
    if (!session) {
      notFound(res, 'Session', req.params.id);
      return;
    }
    res.json(session);
  });

  // GET /api/sessions/:id/messages - all messages ordered by turn
  router.get('/:id/messages', async (req, res) => {
    const session = await getSessionWithCounts(req.params.id);
    if (!session) {
      notFound(res, 'Session', req.params.id);
      return;
    }
    const messages = await listMessagesBySession(req.params.id);
    res.json({ messages });
  });

  // GET /api/sessions/:id/calls - all model_calls ordered by turn
  router.get('/:id/calls', async (req, res) => {
    const session = await getSessionWithCounts(req.params.id);
    if (!session) {
      notFound(res, 'Session', req.params.id);
      return;
    }
    const calls = await listModelCallsForSession(req.params.id);
    res.json({ calls });
  });

  // DELETE /api/sessions/:id - delete session + cascade
  router.delete('/:id', requireRole('admin'), async (req, res) => {
    const existing = await getSessionWithCounts(String(req.params.id));
    if (!existing) {
      notFound(res, 'Session', String(req.params.id));
      return;
    }

    const sessionId = String(req.params.id);
    await createSessionStore().deleteSession(sessionId);

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'session.delete', { type: 'session', id: sessionId });
    res.json({ ok: true });
  });

  return router;
}
