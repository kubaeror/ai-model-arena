import type { Task, TaskQueue } from './types.js';
import { DEFAULT_MAX_ATTEMPTS, isTerminalAttempt } from './types.js';
import { queueDepth, dlqDepth } from '../observability/metrics.js';

interface Waiter {
  resolve: (t: Task | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class InMemoryQueue implements TaskQueue {
  readonly maxAttempts = DEFAULT_MAX_ATTEMPTS;
  private pending: Task[] = [];
  private inFlight = new Map<string, Task>();
  private waiters: Waiter[] = [];
  private dead: Task[] = [];
  private dedupKeys = new Map<string, number>(); // key → timestamp
  private dedupTtlMs = 86_400_000; // 24 hours
  private retryBackoffMs = 2000;

  private _notifyNext(): void {
    const w = this.waiters.shift();
    if (!w) return;
    // Skip not-yet-due tasks (retry backoff) so the in-memory driver honors
    // dueAt exactly like the redis driver.
    const t = this.findDue();
    if (t) {
      if (w.timer) clearTimeout(w.timer);
      this.inFlight.set(t.taskId, t);
      this.syncQueueDepth();
      w.resolve(t);
    } else {
      // nothing to give, re-queue the waiter
      this.waiters.unshift(w);
    }
  }

  /** First due task (dueAt unset or in the past), leaving not-due tasks queued. */
  private findDue(): Task | undefined {
    for (let i = 0; i < this.pending.length; i++) {
      const t = this.pending[i]!;
      if (!t.dueAt || t.dueAt <= Date.now()) {
        return this.pending.splice(i, 1)[0]!;
      }
    }
    return undefined;
  }

  private syncQueueDepth(): void {
    queueDepth.set({ provider: 'in-memory' }, this.pending.length);
  }

  private syncDlqDepth(): void {
    dlqDepth.set({ provider: 'in-memory' }, this.dead.length);
  }

  async enqueue(task: Task): Promise<void> {
    // Idempotency guard: skip if a task with the same key was enqueued recently
    if (task.idempotencyKey) {
      const prev = this.dedupKeys.get(task.idempotencyKey);
      if (prev && Date.now() - prev < this.dedupTtlMs) return;
      this.dedupKeys.set(task.idempotencyKey, Date.now());
    }
    this.pending.push(task);
    this.syncQueueDepth();
    this._notifyNext();
  }

  async dequeue(timeoutMs = 30000): Promise<Task | null> {
    const t = this.findDue();
    if (t) {
      this.inFlight.set(t.taskId, t);
      this.syncQueueDepth();
      return t;
    }
    return new Promise<Task | null>((resolve) => {
      const waiter: Waiter = { resolve, timer: null };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
      }
      this.waiters.push(waiter);
      // check if something arrived while we were setting up
      this._notifyNext();
    });
  }

  async ack(taskId: string): Promise<void> {
    this.inFlight.delete(taskId);
    this.syncQueueDepth();
  }

  async nack(taskId: string, _reason?: string): Promise<void> {
    const t = this.inFlight.get(taskId);
    if (t) {
      this.inFlight.delete(taskId);
      t.attempts += 1;
      if (isTerminalAttempt(t.attempts, this.maxAttempts)) {
        this.dead.push(t);
        this.syncQueueDepth();
        this.syncDlqDepth();
        return;
      }
      // Mirror redis.ts nack: exponential backoff doubling per attempt,
      // capped at 5 minutes. dueAt keeps the task hidden from dequeue.
      t.dueAt = Date.now() + Math.min(this.retryBackoffMs * Math.pow(2, t.attempts - 1), 300_000);
      this.pending.push(t);
      this.syncQueueDepth();
      this._notifyNext();
    }
  }

  async size(): Promise<number> {
    return this.pending.length + this.inFlight.size;
  }

  async pendingCount(): Promise<number> {
    return this.pending.length;
  }

  async deadLetterSize(): Promise<number> {
    return this.dead.length;
  }

  async deadLetterPeek(limit: number): Promise<Task[]> {
    return this.dead.slice(0, limit);
  }

  async deadLetterRetry(taskId: string): Promise<boolean> {
    const idx = this.dead.findIndex((t) => t.taskId === taskId);
    if (idx < 0) return false;
    const [t] = this.dead.splice(idx, 1);
    if (!t) return false;
    t.attempts = 0;
    delete t.dueAt; // retried tasks are immediately ready
    this.pending.unshift(t);
    this.syncQueueDepth();
    this.syncDlqDepth();
    this._notifyNext();
    return true;
  }

  async close(): Promise<void> {
    // No-op — in-memory state is lost on process exit.
  }
}
