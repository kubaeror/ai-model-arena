export function streamForProvider(provider: string, prefix = 'arena:tasks'): string {
  return `${prefix}:${provider}`;
}

export function dlqStreamForProvider(provider: string, prefix = 'arena:tasks'): string {
  return `${prefix}:${provider}:dlq`;
}
