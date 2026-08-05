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
  /** Priority: 0 (highest) to 255 (lowest). Default: 128. */
  priority?: number;
  /** Idempotency key — if set, duplicate enqueues with the same key are silently ignored. */
  idempotencyKey?: string;
  _redisId?: string;
  _traceparent?: string;
}

export interface TaskQueue {
  enqueue(task: Task): Promise<void>;
  dequeue(timeoutMs?: number): Promise<Task | null>;
  ack(taskId: string): Promise<void>;
  nack(taskId: string, reason?: string): Promise<void>;
  size(): Promise<number>;
  /** Number of tasks waiting to be processed (not in-flight). */
  pendingCount?(): Promise<number>;
  deadLetterSize?(): Promise<number>;
  deadLetterPeek?(limit: number): Promise<Task[]>;
  deadLetterRetry?(taskId: string): Promise<boolean>;
  close?(): Promise<void>;
}
