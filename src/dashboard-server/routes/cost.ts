export function maskSecret(value: string | undefined): string {
  if (!value) return '(unset)';
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

export function maskProviderSecrets(providers: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return providers.map(p => ({
    ...p,
    apiKey: maskSecret(p.apiKey as string | undefined),
    api_key: maskSecret(p.api_key as string | undefined),
    env_var_value: maskSecret(p.env_var_value as string | undefined),
  }));
}
