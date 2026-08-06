import { SENSITIVE_KEYS } from '../secrets/sensitive-keys.js';

// Exact-name matching preserves the historical anchored behavior of this
// module: compound field names like `tokenUsage` or `credentialRef` must not
// be masked (SENSITIVE_KEYS itself is a substring pattern shared with
// src/secrets/store.ts, whose listing semantics are substring-based).
const SENSITIVE_KEY_EXACT = new RegExp(`^(?:${SENSITIVE_KEYS.source})$`, 'i');

export function maskSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 10) return obj;
  if (Array.isArray(obj)) return obj.map(e => maskSecrets(e, depth + 1));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEY_EXACT.test(k)) {
        out[k] = '***';
      } else {
        out[k] = maskSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}
