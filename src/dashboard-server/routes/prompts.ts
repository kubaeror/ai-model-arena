import { Router } from 'express';
import crypto from 'node:crypto';
import { audit, requireRole } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { z } from 'zod';
import {
  getPromptById, listPromptsWithLatestVersion, listPromptVersions,
  insertPrompt, updatePromptMetadata, deletePromptById,
  insertPromptVersion, getLatestPromptVersion,
  getModelByNameOrId,
} from '../../db/query.js';

function now(): string {
  return new Date().toISOString();
}

function sid(p: string | string[] | undefined): string {
  return String(p ?? '');
}

export function createPromptsRouter(): Router {
  const router = Router();

  // GET /api/prompts - list all prompts with latest version info
  router.get('/', async (_req, res) => {
    const rows = await listPromptsWithLatestVersion();
    res.json({ prompts: rows });
  });

  // GET /api/prompts/:id - single prompt with all versions
  router.get('/:id', async (req, res) => {
    const prompt = await getPromptById(sid(req.params.id));
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    const versions = await listPromptVersions(sid(req.params.id));
    res.json({ prompt, versions });
  });

  // POST /api/prompts - create prompt + initial version
  router.post('/', requireRole('admin'), async (req, res) => {
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

    const promptId = crypto.randomUUID();
    const timestamp = now();
    const actor = (req as AuthedRequest).user?.sub ?? 'system';

    await insertPrompt({
      id: promptId, name: parsed.data.name,
      description: parsed.data.description ?? null,
      createdAt: timestamp, updatedAt: timestamp,
    });

    const versionId = crypto.randomUUID();
    await insertPromptVersion({
      id: versionId, promptId, version: 1,
      systemPrompt: parsed.data.systemPrompt, task: parsed.data.task,
      config: parsed.data.config ? JSON.stringify(parsed.data.config) : null,
      tag: parsed.data.tag ?? null, createdAt: timestamp, createdBy: actor,
    });

    audit(actor, 'prompt.create', { type: 'prompt', id: promptId }, undefined, { name: parsed.data.name }).catch(() => {});
    res.status(201).json({ id: promptId, version: 1 });
  });

  // PUT /api/prompts/:id - update prompt metadata
  router.put('/:id', requireRole('admin'), async (req, res) => {
    const promptId = sid(req.params.id);
    const schema = z.object({
      name: z.string().min(1).max(128).optional(),
      description: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const existing = await getPromptById(promptId);
    if (!existing) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const timestamp = now();
    await updatePromptMetadata(promptId, {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      updatedAt: timestamp,
    });

    audit((req as AuthedRequest).user?.sub ?? 'system', 'prompt.update', { type: 'prompt', id: promptId }, existing, parsed.data).catch(() => {});
    res.json({ ok: true });
  });

  // DELETE /api/prompts/:id - delete prompt + cascade versions
  router.delete('/:id', requireRole('admin'), async (req, res) => {
    const deleteId = sid(req.params.id);
    const existing = await getPromptById(deleteId);
    if (!existing) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    await deletePromptById(deleteId);

    audit((req as AuthedRequest).user?.sub ?? 'system', 'prompt.delete', { type: 'prompt', id: deleteId }).catch(() => {});
    res.json({ ok: true });
  });

  // POST /api/prompts/:id/versions - create new version of an existing prompt
  router.post('/:id/versions', requireRole('admin'), async (req, res) => {
    const promptId = sid(req.params.id);
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

    const prompt = await getPromptById(promptId);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const nextVersion = (await getLatestPromptVersion(promptId)) + 1;
    const versionId = crypto.randomUUID();
    const timestamp = now();
    const actor = (req as AuthedRequest).user?.sub ?? 'system';

    await insertPromptVersion({
      id: versionId, promptId, version: nextVersion,
      systemPrompt: parsed.data.systemPrompt, task: parsed.data.task,
      config: parsed.data.config ? JSON.stringify(parsed.data.config) : null,
      tag: parsed.data.tag ?? null, createdAt: timestamp, createdBy: actor,
    });

    await updatePromptMetadata(promptId, { updatedAt: timestamp });

    audit(actor, 'prompt_version.create', { type: 'prompt', id: promptId }, undefined, { version: nextVersion, tag: parsed.data.tag }).catch(() => {});
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

    const promptRow = await getPromptById(parsed.data.promptId);
    if (!promptRow) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const version = parsed.data.promptVersion ?? await getLatestPromptVersion(parsed.data.promptId);

    const { createQueue } = await import('../../queue/index.js');

    const queue = createQueue();
    const tasks: { taskId: string; model: string; provider: string }[] = [];

    for (const model of parsed.data.models) {
      const resolved = await getModelByNameOrId(model);
      const task = {
        taskId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        provider: resolved?.provider_id ?? 'unknown',
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
