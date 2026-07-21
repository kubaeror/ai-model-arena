// DEPRECATED: Non-PM2 utilities have moved to ./utils.ts
// This file exists for backward compatibility while PM2 references are cleaned up.

export {
  ARENA_PREFIX,
  projectRoot,
  workerScriptPath,
  timestamp,
  sanitizeName,
  formatBytes,
  sleep,
} from './utils.js';

// PM2 stubs — no-ops. Use `any` return types to keep existing callers compilable.
export const DASHBOARD_PROC_NAME = 'arena-dashboard';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pm2Connect = async (..._args: any[]): Promise<void> => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pm2Disconnect = async (..._args: any[]): Promise<void> => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pm2List = async (..._args: any[]): Promise<any[]> => [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pm2Start = async (..._args: any[]): Promise<any> => ({});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pm2Delete = async (..._args: any[]): Promise<void> => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pm2Stop = async (..._args: any[]): Promise<void> => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pm2Restart = async (..._args: any[]): Promise<void> => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pm2Describe = async (..._args: any[]): Promise<any[]> => [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isOnline(_p: any): boolean { return false; }
export async function pm2ConnectPersistent(): Promise<void> {}
export async function pm2DisconnectPersistent(): Promise<void> {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pm2ListOnce(): Promise<any[]> { return []; }
