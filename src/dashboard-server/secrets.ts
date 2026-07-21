const SENSITIVE_KEYS = /(api.?key|secret|password|token|auth|credential)/i;

export function maskSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 10) return obj;
  if (Array.isArray(obj)) return obj.map(e => maskSecrets(e, depth + 1));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.test(k)) {
        out[k] = '***';
      } else {
        out[k] = maskSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}
