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
    await this.redis.xadd(stream, '*', 'task', JSON.stringify(task));
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
        (task as unknown as { _redisId: string })._redisId = id;
        return task;
      }
    }
    return null;
  }

  async ack(_taskId: string): Promise<void> {
    // XACK requires the redis message id tracked on the task.
    // Full impl wires the _redisId through the runner.
  }

  async nack(_taskId: string, _reason?: string): Promise<void> {
    // nack bumps attempts; over maxAttempts → DLQ.
    // Full impl wires the _redisId through the runner.
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
