export interface Task {
  taskId: string;
  sessionId: string;
  promptId?: string;
  promptVersion?: number;
  provider: string;
  model: string;
  scenario: string;
  config: Record<string, unknown>;
  enqueuedAt: string;
  attempts: number;
  /** Epoch ms — not ready for delivery before this time (retry backoff). */
  dueAt?: number;
  /** Idempotency key — if set, duplicate enqueues with the same key are silently ignored. */
  idempotencyKey?: string;
  _redisId?: string;
  _traceparent?: string;
}

/** Max delivery attempts before a task dead-letters (in-memory hardcode + redis default). */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** True when `attempts` (0-based, incremented per nack) is the terminal one —
 *  the nack dead-letters instead of requeuing. Single convention shared by
 *  the runner and both queue drivers. */
export function isTerminalAttempt(attempts: number, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): boolean {
  return attempts + 1 >= maxAttempts;
}

export interface TaskQueue {
  enqueue(task: Task): Promise<void>;
  dequeue(timeoutMs?: number): Promise<Task | null>;
  ack(taskId: string): Promise<void>;
  nack(taskId: string, reason?: string): Promise<void>;
  /** Delivery attempts after which nack dead-letters instead of requeuing. */
  maxAttempts?: number;
  size(): Promise<number>;
  /** Number of tasks waiting to be processed (not in-flight). */
  pendingCount(): Promise<number>;
  deadLetterSize(): Promise<number>;
  deadLetterPeek(limit: number): Promise<Task[]>;
  deadLetterRetry(taskId: string): Promise<boolean>;
  close(): Promise<void>;
}
