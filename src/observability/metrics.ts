import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const taskCounter = new client.Counter({
  name: 'arena_tasks_total',
  help: 'Total tasks processed',
  labelNames: ['model', 'scenario', 'status'],
  registers: [register],
});

export const taskDuration = new client.Histogram({
  name: 'arena_task_duration_seconds',
  help: 'Task execution duration',
  labelNames: ['model', 'scenario'],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [register],
});

export const activeTasks = new client.Gauge({
  name: 'arena_tasks_active',
  help: 'Currently running tasks',
  registers: [register],
});

export const queueDepth = new client.Gauge({
  name: 'arena_queue_depth',
  help: 'Current queue depth',
  labelNames: ['provider'],
  registers: [register],
});

export async function metricsHandler(_req: unknown, res: { set: (k: string, v: string) => void; end: (body: string) => void }) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}
