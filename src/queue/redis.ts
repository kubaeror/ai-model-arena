import { Redis } from 'ioredis';
import { propagation, context } from '@opentelemetry/api';
import type { Task, TaskQueue } from './types.js';
import type { RedisQueueConfig } from './redis-config.js';
import { parseTask, safeParseTask } from './task-schema.js';
import { streamKey, dlqStreamKey } from './router.js';
import { queueDepth } from '../observability/metrics.js';

/**
 * Shared ioredis clients keyed by URL. The dashboard creates one queue
 * instance per provider on every request; without sharing, each would open
 * its own connection to the same Redis.
 */
const sharedClients = new Map<string, Redis>();

export class RedisStreamQueue implements TaskQueue {
  private redis: Redis;
  private config: RedisQueueConfig;
  private ownsClient: boolean;
  private reclaimTimer: ReturnType<typeof setInterval> | null = null;
  private reclaimStarted = false;

  constructor(config: RedisQueueConfig, client?: Redis) {
    this.config = config;
    if (client) {
      this.redis = client;
      this.ownsClient = false;
    } else {
      const existing = sharedClients.get(config.url);
      if (existing) {
        this.redis = existing;
        this.ownsClient = false;
      } else {
        this.redis = new Redis(config.url, {
          maxRetriesPerRequest: 3,
          retryStrategy(times: number) {
            return Math.min(times * 200, 3_000);
          },
          connectTimeout: 10_000,
          lazyConnect: false,
          protocol: 2,
        });
        sharedClients.set(config.url, this.redis);
        this.ownsClient = true;
      }
    }
  }

  private async setQueueDepthGauge(): Promise<void> {
    const provider = this.config.providerFilter;
    if (!provider) return;
    const stream = streamKey(this.config.streamPrefix, provider);
    try {
      queueDepth.set({ provider }, await this.redis.xlen(stream));
    } catch { /* best-effort — never fail queue ops */ }
  }

  private startReclaimLoop(): void {
    if (this.reclaimStarted) return;
    this.reclaimStarted = true;
    this.reclaimTimer = setInterval(() => {
      void this.reclaimOrphaned().catch(() => { /* silent */ });
    }, this.config.reclaimIntervalMs);
    if (this.reclaimTimer.unref) this.reclaimTimer.unref();
  }

