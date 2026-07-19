import type { ChatMessage, ModelResponse, ToolDefinition, Logger, TokenUsage } from '../types.js';
import type { ModelConfig } from '../config.js';

/** Contract every provider adapter implements. */
export interface ModelAdapter {
  sendMessage(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse>;
}

/** Error carrying an HTTP status, so the retry policy can decide. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public retryAfterMs?: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

/**
 * Shared base providing exponential-backoff retry around the actual provider
 * HTTP call. Retryable conditions: HTTP 429, HTTP 5xx, and network failures
 * (fetch TypeError / ECONN* / ETIMEDOUT). Honours Retry-After when present.
 */
export abstract class BaseAdapter implements ModelAdapter {
  constructor(protected config: ModelConfig, protected logger?: Logger) {}

  abstract sendMessage(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse>;

  protected get retry(): RetryConfig {
    const r = this.config.retry;
    return {
      maxRetries: r?.maxRetries ?? 3,
      initialDelayMs: r?.initialDelayMs ?? 1000,
      maxDelayMs: r?.maxDelayMs ?? 30000,
    };
  }

  protected isRetryable(err: unknown): boolean {
    if (err instanceof HttpError) {
      return err.status === 429 || err.status >= 500;
    }
    if (err instanceof Error) {
      const name = err.name;
      const msg = err.message;
      if (name === 'TypeError') return true; // fetch failures throw TypeError
      return /fetch|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN/i.test(msg);
    }
    return false;
  }

  protected async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const { maxRetries, initialDelayMs, maxDelayMs } = this.retry;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt >= maxRetries || !this.isRetryable(err)) throw err;
        const backoff = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);
        const jitter = Math.floor(Math.random() * 250);
        let delay = backoff + jitter;
        if (err instanceof HttpError && err.retryAfterMs != null) {
          delay = Math.max(delay, err.retryAfterMs);
        }
        this.logger?.warn('Retrying API call', {
          attempt: attempt + 1,
          of: maxRetries,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(delay);
      }
    }
    throw lastErr;
  }
}

/** Sum token usage into an accumulator (mutates acc). */
export function addUsage(acc: TokenUsage, u?: TokenUsage): void {
  if (!u) return;
  acc.prompt = (acc.prompt ?? 0) + (u.prompt ?? 0);
  acc.completion = (acc.completion ?? 0) + (u.completion ?? 0);
  acc.total = (acc.total ?? 0) + (u.total ?? 0);
}
