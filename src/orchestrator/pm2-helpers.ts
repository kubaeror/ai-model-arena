import path from 'node:path';
import { findProjectRoot } from '../paths.js';

export const ARENA_PREFIX = 'arena-';
export const DASHBOARD_PROC_NAME = 'arena-dashboard';

export const pm2Connect = async (..._args: any[]): Promise<void> => {};
export const pm2Disconnect = async (..._args: any[]): Promise<void> => {};
export const pm2List = async (..._args: any[]): Promise<any[]> => [];
export const pm2Start = async (..._args: any[]): Promise<any> => ({});
export const pm2Delete = async (..._args: any[]): Promise<void> => {};
export const pm2Stop = async (..._args: any[]): Promise<void> => {};
export const pm2Restart = async (..._args: any[]): Promise<void> => {};
export const pm2Describe = async (..._args: any[]): Promise<any[]> => [];

export function isOnline(_p: any): boolean { return false; }
export function projectRoot(): string { return process.env.AI_ARENA_ROOT ?? findProjectRoot(); }
export function workerScriptPath(root: string): string { return path.join(root, 'dist', 'worker.js'); }
export function timestamp(): string { return new Date().toISOString().replace(/[:.]/g, '-'); }
export function sanitizeName(name: string): string { return name.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 128); }
export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / 1048576).toFixed(1)}MB`;
}
export async function pm2ConnectPersistent(): Promise<void> {}
export async function pm2DisconnectPersistent(): Promise<void> {}
export async function pm2ListOnce(): Promise<any[]> { return []; }
export function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
