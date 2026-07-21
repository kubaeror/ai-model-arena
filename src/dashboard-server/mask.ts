export function maskSecret(value: string | undefined): string {
  if (!value) return '(unset)';
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}
