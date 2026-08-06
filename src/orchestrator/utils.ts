import { findProjectRoot } from '../paths.js';

export const ARENA_PREFIX = 'arena-';

export function projectRoot(): string {
  return process.env.AI_ARENA_ROOT ?? findProjectRoot();
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
