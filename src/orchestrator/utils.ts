import path from 'node:path';
import { findProjectRoot } from '../paths.js';

export const ARENA_PREFIX = 'arena-';
export const DASHBOARD_PROC_NAME = 'arena-dashboard';

export function projectRoot(): string {
  return process.env.AI_ARENA_ROOT ?? findProjectRoot();
}

export function workerScriptPath(root: string): string {
  return path.join(root, 'dist', 'worker.js');
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 128);
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / 1048576).toFixed(1)}MB`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
