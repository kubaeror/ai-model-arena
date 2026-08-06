import { circuitState } from '../observability/metrics.js';

export class CircuitOpenError extends Error {
  constructor(provider: string, model: string) {
    super(`Circuit open for ${provider}/${model}`);
    this.name = 'CircuitOpenError';
  }
}

type CircuitState = 'closed' | 'open' | 'halfOpen';

interface CircuitBreakerConfig {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

const breakers = new Map<string, CircuitBreaker>();

export class CircuitBreaker {
  state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly resetMs: number;
  private providerLabel?: string;
  private modelLabel?: string;

  constructor(config: CircuitBreakerConfig = {}) {
    this.threshold = config.failureThreshold ?? 5;
    this.resetMs = config.resetTimeoutMs ?? 30000;
  }

  private syncMetric(): void {
    if (!this.providerLabel) return; // anonymous breakers (direct `new`) emit nothing
    circuitState.set(
      { provider: this.providerLabel, model: this.modelLabel ?? '' },
      this.state === 'open' || this.state === 'halfOpen' ? 1 : 0,
    );
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.resetMs) {
        this.state = 'halfOpen';
      } else {
        throw new CircuitOpenError(this.providerLabel ?? '', this.modelLabel ?? '');
      }
    }

    try {
      const result = await fn();
      if (this.state === 'halfOpen') {
        this.state = 'closed';
        this.failures = 0;
        this.syncMetric();
      } else {
        this.failures = 0;
      }
      return result;
    } catch (err) {
      if (err instanceof CircuitOpenError) throw err;
      this.failures++;
      if (this.failures >= this.threshold) {
        this.state = 'open';
        this.openedAt = Date.now();
        this.syncMetric();
      }
      throw err;
    }
  }

  static for(provider: string, model: string, config: CircuitBreakerConfig = {}): CircuitBreaker {
    const key = `${provider}:${model}`;
    let cb = breakers.get(key);
    if (!cb) {
      cb = new CircuitBreaker(config);
      cb.providerLabel = provider;
      cb.modelLabel = model;
      breakers.set(key, cb);
    }
    return cb;
  }

  static cleanup(): void {
    const now = Date.now();
    for (const [key, breaker] of breakers) {
      const stale = breaker.state === 'closed' || breaker.state === 'halfOpen' ||
        (breaker.state === 'open' && (now - breaker.openedAt > 3_600_000));
      if (stale) {
        // Drop the prom-client series too — otherwise a deleted breaker
        // leaves a stale 1=open gauge value behind forever.
        if (breaker.providerLabel) {
          circuitState.remove({ provider: breaker.providerLabel, model: breaker.modelLabel ?? '' });
        }
        breakers.delete(key);
      }
    }
  }
}