  /**
   * Periodically claims messages that have been idle (pending in the PEL)
   * beyond reclaimIdleMs.  This recovers tasks from crashed or disconnected
   * consumers so they are not permanently orphaned.
   *
   * Uses XAUTOCLAIM which atomically claims pending messages and returns
   * their data in a single round-trip.
   */
  private async reclaimOrphaned(): Promise<void> {
    const provider = this.config.providerFilter;
    if (!provider) return;
    const stream = streamKey(this.config.streamPrefix, provider);

    try {
      let start = '0-0';

      while (true) {
        const result = await this.redis.xautoclaim(
          stream,
          this.config.consumerGroup,
          this.config.consumerName,
          this.config.reclaimIdleMs,
          start,
          'COUNT', 5,
        ) as [string, Array<[string, string[]]>];

        if (!Array.isArray(result) || result.length < 2) break;

        const nextStart = result[0] as string;
        const messages = result[1];

        if (!Array.isArray(messages) || messages.length === 0) break;

        for (const [id, fields] of messages) {
          const taskData: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            taskData[fields[i]!] = fields[i + 1]!;
          }

          let task: Task | null = null;
          try {
            task = safeParseTask(JSON.parse(taskData.task ?? '{}'));
          } catch {
            task = null;
          }

          if (task === null) {
            // Malformed message — quarantine it so one corrupt entry cannot
            // block reclaim of every other orphaned task in the stream.
            const dlq = dlqStreamKey(this.config.streamPrefix, provider);
            await this.redis.xadd(dlq, '*', 'task', taskData.task ?? '', 'reason', 'XAUTOCLAIM: invalid task payload');
            await this.redis.xdel(stream, id);
            continue;
          }

          if ((task.attempts ?? 0) >= this.config.maxAttempts) {
            const dlq = dlqStreamKey(this.config.streamPrefix, provider);
            const dlqFields: (string | number)[] = [
              'task', JSON.stringify(task),
              'reason', 'XAUTOCLAIM: max attempts exceeded',
            ];
            await this.redis.xadd(dlq, '*', ...dlqFields);
            await this.redis.xdel(stream, id);
          } else {
            task.attempts = (task.attempts ?? 0) + 1;
            const newFields: (string | number)[] = ['task', JSON.stringify(task)];
            if (task._traceparent) newFields.push('traceparent', task._traceparent);
            await this.redis.xadd(stream, '*', ...newFields);
            await this.redis.xdel(stream, id);
          }
        }

        start = nextStart ?? '0-0';
        if (start === '0-0') break; // no more pending
      }
    } catch {
      // reclaim failures are non-fatal — the loop will retry on next interval
    }
  }

  private async ensureGroup(stream: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', stream, this.config.consumerGroup, '$', 'MKSTREAM');
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes('BUSYGROUP')) throw e;
    }
  }

  async enqueue(task: Task): Promise<void> {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    if (carrier.traceparent) task._traceparent = carrier.traceparent;

    const stream = streamKey(this.config.streamPrefix, task.provider);

    // Idempotency guard: if the task has an idempotencyKey,
    // use SETNX to prevent duplicate enqueues within the TTL window
    if (task.idempotencyKey) {
      const dupKey = `arena:dedup:${task.idempotencyKey}`;
      try {
        // Atomic SET NX with TTL via Lua to prevent race conditions
        const script = `local v = redis.call('GET', KEYS[1]); if v then return 0; end; redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1;`;
        const ok = await this.redis.eval(script, 1, dupKey, task.taskId, '86400');
        if (ok === 0) return; // duplicate — skip
      } catch {
        // Redis unavailable — proceed without dedup rather than block
      }
    }

    await this.ensureGroup(stream);
    const fields: (string | number)[] = ['task', JSON.stringify(task)];
    if (task._traceparent) fields.push('traceparent', task._traceparent);
    await this.redis.xadd(stream, '*', ...fields);
    void this.setQueueDepthGauge();
  }

  async dequeue(timeoutMs = 30000): Promise<Task | null> {
    // Reclaim exists to recover tasks from crashed consumers — only a real
    // consumer that dequeues should run it. Admin-op instances (dashboard
    // queue reads) must never claim/requeue runner tasks.
    this.startReclaimLoop();
    const provider = this.config.providerFilter;
    if (!provider) throw new Error('Redis dequeue requires providerFilter (per-provider runner)');

    const stream = streamKey(this.config.streamPrefix, provider);
    await this.ensureGroup(stream);

    const results = await this.redis.xreadgroup(
      'GROUP', this.config.consumerGroup, this.config.consumerName,
      'COUNT', 1,
      'BLOCK', Math.max(timeoutMs, 0),
      'STREAMS', stream, '>',
    ) as [string, [string, string[]][]][] | null;

    if (!results || results.length === 0) return null;

    for (const [, messages] of results) {
      for (const [id, fields] of messages) {
        const taskData: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          taskData[fields[i]!] = fields[i + 1]!;
        }
        const task = parseTask(JSON.parse(taskData.task ?? '{}'));
        task._redisId = id;
        if (taskData.traceparent) task._traceparent = taskData.traceparent;
        if (task._traceparent) {
          propagation.extract(context.active(), { traceparent: task._traceparent });
        }
        return task;
      }
    }
    return null;
  }

  async ack(taskId: string): Promise<void> {
    const provider = this.config.providerFilter;
    if (!provider) return;
    const stream = streamKey(this.config.streamPrefix, provider);
    await this.redis.xack(stream, this.config.consumerGroup, taskId);
    void this.setQueueDepthGauge();
  }

  async nack(taskId: string, reason?: string): Promise<void> {
    const provider = this.config.providerFilter;
    if (!provider) return;
    const stream = streamKey(this.config.streamPrefix, provider);
    const group = this.config.consumerGroup;
    const dlq = dlqStreamKey(this.config.streamPrefix, provider);
    const maxAttempts = this.config.maxAttempts;

    // Atomic Lua script to prevent nack-vs-reclaim race condition.
    // Reads the message, bumps attempts, and atomically moves to DLQ or re-enqueues.
    const script = `
      local stream = KEYS[1]
      local dlq = KEYS[2]
      local taskId = ARGV[1]
      local reason = ARGV[2]
      local group = ARGV[3]
      local maxAttempts = tonumber(ARGV[4])

      -- Read the message from the stream (single message by exact ID)
      local msgs = redis.call('XRANGE', stream, taskId, taskId)
      if #msgs == 0 then
        -- Message already handled (reclaimed or deleted by another consumer)
        return {err = 'message_not_found'}
      end

      local fields = msgs[1][2]
      local data = {}
      for i = 1, #fields, 2 do
        data[fields[i]] = fields[i + 1]
      end

      local taskJson = data['task']
      if not taskJson then
        return {err = 'no_task_data'}
      end

      local task = cjson.decode(taskJson)
      task['attempts'] = (task['attempts'] or 0) + 1

      if task['attempts'] >= maxAttempts then
        -- Move to dead-letter queue
        local dlqArgs = {'task', cjson.encode(task), 'reason', reason}
        if task['_traceparent'] then
          table.insert(dlqArgs, 'traceparent')
          table.insert(dlqArgs, task['_traceparent'])
        end
        redis.call('XADD', dlq, '*', unpack(dlqArgs))
        redis.call('XACK', stream, group, taskId)
        redis.call('XDEL', stream, taskId)
        return {ok = 'dead_lettered', attempts = task['attempts']}
      else
        -- Re-enqueue with bumped attempts
        local newArgs = {'task', cjson.encode(task)}
        if task['_traceparent'] then
          table.insert(newArgs, 'traceparent')
          table.insert(newArgs, task['_traceparent'])
        end
        redis.call('XADD', stream, '*', unpack(newArgs))
        redis.call('XACK', stream, group, taskId)
        redis.call('XDEL', stream, taskId)
        return {ok = 'reenqueued', attempts = task['attempts']}
      end
    `;

    try {
      await this.redis.eval(script, 2, stream, dlq, taskId, reason ?? '', group, String(maxAttempts));
    } catch {
      // Fallback: if Lua eval fails (e.g., Redis version too old), try atomic pipeline as best-effort
      const msgs = await this.redis.xrange(stream, taskId, taskId);
      if (msgs.length === 0) return;

      const [, fields] = msgs[0]!;
      const taskData: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) taskData[fields[i]!] = fields[i + 1]!;
      const task = parseTask(JSON.parse(taskData.task ?? '{}'));
      task.attempts = (task.attempts ?? 0) + 1;

      if (task.attempts >= maxAttempts) {
        const dlqFields: (string | number)[] = ['task', JSON.stringify(task), 'reason', reason ?? ''];
        if (task._traceparent) { dlqFields.push('traceparent'); dlqFields.push(task._traceparent); }
        await this.redis.xadd(dlq, '*', ...dlqFields);
        await this.redis.xack(stream, group, taskId);
        await this.redis.xdel(stream, taskId);
      } else {
        const newFields: (string | number)[] = ['task', JSON.stringify(task)];
        if (task._traceparent) { newFields.push('traceparent'); newFields.push(task._traceparent); }
        await this.redis.xadd(stream, '*', ...newFields);
        await this.redis.xack(stream, group, taskId);
        await this.redis.xdel(stream, taskId);
      }
    }
    void this.setQueueDepthGauge();
  }

  async size(): Promise<number> {
    const provider = this.config.providerFilter;
    if (!provider) return 0;
    const stream = streamKey(this.config.streamPrefix, provider);
    try { return await this.redis.xlen(stream); } catch { return 0; }
  }

  async pendingCount(): Promise<number> {
    const provider = this.config.providerFilter;
    if (!provider) return 0;
    const stream = streamKey(this.config.streamPrefix, provider);
    const len = await this.redis.xlen(stream).catch(() => 0);
    const xpending = (await this.redis.xpending(stream, this.config.consumerGroup).catch(() => null)) as
      | [number, string | null, string | null, Array<[string, number]>]
      | null;
    if (xpending === null) return len; // no consumer group yet — nothing delivered
    return Math.max(0, len - (xpending[0] ?? 0));
  }

  async deadLetterSize(): Promise<number> {
    const provider = this.config.providerFilter;
    if (!provider) return 0;
    const dlqStream = dlqStreamKey(this.config.streamPrefix, provider);
    try { return await this.redis.xlen(dlqStream); } catch { return 0; }
  }

  async deadLetterPeek(limit = 20): Promise<Task[]> {
    const provider = this.config.providerFilter;
    if (!provider) return [];
    const dlqStream = dlqStreamKey(this.config.streamPrefix, provider);
    try {
      const msgs = await this.redis.xrange(dlqStream, '-', '+', 'COUNT', limit);
      return msgs
        .map(([, fields]) => {
          const data: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) data[fields[i]!] = fields[i + 1]!;
          const task = safeParseTask(JSON.parse(data.task ?? '{}'));
          if (!task) return null;
          return { ...task, dlqReason: data.reason } as Task & { dlqReason?: string };
        })
        .filter((t): t is Task & { dlqReason?: string } => t !== null);
    } catch {
      return [];
    }
  }

  async deadLetterRetry(taskId: string): Promise<boolean> {
    const provider = this.config.providerFilter;
    if (!provider) return false;
    const dlqStream = dlqStreamKey(this.config.streamPrefix, provider);
    const mainStream = streamKey(this.config.streamPrefix, provider);

    // DLQ entries get opaque auto-ids from XADD '*', so match the embedded
    // taskId field instead of treating the task id as a stream entry id.
    const msgs = await this.redis.xrange(dlqStream, '-', '+');
    let targetId: string | null = null;
    let fields: string[] = [];
    for (const [id, f] of msgs) {
      try {
        const data: Record<string, string> = {};
        for (let i = 0; i < f.length; i += 2) data[f[i]!] = f[i + 1]!;
        const task = safeParseTask(JSON.parse(data.task ?? '{}'));
        if (task && task.taskId === taskId) {
          targetId = id;
          fields = f;
          break;
        }
      } catch {
        // malformed entry — skip and keep scanning
      }
    }
    if (targetId === null) return false;

    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) data[fields[i]!] = fields[i + 1]!;
    const task = parseTask(JSON.parse(data.task ?? '{}'));
    task.attempts = 0; // reset attempts for the retry

    // Re-add to main stream
    const newFields: (string | number)[] = ['task', JSON.stringify(task)];
    if (task._traceparent) newFields.push('traceparent', task._traceparent);
    await this.redis.xadd(mainStream, '*', ...newFields);

    // Delete the matched DLQ entry (by its stream entry id)
    await this.redis.xdel(dlqStream, targetId);
    void this.setQueueDepthGauge();
    return true;
  }

  async close(): Promise<void> {
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
    if (!this.ownsClient) return; // shared client lives on for other instances
    sharedClients.delete(this.config.url);
    try {
      await Promise.race([
        this.redis.quit(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis quit timed out after 5s')), 5_000)),
      ]);
    } catch {
      this.redis.disconnect();
    }
  }
}
