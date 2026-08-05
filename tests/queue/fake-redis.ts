/**
 * In-memory fake of the ioredis surface used by RedisStreamQueue (src/queue/redis.ts).
 *
 * Models the Redis Streams semantics that the queue relies on:
 *  - XADD appends entries with monotonically increasing ids
 *  - XREADGROUP delivers *new* entries and marks them pending (in-flight) in the PEL
 *  - XACK removes entries from the PEL
 *  - XDEL removes entries from the stream (PEL entries linger until XACK/XAUTOCLAIM, like real Redis)
 *  - XAUTOCLAIM reassigns PEL entries idle longer than minIdleMs and drops stale PEL
 *    entries for messages deleted from the stream (returned as deleted ids)
 *  - XRANGE returns entries by id range
 *  - eval() runs the two Lua scripts redis.ts uses, dispatched on script signature
 *
 * Not modeled: BLOCK on XREADGROUP (returns immediately), TTL on the dedup SETNX key,
 * evalsha/defineCommand (redis.ts never calls them).
 */

export interface PendingEntry {
  consumer: string;
  deliveredAt: number;
}

export type StreamEntry = [string, string[]];

const DEDUP_SCRIPT_MARKER = "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])";
const NACK_SCRIPT_MARKER = 'cjson.decode';

export class FakeRedis {
  private streams = new Map<string, Map<string, string[]>>();
  private groups = new Map<string, Set<string>>();
  private pel = new Map<string, Map<string, PendingEntry>>();
  private dedup = new Map<string, string>();
  private kv = new Map<string, string>();
  private seq = 0;

  // ---- test-side read helpers (not part of the ioredis surface) ----

  getDedup(key: string): string | undefined {
    return this.dedup.get(key);
  }

  getStreamIds(stream: string): string[] {
    return [...(this.streams.get(stream) ?? new Map<string, string[]>()).keys()];
  }

  getStreamEntry(stream: string, id: string): string[] | undefined {
    return this.streams.get(stream)?.get(id);
  }

  hasGroup(stream: string, group: string): boolean {
    return this.groups.get(stream)?.has(group) ?? false;
  }

  // ---- internals ----

  private nextId(): string {
    this.seq += 1;
    return `${String(this.seq).padStart(16, '0')}-0`;
  }

  private streamMap(stream: string): Map<string, string[]> {
    let m = this.streams.get(stream);
    if (!m) {
      m = new Map();
      this.streams.set(stream, m);
    }
    return m;
  }

  private pelFor(stream: string, group: string): Map<string, PendingEntry> {
    const key = `${stream}|${group}`;
    let m = this.pel.get(key);
    if (!m) {
      m = new Map();
      this.pel.set(key, m);
    }
    return m;
  }

  private requireGroup(stream: string, group: string): void {
    if (!(this.groups.get(stream)?.has(group) ?? false)) {
      throw new Error(`NOGROUP No such key '${stream}' or consumer group '${group}'`);
    }
  }

  // ---- ioredis surface used by RedisStreamQueue ----

  async xadd(stream: string, idOrStar: string, ...fields: (string | number)[]): Promise<string> {
    const id = idOrStar === '*' ? this.nextId() : idOrStar;
    this.streamMap(stream).set(id, fields.map(String));
    return id;
  }

  async xlen(stream: string): Promise<number> {
    return this.streams.get(stream)?.size ?? 0;
  }

  async xgroup(...args: (string | number)[]): Promise<string> {
    const [op, stream, group] = args as [string, string, string];
    if (op !== 'CREATE') throw new Error(`FakeRedis: unsupported XGROUP op ${op}`);
    if (this.groups.get(stream)?.has(group)) {
      throw new Error('BUSYGROUP Consumer Group name already exists');
    }
    const groups = this.groups.get(stream) ?? new Set<string>();
    groups.add(group);
    this.groups.set(stream, groups);
    this.streamMap(stream); // MKSTREAM: create the stream if missing
    return 'OK';
  }

  async xreadgroup(
    ...args: (string | number)[]
  ): Promise<Array<[string, StreamEntry[]]> | null> {
    const group = args[1] as string;
    const consumer = args[2] as string;
    const count = Number(args[4]);
    const streamsIdx = args.indexOf('STREAMS');
    const streams = args.slice(streamsIdx + 1);

    const results: Array<[string, StreamEntry[]]> = [];
    for (let i = 0; i < streams.length; i += 2) {
      const stream = streams[i] as string;
      const cursor = streams[i + 1] as string;
      this.requireGroup(stream, group);
      const pel = this.pelFor(stream, group);
      const out: StreamEntry[] = [];
      for (const [id, fields] of this.streamMap(stream)) {
        if (cursor !== '>' && id <= cursor) continue;
        if (pel.has(id)) continue; // already delivered → pending/in-flight
        pel.set(id, { consumer, deliveredAt: Date.now() });
        out.push([id, [...fields]]);
        if (out.length >= count) break;
      }
      if (out.length > 0) results.push([stream, out]);
    }
    return results.length > 0 ? results : null;
  }

