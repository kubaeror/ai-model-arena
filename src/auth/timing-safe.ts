import crypto from 'node:crypto';

/** Constant-time string comparison (HMAC-SHA256 pre-hash, safe for unequal lengths). */
export function timingSafeEqual(a: string, b: string): boolean {
  const key = Buffer.alloc(32, 0);
  const ha = crypto.createHmac('sha256', key).update(a).digest();
  const hb = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
