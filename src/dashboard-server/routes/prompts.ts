import { Router } from 'express';
import crypto from 'node:crypto';
import { getDb } from '../../db/client.js';
import { audit, requireRole } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { z } from 'zod';

function now(): string {
  return new Date().toISOString();
}

export function createPromptsRouter(): Router {
  const router = Router();

  // GET /api/prompts - list all prompts with latest version info
  router.get('/', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
        pv.version AS latest_version, pv.tag AS latest_tag
      FROM prompts p
      LEFT JOIN prompt_versions pv ON pv.id = (
        SELECT pv2.id FROM prompt_versions pv2
        WHERE pv2.prompt_id = p.id
        ORDER BY pv2.version DESC LIMIT 1
      )
      ORDER BY p.name ASC
    `).all();
    res.json({ prompts: rows });
  });

  // GET /api/prompts/:id - single prompt with all versions
  router.get('/:id', (req, res) => {
    const db = getDb();
    const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    const versions = db.prepare('SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY version DESC').all(req.params.id);
    res.json({ prompt, versions });
  });

  // POST /api/prompts - create prompt + initial version
  router.post('/', requireRole('admin'), (req, res) => {
    const schema = z.object({
      name: z.string().min(1).max(128),
      description: z.string().optional(),
      systemPrompt: z.string().min(1),
      task: z.string().min(1),
      config: z.record(z.string(), z.unknown()).optional(),
      tag: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid prompt input', details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const promptId = crypto.randomUUID();
    const timestamp = now();
    const actor = (req as AuthedRequest).user?.sub ?? 'system';

    db.prepare('INSERT INTO prompts (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      promptId, parsed.data.name, parsed.data.description ?? null, timestamp, timestamp,
    );

    const versionId = crypto.randomUUID();
    db.prepare('INSERT INTO prompt_versions (id, prompt_id, version, system_prompt, task, config, tag, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      versionId, promptId, 1, parsed.data.systemPrompt, parsed.data.task,
      parsed.data.config ? JSON.stringify(parsed.data.config) : null,
      parsed.data.tag ?? null, timestamp, actor,
    );

    audit(actor, 'prompt.create', { type: 'prompt', id: promptId }, undefined, { name: parsed.data.name }).catch(() => {});
    res.status(201).json({ id: promptId, version: 1 });
  });

  // PUT /api/prompts/:id - update prompt metadata
  router.put('/:id', requireRole('admin'), (req, res) => {
    const schema = z.object({
      name: z.string().min(1).max(128).optional(),
      description: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const timestamp = now();
    if (parsed.data.name !== undefined) {
      db.prepare('UPDATE prompts SET name = ?, updated_at = ? WHERE id = ?').run(parsed.data.name, timestamp, req.params.id);
    }
    if (parsed.data.description !== undefined) {
      db.prepare('UPDATE prompts SET description = ?, updated_at = ? WHERE id = ?').run(parsed.data.description, timestamp, req.params.id);
    }

    const promptId = String(req.params.id);
    audit((req as AuthedRequest).user?.sub ?? 'system', 'prompt.update', { type: 'prompt', id: promptId }, existing, parsed.data).catch(() => {});
    res.json({ ok: true });
  });

  // DELETE /api/prompts/:id - delete prompt + cascade versions
  router.delete('/:id', requireRole('admin'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const deleteId = String(req.params.id);
    db.prepare('DELETE FROM prompt_versions WHERE prompt_id = ?').run(deleteId);
    db.prepare('DELETE FROM prompts WHERE id = ?').run(deleteId);

    audit((req as AuthedRequest).user?.sub ?? 'system', 'prompt.delete', { type: 'prompt', id: deleteId }).catch(() => {});
    res.json({ ok: true });
  });

  // POST /api/prompts/:id/versions - create new version of an existing prompt
  router.post('/:id/versions', requireRole('admin'), (req, res) => {
    const schema = z.object({
      systemPrompt: z.string().min(1),
      task: z.string().min(1),
      config: z.record(z.string(), z.unknown()).optional(),
      tag: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid version input', details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const maxVer = db.prepare('SELECT MAX(version) AS max_ver FROM prompt_versions WHERE prompt_id = ?').get(req.params.id) as { max_ver: number | null };
    const nextVersion = (maxVer?.max_ver ?? 0) + 1;
    const versionId = crypto.randomUUID();
    const timestamp = now();
    const actor = (req as AuthedRequest).user?.sub ?? 'system';

    db.prepare('INSERT INTO prompt_versions (id, prompt_id, version, system_prompt, task, config, tag, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      versionId, req.params.id, nextVersion, parsed.data.systemPrompt, parsed.data.task,
      parsed.data.config ? JSON.stringify(parsed.data.config) : null,
      parsed.data.tag ?? null, timestamp, actor,
    );

    const versionPromptId = String(req.params.id);
    db.prepare('UPDATE prompts SET updated_at = ? WHERE id = ?').run(timestamp, versionPromptId);

    audit(actor, 'prompt_version.create', { type: 'prompt', id: versionPromptId }, undefined, { version: nextVersion, tag: parsed.data.tag }).catch(() => {});
    res.status(201).json({ id: versionId, version: nextVersion });
  });

  // POST /api/prompts/enqueue - enqueue prompt runs to the task queue
  router.post('/enqueue', requireRole('editor'), async (req, res) => {
    const schema = z.object({
      promptId: z.string().min(1),
      promptVersion: z.number().int().min(1).optional(),
      models: z.array(z.string().min(1)).min(1),
      scenario: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'promptId, models, and scenario are required', details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const promptRow = db.prepare('SELECT * FROM prompts WHERE id = ?').get(parsed.data.promptId);
    if (!promptRow) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const version = parsed.data.promptVersion ?? (db.prepare(
      'SELECT version FROM prompt_versions WHERE prompt_id = ? ORDER BY version DESC LIMIT 1'
    ).get(parsed.data.promptId) as { version: number } | undefined)?.version ?? 1;

    // Resolve model→provider mapping
    const { resolveModelForRun } = await import('../../db/model-resolver.js');
    const { createQueue } = await import('../../queue/index.js');

    const queue = createQueue();
    const tasks: { taskId: string; model: string; provider: string }[] = [];

    for (const model of parsed.data.models) {
      const resolved = resolveModelForRun(model);
      const task = {
        taskId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        provider: resolved?.providerId ?? 'unknown',
        model,
        scenario: parsed.data.scenario,
        promptId: parsed.data.promptId,
        promptVersion: version,
        config: {},
        enqueuedAt: now(),
        attempts: 0,
      };

      await queue.enqueue(task);
      tasks.push({ taskId: task.taskId, model, provider: task.provider });
    }

    audit((req as AuthedRequest).user?.sub ?? 'system', 'prompt.enqueue', { type: 'prompt', id: parsed.data.promptId }, undefined, { count: tasks.length, models: parsed.data.models }).catch(() => {});

    res.json({ tasks, count: tasks.length });
  });

  return router;
}