  async xack(stream: string, group: string, ...ids: string[]): Promise<number> {
    const pel = this.pelFor(stream, group);
    let acked = 0;
    for (const id of ids) if (pel.delete(id)) acked += 1;
    return acked;
  }

  async xdel(stream: string, ...ids: string[]): Promise<number> {
    const m = this.streamMap(stream);
    let deleted = 0;
    for (const id of ids) if (m.delete(id)) deleted += 1;
    return deleted;
  }

  async xrange(stream: string, start: string, end: string, ...rest: (string | number)[]): Promise<StreamEntry[]> {
    const countIdx = rest.indexOf('COUNT');
    const count = countIdx >= 0 ? Number(rest[countIdx + 1]) : Infinity;
    const out: StreamEntry[] = [];
    for (const [id, fields] of this.streamMap(stream)) {
      if (start !== '-' && id < start) continue;
      if (end !== '+' && id > end) continue;
      out.push([id, [...fields]]);
      if (out.length >= count) break;
    }
    return out;
  }

  async xautoclaim(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    start: string,
    ...rest: (string | number)[]
  ): Promise<[string, StreamEntry[], string[]]> {
    const countIdx = rest.indexOf('COUNT');
    const count = countIdx >= 0 ? Number(rest[countIdx + 1]) : Infinity;
    this.requireGroup(stream, group);
    const pel = this.pelFor(stream, group);
    const streamEntries = this.streamMap(stream);
    const claimed: StreamEntry[] = [];
    const deleted: string[] = [];
    let nextStart = '0-0';

    for (const id of [...pel.keys()].sort()) {
      if (start !== '0-0' && id <= start) continue;
      if (claimed.length >= count) {
        nextStart = id;
        break;
      }
      const entry = pel.get(id);
      if (!entry) continue;
      // PEL entry for a message that was deleted from the stream: drop it
      // (real XAUTOCLAIM reports these in the deleted-ids array)
      if (!streamEntries.has(id)) {
        pel.delete(id);
        deleted.push(id);
        continue;
      }
      if (Date.now() - entry.deliveredAt >= minIdleMs) {
        entry.consumer = consumer;
        entry.deliveredAt = Date.now();
        claimed.push([id, [...streamEntries.get(id)!]]);
      }
    }
    return [nextStart, claimed, deleted];
  }

  async xpending(stream: string, group: string): Promise<[number, string | null, string | null, Array<[string, number]>]> {
    const pel = this.pelFor(stream, group);
    if (pel.size === 0) return [0, null, null, []];
    const ids = [...pel.keys()].sort();
    const perConsumer = new Map<string, number>();
    for (const entry of pel.values()) {
      perConsumer.set(entry.consumer, (perConsumer.get(entry.consumer) ?? 0) + 1);
    }
    return [pel.size, ids[0]!, ids[ids.length - 1]!, [...perConsumer.entries()]];
  }

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<number | Record<string, unknown>> {
    if (script.includes(DEDUP_SCRIPT_MARKER)) {
      const key = args[0] as string;
      const value = args[1] as string;
      if (this.dedup.has(key)) return 0;
      this.dedup.set(key, value);
      return 1;
    }
    if (script.includes(NACK_SCRIPT_MARKER)) {
      return this.nackScript(args as [string, string, string, string, string, string]);
    }
    throw new Error('FakeRedis: eval called with an unsupported Lua script');
  }

  private nackScript(args: [string, string, string, string, string, string]): Record<string, unknown> {
    const [stream, dlq, taskId, reason, group, maxAttemptsStr] = args;
    const maxAttempts = Number(maxAttemptsStr);
    const streamEntries = this.streamMap(stream);
    const match = [...streamEntries.entries()].find(([id]) => id === taskId);
    if (!match) throw new Error('message_not_found');
    const [id, fields] = match;
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) data[fields[i]!] = fields[i + 1]!;
    const task = JSON.parse(data.task ?? '{}') as Record<string, unknown>;
    task.attempts = ((task.attempts as number | undefined) ?? 0) + 1;

    const newArgs: string[] = ['task', JSON.stringify(task)];
    const dlqArgs: string[] = ['task', JSON.stringify(task), 'reason', reason];
    if (task._traceparent) {
      newArgs.push('traceparent', String(task._traceparent));
      dlqArgs.push('traceparent', String(task._traceparent));
    }

    if ((task.attempts as number) >= maxAttempts) {
      this.streamMap(dlq).set(this.nextId(), dlqArgs);
    } else {
      streamEntries.set(this.nextId(), newArgs);
    }
    this.pelFor(stream, group).delete(id);
    streamEntries.delete(id);
    return { ok: (task.attempts as number) >= maxAttempts ? 'dead_lettered' : 'reenqueued', attempts: task.attempts };
  }

  // Generic kv surface (not used by RedisStreamQueue, kept for completeness)
  async set(key: string, value: string): Promise<string> {
    this.kv.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.kv.delete(key)) deleted += 1;
    return deleted;
  }

  async quit(): Promise<string> {
    return 'OK';
  }

  disconnect(): void {
    // no-op
  }
}

export function createFakeRedis(): FakeRedis {
  return new FakeRedis();
}
