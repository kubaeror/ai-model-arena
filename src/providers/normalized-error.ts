export enum NormalizedErrorType {
  RateLimited = 'rate_limited',
  AuthenticationFailed = 'authentication_failed',
  AuthorizationFailed = 'authorization_failed',
  ModelNotFound = 'model_not_found',
  ModelUnavailable = 'model_unavailable',
  ContextExceeded = 'context_exceeded',
  OutputLimitExceeded = 'output_limit_exceeded',
  BadRequest = 'bad_request',
  ServerError = 'server_error',
  Timeout = 'timeout',
  ConnectionFailed = 'connection_failed',
  CircuitOpen = 'circuit_open',
  Unknown = 'unknown',
}

export class NormalizedProviderError extends Error {
  constructor(
    public type: NormalizedErrorType,
    public providerId: string,
    public modelId: string,
    public statusCode: number | null,
    public rawMessage: string,
    /** Whether this error is retryable. */
    public retryable: boolean,
  ) {
    super(`[${type}] ${providerId}/${modelId}: ${rawMessage}`);
    this.name = 'NormalizedProviderError';
  }

  static fromHttpError(
    status: number,
    body: string,
    provider: string,
    model: string,
  ): NormalizedProviderError {
    if (status === 429) {
      return new NormalizedProviderError(NormalizedErrorType.RateLimited, provider, model, status, body, true);
    }
    if (status === 401) {
      return new NormalizedProviderError(NormalizedErrorType.AuthenticationFailed, provider, model, status, body, false);
    }
    if (status === 403) {
      return new NormalizedProviderError(NormalizedErrorType.AuthorizationFailed, provider, model, status, body, false);
    }
    if (status === 404) {
      return new NormalizedProviderError(NormalizedErrorType.ModelNotFound, provider, model, status, body, false);
    }
    if (status === 400 && /context.*(length|exceed|too.*long|token)/i.test(body)) {
      return new NormalizedProviderError(NormalizedErrorType.ContextExceeded, provider, model, status, body, false);
    }
    if (status >= 500 && status < 600) {
      return new NormalizedProviderError(NormalizedErrorType.ServerError, provider, model, status, body, true);
    }
    return new NormalizedProviderError(NormalizedErrorType.BadRequest, provider, model, status, body, false);
  }

  static fromConnectionError(
    err: Error,
    provider: string,
    model: string,
  ): NormalizedProviderError {
    const msg = err.message;
    if (/timeout|timed.?out/i.test(msg)) {
      return new NormalizedProviderError(NormalizedErrorType.Timeout, provider, model, null, msg, true);
    }
    if (/econnrefused|econnreset|enotfound|eai_again|socket hang up/i.test(msg)) {
      return new NormalizedProviderError(NormalizedErrorType.ConnectionFailed, provider, model, null, msg, true);
    }
    return new NormalizedProviderError(NormalizedErrorType.Unknown, provider, model, null, msg, false);
  }
}
