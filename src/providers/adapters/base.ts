import type { ChatMessage, ToolDefinition, ModelResponse, Logger } from '../../types.js';

export interface SendOpts {
  reasoning?: { type: 'effort' | 'toggle' | 'budget_tokens'; value?: string | number };
  temperature?: number;
  maxTokens?: number;
}

export interface StreamChunk {
  text?: string;
  toolCallDelta?: { id?: string; name?: string; arguments?: string };
  usage?: { prompt?: number; completion?: number; total?: number };
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  finishReason?: string;
}

export interface ModelAdapter {
  sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse>;
  sendMessageStream?(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): AsyncIterable<StreamChunk>;
  supportsStreaming(): boolean;
  supportsReasoning(): boolean;
  supportsPromptCaching(): boolean;
  buildCacheBreakpoints?(messages: ChatMessage[]): ChatMessage[];
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
  constructor(logger?: Logger) { this.logger = logger; }

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
