import { Router } from 'express';
import crypto from 'node:crypto';
import { getDb } from '../../db/client.js';
import { audit, requireRole } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { z } from 'zod';

function now(): string {
  return new Date().toISOString();
}

export function createOutputMappingsRouter(): Router {
  const router = Router();

  // GET /api/output-mappings - list all mappings
  router.get('/', (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM output_mappings ORDER BY scope, scope_id').all();
    res.json({ mappings: rows });
  });

  // POST /api/output-mappings - create new mapping
  router.post('/', requireRole('admin'), (req, res) => {
    const schema = z.object({
      scope: z.string().min(1).max(64),
      scopeId: z.string().min(1).max(128),
      parentFolder: z.string().min(1),
      perModelPattern: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid mapping input', details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const id = crypto.randomUUID();
    const timestamp = now();

    db.prepare(
      'INSERT INTO output_mappings (id, scope, scope_id, parent_folder, per_model_pattern, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, parsed.data.scope, parsed.data.scopeId, parsed.data.parentFolder, parsed.data.perModelPattern, timestamp, timestamp);

    audit((req as AuthedRequest).user?.sub ?? 'system', 'output_mapping.create', { type: 'output_mapping', id }).catch(() => {});
    res.status(201).json({ id, ...parsed.data, created_at: timestamp, updated_at: timestamp });
  });

  // PUT /api/output-mappings/:id - update existing mapping
  router.put('/:id', requireRole('admin'), (req, res) => {
    const schema = z.object({
      scope: z.string().min(1).max(64).optional(),
      scopeId: z.string().min(1).max(128).optional(),
      parentFolder: z.string().min(1).optional(),
      perModelPattern: z.string().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid mapping input', details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM output_mappings WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Output mapping not found' });
      return;
    }

    const timestamp = now();
    const updates: string[] = [];
    const values: unknown[] = [];

    if (parsed.data.scope !== undefined) { updates.push('scope = ?'); values.push(parsed.data.scope); }
    if (parsed.data.scopeId !== undefined) { updates.push('scope_id = ?'); values.push(parsed.data.scopeId); }
    if (parsed.data.parentFolder !== undefined) { updates.push('parent_folder = ?'); values.push(parsed.data.parentFolder); }
    if (parsed.data.perModelPattern !== undefined) { updates.push('per_model_pattern = ?'); values.push(parsed.data.perModelPattern); }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    updates.push('updated_at = ?');
    values.push(timestamp);
    values.push(req.params.id);

    db.prepare(`UPDATE output_mappings SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const mappingId = String(req.params.id);
    audit((req as AuthedRequest).user?.sub ?? 'system', 'output_mapping.update', { type: 'output_mapping', id: mappingId }, existing, parsed.data).catch(() => {});
    res.json({ id: mappingId, ...parsed.data });
  });

  // DELETE /api/output-mappings/:id - delete mapping
  router.delete('/:id', requireRole('admin'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM output_mappings WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Output mapping not found' });
      return;
    }

    const deleteId = String(req.params.id);
    db.prepare('DELETE FROM output_mappings WHERE id = ?').run(deleteId);

    audit((req as AuthedRequest).user?.sub ?? 'system', 'output_mapping.delete', { type: 'output_mapping', id: deleteId }).catch(() => {});
    res.json({ ok: true });
  });

  return router;
}
