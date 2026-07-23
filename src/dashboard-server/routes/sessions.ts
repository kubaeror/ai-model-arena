import { Router } from 'express';
import { getDb } from '../../db/client.js';
import { requireRole, audit } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';

export function createSessionsRouter(): Router {
  const router = Router();

  // GET /api/sessions - list sessions, paginated + filterable
  router.get('/', (req, res) => {
    const db = getDb();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const model = typeof req.query.model === 'string' ? req.query.model : undefined;

    let where = '1=1';
    const params: unknown[] = [];
    if (status) { where += ' AND s.status = ?'; params.push(status); }
    if (model) { where += ' AND s.model = ?'; params.push(model); }

    const countRow = db.prepare(`SELECT COUNT(*) AS total FROM sessions s WHERE ${where}`).get(...params) as { total: number };
    params.push(limit, offset);

    const rows = db.prepare(`
      SELECT s.id, s.prompt_id, s.prompt_version, s.model, s.status, s.created_at, s.updated_at,
        (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS message_count,
        (SELECT COUNT(*) FROM model_calls WHERE session_id = s.id) AS call_count
      FROM sessions s
      WHERE ${where}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params);

    res.json({ sessions: rows, total: countRow.total, limit, offset });
  });

  // GET /api/sessions/:id - single session detail
  router.get('/:id', (req, res) => {
    const db = getDb();
    const session = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS message_count,
        (SELECT COUNT(*) FROM model_calls WHERE session_id = s.id) AS call_count
      FROM sessions s WHERE s.id = ?
    `).get(req.params.id) as Record<string, unknown> | undefined;
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  });

  // GET /api/sessions/:id/messages - all messages ordered by turn
  router.get('/:id/messages', (req, res) => {
    const db = getDb();
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY turn, created_at').all(req.params.id);
    res.json({ messages });
  });

  // GET /api/sessions/:id/calls - all model_calls ordered by turn
  router.get('/:id/calls', (req, res) => {
    const db = getDb();
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const calls = db.prepare('SELECT * FROM model_calls WHERE session_id = ? ORDER BY turn').all(req.params.id);
    res.json({ calls });
  });

  // DELETE /api/sessions/:id - delete session + cascade
  router.delete('/:id', requireRole('admin'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const sessionId = String(req.params.id);
    db.prepare('DELETE FROM model_calls WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    audit((req as AuthedRequest).user?.sub ?? 'system', 'session.delete', { type: 'session', id: sessionId }).catch(() => {});
    res.json({ ok: true });
  });

  return router;
}
