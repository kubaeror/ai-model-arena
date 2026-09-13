// Container entrypoint: starts the runner loop.
// Called by Docker CMD. Separate from src/runner.ts so the runner module
// can be imported (e.g. from tests or the CLI) without auto-starting.
import { startRunner } from './runner.js';
import { startOtel } from './observability/otel.js';
import { startOtelMetrics } from './observability/otel-metrics.js';
import { loadFallbackChainFromEnv } from './providers/fallback.js';

startOtel();
const stopOtelMetrics = startOtelMetrics('ai-arena-runner');

process.on('SIGTERM', () => stopOtelMetrics());
process.on('SIGINT', () => stopOtelMetrics());

startRunner({ fallbackChain: loadFallbackChainFromEnv() }).catch((err) => {
  console.error('Runner crashed', err);
  process.exit(1);
});
