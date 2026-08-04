import { Router } from 'express';
import crypto from 'node:crypto';
import { auditSafe, requireRole } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { z } from 'zod';
import {
  listOutputMappings, getOutputMappingById, insertOutputMapping,
  updateOutputMapping, deleteOutputMapping,
} from '../../db/query.js';

function now(): string {
  return new Date().toISOString();
}

function sid(p: string | string[] | undefined): string {
  return String(p ?? '');
}

export function createOutputMappingsRouter(): Router {
  const router = Router();

  // GET /api/output-mappings - list all mappings
  router.get('/', async (_req, res) => {
    const rows = await listOutputMappings();
    res.json({ mappings: rows });
  });

  // POST /api/output-mappings - create new mapping
  router.post('/', requireRole('admin'), async (req, res) => {
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

    const id = crypto.randomUUID();
    const timestamp = now();

    await insertOutputMapping({
      id, scope: parsed.data.scope, scopeId: parsed.data.scopeId,
      parentFolder: parsed.data.parentFolder, perModelPattern: parsed.data.perModelPattern,
      createdAt: timestamp, updatedAt: timestamp,
    });

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'output_mapping.create', { type: 'output_mapping', id });
    res.status(201).json({ id, ...parsed.data, created_at: timestamp, updated_at: timestamp });
  });

  // PUT /api/output-mappings/:id - update existing mapping
  router.put('/:id', requireRole('admin'), async (req, res) => {
    const mappingId = sid(req.params.id);
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

    const existing = await getOutputMappingById(mappingId);
    if (!existing) {
      res.status(404).json({ error: 'Output mapping not found' });
      return;
    }

    const timestamp = now();
    await updateOutputMapping(mappingId, {
      scope: parsed.data.scope,
      scopeId: parsed.data.scopeId,
      parentFolder: parsed.data.parentFolder,
      perModelPattern: parsed.data.perModelPattern,
      updatedAt: timestamp,
    });

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'output_mapping.update', { type: 'output_mapping', id: mappingId }, existing, parsed.data);
    res.json({ id: mappingId, ...parsed.data });
  });

  // DELETE /api/output-mappings/:id - delete mapping
  router.delete('/:id', requireRole('admin'), async (req, res) => {
    const deleteId = sid(req.params.id);
    const existing = await getOutputMappingById(deleteId);
    if (!existing) {
      res.status(404).json({ error: 'Output mapping not found' });
      return;
    }

    await deleteOutputMapping(deleteId);

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'output_mapping.delete', { type: 'output_mapping', id: deleteId });
    res.json({ ok: true });
  });

  return router;
}
