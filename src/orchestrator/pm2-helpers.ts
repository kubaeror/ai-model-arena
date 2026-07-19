import pm2 from 'pm2';
import type { Pm2ProcessStatus, StartOptions } from 'pm2';
import path from 'node:path';
import { findProjectRoot } from '../paths.js';

/** Prefix for all arena worker processes. */
export const ARENA_PREFIX = 'ai-arena-';
/** Reserved PM2 process name for the dashboard server itself. */
export const DASHBOARD_PROC_NAME = 'ai-arena-dashboard';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── PM2 promisified helpers ─────────────────────────────────────────────────
export const pm2Connect = (): Promise<void> =>
  new Promise((resolve, reject) => pm2.connect((err) => (err ? reject(err) : resolve())));
export const pm2Disconnect = (): Promise<void> =>
  new Promise((resolve) => pm2.disconnect(() => resolve()));
export const pm2List = (): Promise<Pm2ProcessStatus[]> =>
  new Promise((resolve, reject) => pm2.list((err, list) => (err ? reject(err) : resolve(list ?? []))));
export const pm2Start = (opts: StartOptions): Promise<Pm2ProcessStatus> =>
  new Promise((resolve, reject) =>
    pm2.start(opts, (err, proc) => (err ? reject(err) : resolve(proc as Pm2ProcessStatus))),
  );
export const pm2Delete = (name: string): Promise<void> =>
  new Promise((resolve, reject) => pm2.delete(name, (err) => (err ? reject(err) : resolve())));
export const pm2Stop = (name: string): Promise<void> =>
  new Promise((resolve, reject) => pm2.stop(name, (err) => (err ? reject(err) : resolve())));
export const pm2Restart = (name: string): Promise<void> =>
  new Promise((resolve, reject) => pm2.restart(name, (err) => (err ? reject(err) : resolve())));
export const pm2Describe = (name: string): Promise<Pm2ProcessStatus[]> =>
  new Promise((resolve, reject) => pm2.describe(name, (err, list) => (err ? reject(err) : resolve(list ?? []))));

// ── Shared utilities ─────────────────────────────────────────────────────────
export function projectRoot(): string {
  return findProjectRoot();
}

export function workerScriptPath(root: string): string {
  return path.join(root, 'dist', 'worker.js');
}

export function timestamp(d = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function isOnline(p: Pm2ProcessStatus): boolean {
  const status = p.pm2_env?.status;
  return status === 'online' || status === 'launching';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

// ── Persistent PM2 connection (for dashboard server process lifetime) ──────
let _persistentConnectionActive = false;

/** Hold a long-lived PM2 connection for the dashboard server process lifetime. */
export async function pm2ConnectPersistent(): Promise<void> {
  if (_persistentConnectionActive) return;
  await pm2Connect();
  _persistentConnectionActive = true;
}

export async function pm2DisconnectPersistent(): Promise<void> {
  if (!_persistentConnectionActive) return;
  _persistentConnectionActive = false;
  await pm2Disconnect();
}

/** One-shot: connect -> list -> disconnect. For CLI use. */
export async function pm2ListOnce(): Promise<Pm2ProcessStatus[]> {
  await pm2Connect();
  try { return await pm2List(); }
  finally { await pm2Disconnect(); }
}
