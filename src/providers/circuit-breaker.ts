export class CircuitOpenError extends Error {
  constructor(provider: string, model: string) {
    super(`Circuit open for ${provider}/${model}`);
    this.name = 'CircuitOpenError';
  }
}

export type CircuitState = 'closed' | 'open' | 'halfOpen';

export interface CircuitBreakerConfig {
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

  constructor(config: CircuitBreakerConfig = {}) {
    this.threshold = config.failureThreshold ?? 5;
    this.resetMs = config.resetTimeoutMs ?? 30000;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.resetMs) {
        this.state = 'halfOpen';
      } else {
        throw new CircuitOpenError('', '');
      }
    }

    try {
      const result = await fn();
      if (this.state === 'halfOpen') {
        this.state = 'closed';
        this.failures = 0;
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
      }
      throw err;
    }
  }

  static for(provider: string, model: string): CircuitBreaker {
    const key = `${provider}:${model}`;
    let cb = breakers.get(key);
    if (!cb) {
      cb = new CircuitBreaker();
      breakers.set(key, cb);
    }
    return cb;
  }

  static cleanup(): void {
    const now = Date.now();
    for (const [key, breaker] of breakers) {
      if (breaker.state === 'closed' || breaker.state === 'halfOpen') {
        breakers.delete(key);
      } else if (breaker.state === 'open' && (now - breaker.openedAt > 3_600_000)) {
        breakers.delete(key);
      }
    }
  }
}
