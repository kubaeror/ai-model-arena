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

export const auditFailures = new client.Counter({
  name: 'arena_audit_failures_total',
  help: 'Total audit log write failures',
  registers: [register],
});

export const scheduleFailures = new client.Counter({
  name: 'arena_schedule_failures_total',
  help: 'Total scheduler job failures',
  labelNames: ['schedule_id'],
  registers: [register],
});

export const dlqDepth = new client.Gauge({
  name: 'arena_dlq_depth',
  help: 'Dead-letter queue depth',
  labelNames: ['provider'],
  registers: [register],
});

export const circuitState = new client.Gauge({
  name: 'arena_circuit_state',
  help: 'Circuit breaker state (1 = open, 0 = closed)',
  labelNames: ['provider', 'model'],
  registers: [register],
});

export const budgetPercent = new client.Gauge({
  name: 'arena_budget_percent',
  help: 'Budget percent used per model',
  labelNames: ['model'],
  registers: [register],
});

export const apiErrors = new client.Counter({
  name: 'arena_api_errors_total',
  help: 'Total terminal API request errors per provider',
  labelNames: ['provider'],
  registers: [register],
});

export const tasksClaimed = new client.Counter({
  name: 'arena_tasks_claimed_total',
  help: 'Total tasks claimed by runners',
  registers: [register],
});

export const tasksFailed = new client.Counter({
  name: 'arena_tasks_failed_total',
  help: 'Total tasks that failed terminally',
  registers: [register],
});

export const providerLatency = new client.Histogram({
  name: 'arena_provider_latency_seconds',
  help: 'Provider request latency in seconds',
  labelNames: ['provider'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export async function metricsHandler(_req: unknown, res: { set: (k: string, v: string) => void; end: (body: string) => void }) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

/**
 * Minimal /metrics HTTP server for processes without one (the runner).
 * Prometheus scrapes RUNNER_METRICS_PORT (default 4001); without this the
 * runner's prom-client counters were never exported anywhere.
 */
export function startMetricsServer(port = Number(process.env.RUNNER_METRICS_PORT ?? 4001)): void {
  import('node:http').then(({ createServer }) => {
    const server = createServer(async (req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
    });
    server.listen(port, () => {
      console.error(`[ai-arena] Prometheus metrics on :${port}/metrics`);
    });
  }).catch(() => { /* metrics server is best-effort */ });
}
