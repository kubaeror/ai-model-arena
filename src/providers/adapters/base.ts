import type { ChatMessage, ToolDefinition, ModelResponse, Logger } from '../../types.js';

export interface SendOpts {
  reasoning?: { type: 'effort' | 'toggle' | 'budget_tokens'; value?: string | number };
  temperature?: number;
  maxTokens?: number;
}

export interface ModelAdapter {
  sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse>;
  supportsStreaming(): boolean;
  supportsReasoning(): boolean;
  supportsPromptCaching(): boolean;
}

export class HttpError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

const RETRYABLE_MESSAGES = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed/;

export abstract class BaseAdapter {
  protected logger?: Logger;
  protected timeoutMs = 60_000;
  constructor(logger?: Logger) { this.logger = logger; }

  /**
   * Shared JSON POST with a sane default timeout. Adapters supply their own
   * auth headers (Bearer, x-api-key, x-goog-api-key, sigv4 — see bedrock).
   */
  protected async post(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  protected isRetryable(err: unknown): boolean {
    if (err instanceof HttpError) return err.status === 429 || (err.status >= 500 && err.status < 600);
    if (err instanceof Error) return RETRYABLE_MESSAGES.test(err.message);
    return false;
  }

  protected async withRetry<T>(
    fn: () => Promise<T>,
    opts: { maxRetries: number; initialDelayMs: number; maxDelayMs: number },
  ): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= opts.maxRetries) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!this.isRetryable(err) || attempt === opts.maxRetries) throw err;
        const delay = Math.min(opts.initialDelayMs * Math.pow(2, attempt), opts.maxDelayMs);
        await new Promise(r => setTimeout(r, delay + Math.random() * 250));
        attempt++;
      }
    }
    throw lastErr;
  }
}
