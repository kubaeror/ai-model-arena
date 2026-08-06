import { z } from 'zod';
import type { Task } from './types.js';

const TaskSchema = z.object({
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  promptId: z.string().optional(),
  promptVersion: z.number().int().min(1).optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  scenario: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  enqueuedAt: z.string().min(1),
  attempts: z.number().int().min(0).default(0),
  dueAt: z.number().int().optional(),
  priority: z.number().int().min(0).max(255).optional(),
  idempotencyKey: z.string().optional(),
  _redisId: z.string().optional(),
  _traceparent: z.string().optional(),
});

/** Parse a raw JSON value into a validated Task. Throws on validation failure. */
export function parseTask(raw: unknown): Task {
  return TaskSchema.parse(raw) as Task;
}

/** Parse a raw JSON value into a Task, returning null on validation failure. */
export function safeParseTask(raw: unknown): Task | null {
  const result = TaskSchema.safeParse(raw);
  return result.success ? (result.data as Task) : null;
}
