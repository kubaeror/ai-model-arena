// DEPRECATED: Non-PM2 utilities have moved to ./utils.ts
// This file exists for backward compatibility while PM2 references are cleaned up.
// eslint is configured to ignore no-explicit-any in this file (pm2 stubs).

export {
  ARENA_PREFIX,
  projectRoot,
  workerScriptPath,
  timestamp,
  sanitizeName,
  formatBytes,
  sleep,
} from './utils.js';

const noop = async (..._args: any[]): Promise<void> => {};
const noopArr = async (..._args: any[]): Promise<any[]> => [];

export const DASHBOARD_PROC_NAME = 'arena-dashboard';
export const pm2Connect = noop;
export const pm2Disconnect = noop;
export const pm2List = noopArr;
export const pm2Start = noop;
export const pm2Delete = noop;
export const pm2Stop = noop;
export const pm2Restart = noop;
export const pm2Describe = noopArr;
export function isOnline(_p: unknown): boolean { return false; }
export const pm2ConnectPersistent = noop;
export const pm2DisconnectPersistent = noop;
export const pm2ListOnce = noopArr;
