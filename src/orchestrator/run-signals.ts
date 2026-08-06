import { Redis } from 'ioredis';

export interface RunSignalStore {
  isKillSwitchActive(): Promise<boolean>;
  setKillSwitch(active: boolean): Promise<void>;
  isRunCancelled(runId: string): Promise<boolean>;
  markRunCancelled(runId: string): Promise<void>;
  clearRunCancelled(runId: string): Promise<void>;
}

const KILL_SWITCH_KEY = 'arena:killswitch';
const CANCEL_PREFIX = 'arena:cancel:';
const CANCEL_TTL_SECONDS = 7 * 24 * 60 * 60;

export class InMemoryRunSignalStore implements RunSignalStore {
  private killSwitch = false;
  private cancelled = new Set<string>();

  async isKillSwitchActive(): Promise<boolean> { return this.killSwitch; }
  async setKillSwitch(active: boolean): Promise<void> { this.killSwitch = active; }
  async isRunCancelled(runId: string): Promise<boolean> { return this.cancelled.has(runId); }
  async markRunCancelled(runId: string): Promise<void> { this.cancelled.add(runId); }
  async clearRunCancelled(runId: string): Promise<void> { this.cancelled.delete(runId); }
}

export class RedisRunSignalStore implements RunSignalStore {
  private redis: Redis | null = null;
  private url: string;

  constructor(opts: { url: string }) { this.url = opts.url; }

  private client(): Redis {
    if (!this.redis) {
      this.redis = new Redis(this.url, {
        maxRetriesPerRequest: 3,
        retryStrategy(times: number) { return Math.min(times * 200, 3_000); },
        connectTimeout: 10_000,
        lazyConnect: false,
        protocol: 2,
      });
    }
    return this.redis;
  }

  async isKillSwitchActive(): Promise<boolean> {
    try { return (await this.client().exists(KILL_SWITCH_KEY)) === 1; }
    catch { return false; }
  }
  async setKillSwitch(active: boolean): Promise<void> {
    const c = this.client();
    try { if (active) await c.set(KILL_SWITCH_KEY, '1'); else await c.del(KILL_SWITCH_KEY); }
    catch { /* best-effort: signal loss must not crash the dashboard */ }
  }
  async isRunCancelled(runId: string): Promise<boolean> {
    try { return (await this.client().exists(`${CANCEL_PREFIX}${runId}`)) === 1; }
    catch { return false; }
  }
  async markRunCancelled(runId: string): Promise<void> {
    try { await this.client().set(`${CANCEL_PREFIX}${runId}`, '1', 'EX', CANCEL_TTL_SECONDS); }
    catch { /* best-effort */ }
  }
  async clearRunCancelled(runId: string): Promise<void> {
    try { await this.client().del(`${CANCEL_PREFIX}${runId}`); }
    catch { /* best-effort */ }
  }

  async close(): Promise<void> {
    if (this.redis) { await this.redis.quit(); this.redis = null; }
  }
}

let store: RunSignalStore | null = null;
let storeForTests: RunSignalStore | null = null;

export function setRunSignalStoreForTests(s: RunSignalStore): void {
  storeForTests = s;
}

function signalStore(): RunSignalStore {
  if (storeForTests) return storeForTests;
  if (!store) {
    store = process.env.QUEUE_DRIVER === 'redis'
      ? new RedisRunSignalStore({ url: process.env.REDIS_URL ?? '' })
      : new InMemoryRunSignalStore();
  }
  return store;
}

export function isKillSwitchActive(): Promise<boolean> { return signalStore().isKillSwitchActive(); }
export function setKillSwitch(active: boolean): Promise<void> { return signalStore().setKillSwitch(active); }
export function isRunCancelled(runId: string): Promise<boolean> { return signalStore().isRunCancelled(runId); }
export function markRunCancelled(runId: string): Promise<void> { return signalStore().markRunCancelled(runId); }
export function clearRunCancelled(runId: string): Promise<void> { return signalStore().clearRunCancelled(runId); }
