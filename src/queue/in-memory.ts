import type { Task, TaskQueue } from './types.js';
import { queueDepth } from '../observability/metrics.js';

interface Waiter {
  resolve: (t: Task | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class InMemoryQueue implements TaskQueue {
  private pending: Task[] = [];
  private inFlight = new Map<string, Task>();
  private waiters: Waiter[] = [];
  private dead: Task[] = [];
  private dedupKeys = new Map<string, number>(); // key → timestamp
  private dedupTtlMs = 86_400_000; // 24 hours

  private _notifyNext(): void {
    const w = this.waiters.shift();
    if (!w) return;
    const t = this.pending.shift();
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

  private syncQueueDepth(): void {
    queueDepth.set({ provider: 'in-memory' }, this.pending.length);
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
    const t = this.pending.shift();
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
      if (t.attempts >= 5) {
        this.dead.push(t);
        this.syncQueueDepth();
        return;
      }
      this.pending.unshift(t);
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
    this.pending.unshift(t);
    this.syncQueueDepth();
    this._notifyNext();
    return true;
  }

  async close(): Promise<void> {
    // No-op — in-memory state is lost on process exit.
  }
}
