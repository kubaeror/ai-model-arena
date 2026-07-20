import { InMemoryQueue } from './in-memory.js';
import type { TaskQueue } from './types.js';

export function createQueue(): TaskQueue {
  const driver = process.env.QUEUE_DRIVER ?? 'memory';
  if (driver === 'memory') return new InMemoryQueue();
  throw new Error(`Unknown QUEUE_DRIVER: ${driver}`);
}

export type { TaskQueue, Task } from './types.js';
