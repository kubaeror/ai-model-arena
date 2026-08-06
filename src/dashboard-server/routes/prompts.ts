import { Router } from 'express';
import crypto from 'node:crypto';
import { auditSafe, requireRole } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { z } from 'zod';
import { notFound, parseBody } from '../helpers.js';
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
      notFound(res, 'Prompt', sid(req.params.id));
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
    const parsed = parseBody(schema, req, res, 'Invalid prompt input');
    if (!parsed) return;

    const promptId = crypto.randomUUID();
    const timestamp = now();
    const actor = (req as AuthedRequest).user?.sub ?? 'system';

    await insertPrompt({
      id: promptId, name: parsed.name,
      description: parsed.description ?? null,
      createdAt: timestamp, updatedAt: timestamp,
    });

    const versionId = crypto.randomUUID();
    await insertPromptVersion({
      id: versionId, promptId, version: 1,
      systemPrompt: parsed.systemPrompt, task: parsed.task,
      config: parsed.config ? JSON.stringify(parsed.config) : null,
      tag: parsed.tag ?? null, createdAt: timestamp, createdBy: actor,
    });

    auditSafe(actor, 'prompt.create', { type: 'prompt', id: promptId }, undefined, { name: parsed.name });
    res.status(201).json({ id: promptId, version: 1 });
  });

  // PUT /api/prompts/:id - update prompt metadata
  router.put('/:id', requireRole('admin'), async (req, res) => {
    const promptId = sid(req.params.id);
    const schema = z.object({
      name: z.string().min(1).max(128).optional(),
      description: z.string().optional(),
    });
    const parsed = parseBody(schema, req, res, 'Invalid input');
    if (!parsed) return;

    const existing = await getPromptById(promptId);
    if (!existing) {
      notFound(res, 'Prompt', promptId);
      return;
    }

    const timestamp = now();
    await updatePromptMetadata(promptId, {
      name: parsed.name,
      description: parsed.description ?? null,
      updatedAt: timestamp,
    });

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'prompt.update', { type: 'prompt', id: promptId }, existing, parsed);
    res.json({ ok: true });
  });

  // DELETE /api/prompts/:id - delete prompt + cascade versions
  router.delete('/:id', requireRole('admin'), async (req, res) => {
    const deleteId = sid(req.params.id);
    const existing = await getPromptById(deleteId);
    if (!existing) {
      notFound(res, 'Prompt', deleteId);
      return;
    }

    await deletePromptById(deleteId);

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'prompt.delete', { type: 'prompt', id: deleteId });
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
    const parsed = parseBody(schema, req, res, 'Invalid version input');
    if (!parsed) return;

    const prompt = await getPromptById(promptId);
    if (!prompt) {
      notFound(res, 'Prompt', promptId);
      return;
    }

    const nextVersion = (await getLatestPromptVersion(promptId)) + 1;
    const versionId = crypto.randomUUID();
    const timestamp = now();
    const actor = (req as AuthedRequest).user?.sub ?? 'system';

    await insertPromptVersion({
      id: versionId, promptId, version: nextVersion,
      systemPrompt: parsed.systemPrompt, task: parsed.task,
      config: parsed.config ? JSON.stringify(parsed.config) : null,
      tag: parsed.tag ?? null, createdAt: timestamp, createdBy: actor,
    });

    await updatePromptMetadata(promptId, { updatedAt: timestamp });

    auditSafe(actor, 'prompt_version.create', { type: 'prompt', id: promptId }, undefined, { version: nextVersion, tag: parsed.tag });
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
    const parsed = parseBody(schema, req, res, 'promptId, models, and scenario are required');
    if (!parsed) return;

    const promptRow = await getPromptById(parsed.promptId);
    if (!promptRow) {
      notFound(res, 'Prompt', parsed.promptId);
      return;
    }

    const version = parsed.promptVersion ?? await getLatestPromptVersion(parsed.promptId);

    const { createQueue } = await import('../../queue/index.js');

    const queue = createQueue();
    const tasks: { taskId: string; model: string; provider: string }[] = [];

    for (const model of parsed.models) {
      const resolved = await getModelByNameOrId(model);
      const task = {
        taskId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        provider: resolved?.provider_id ?? 'unknown',
        model,
        scenario: parsed.scenario,
        promptId: parsed.promptId,
        promptVersion: version,
        config: {},
        enqueuedAt: now(),
        attempts: 0,
      };

      await queue.enqueue(task);
      tasks.push({ taskId: task.taskId, model, provider: task.provider });
    }

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'prompt.enqueue', { type: 'prompt', id: parsed.promptId }, undefined, { count: tasks.length, models: parsed.models });

    res.json({ tasks, count: tasks.length });
  });

  return router;
}
