import type { Request, Response, NextFunction } from 'express';
import type { z } from 'zod';

export { INTERNAL_ERROR } from './error-sanitizer.js';

/** Wrap an async handler so rejections reach the global error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Zod body validation with the repo's standard 400 shape. */
export function parseBody<T>(schema: z.ZodType<T>, req: Request, res: Response, message: string): T | null {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: message, details: parsed.error.flatten() });
    return null;
  }
  return parsed.data;
}

/** Standard 404 for missing entities. */
export function notFound(res: Response, entity: string, _id: string): boolean {
  res.status(404).json({ error: `${entity} not found` });
  return false;
}

/** Clamp limit (default 50, max 200) and offset (>= 0) — the repo-wide pagination policy. */
export function parsePagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(String(query.limit ?? '50'), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(query.offset ?? '0'), 10) || 0, 0);
  return { limit, offset };
}
