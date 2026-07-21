import { Redis } from 'ioredis';
import type { Task, TaskQueue } from './types.js';
import type { RedisQueueConfig } from './redis-config.js';

function streamKey(prefix: string, provider: string): string {
  return `${prefix}:${provider}`;
}

function dlqStreamKey(prefix: string, provider: string): string {
  return `${prefix}:${provider}:dlq`;
}

export class RedisStreamQueue implements TaskQueue {
  private redis: Redis;
  private config: RedisQueueConfig;

  constructor(config: RedisQueueConfig) {
    this.config = config;
    this.redis = new Redis(config.url);
  }

  private async ensureGroup(stream: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', stream, this.config.consumerGroup, '$', 'MKSTREAM');
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes('BUSYGROUP')) throw e;
    }
  }

  async enqueue(task: Task): Promise<void> {
    const stream = streamKey(this.config.streamPrefix, task.provider);
    await this.ensureGroup(stream);
    const fields: (string | number)[] = ['task', JSON.stringify(task)];
    if (task._traceparent) fields.push('traceparent', task._traceparent);
    await this.redis.xadd(stream, '*', ...fields);
  }

  async dequeue(timeoutMs = 30000): Promise<Task | null> {
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
        const task = JSON.parse(taskData.task ?? '{}') as Task;
        task._redisId = id;
        if (taskData.traceparent) task._traceparent = taskData.traceparent;
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
  }

  async nack(taskId: string, reason?: string): Promise<void> {
    const provider = this.config.providerFilter;
    if (!provider) return;
    const stream = streamKey(this.config.streamPrefix, provider);

    // Claim the message to get its data
    const msgs = await this.redis.xrange(stream, taskId, taskId);
    if (msgs.length === 0) return;

    const [, fields] = msgs[0]!;
    const taskData: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) taskData[fields[i]!] = fields[i + 1]!;
    const task = JSON.parse(taskData.task ?? '{}}') as Task;
    task.attempts = (task.attempts ?? 0) + 1;

    if (task.attempts >= this.config.maxAttempts) {
      const dlq = dlqStreamKey(this.config.streamPrefix, provider);
      const dlqFields: (string | number)[] = ['task', JSON.stringify(task), 'reason', reason ?? ''];
      await this.redis.xadd(dlq, '*', ...dlqFields);
      await this.redis.xack(stream, this.config.consumerGroup, taskId);
      await this.redis.xdel(stream, taskId);
    } else {
      // Re-add with bumped attempts to the same stream, then ACK+DEL old
      const newFields: (string | number)[] = ['task', JSON.stringify(task)];
      if (task._traceparent) newFields.push('traceparent', task._traceparent);
      await this.redis.xadd(stream, '*', ...newFields);
      await this.redis.xack(stream, this.config.consumerGroup, taskId);
      await this.redis.xdel(stream, taskId);
    }
  }

  async size(): Promise<number> {
    const provider = this.config.providerFilter;
    if (!provider) return 0;
    const stream = streamKey(this.config.streamPrefix, provider);
    try { return await this.redis.xlen(stream); } catch { return 0; }
  }

  async dlqSize(): Promise<number> {
    const provider = this.config.providerFilter;
    if (!provider) return 0;
    const dlqStream = dlqStreamKey(this.config.streamPrefix, provider);
    try { return await this.redis.xlen(dlqStream); } catch { return 0; }
  }
}
