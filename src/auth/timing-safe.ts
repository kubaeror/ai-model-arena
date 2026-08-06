import crypto from 'node:crypto';

/**
 * Constant-time string comparison, safe for unequal lengths.
 *
 * Both values are zero-padded to the longer input's length so the comparison
 * cost does not depend on content. Callers compare user input against
 * fixed-length stored secrets (argon2 hashes, generated API keys, admin
 * config), so the padded length is never secret and stored values never
 * contain NUL bytes (which would be indistinguishable from padding).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(Buffer.byteLength(a, 'utf8'), Buffer.byteLength(b, 'utf8'));
  const ba = Buffer.alloc(maxLen);
  const bb = Buffer.alloc(maxLen);
  ba.write(a, 0, 'utf8');
  bb.write(b, 0, 'utf8');
  return crypto.timingSafeEqual(ba, bb);
}
