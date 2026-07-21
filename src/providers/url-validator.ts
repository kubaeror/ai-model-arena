import { URL } from 'node:url';

/**
 * SSRF-safe URL validator for custom provider endpoints.
 * Rejects endpoints that target internal/private infrastructure.
 */

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^169\.254\.\d+\.\d+$/,         // link-local
  /^10\.\d+\.\d+\.\d+$/,           // private A
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/, // private B
  /^192\.168\.\d+\.\d+$/,          // private C
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/, // CGNAT
  /^fc00:/i,                       // IPv6 ULA
  /^fe80:/i,                       // IPv6 link-local
  /^::1$/i,                        // IPv6 loopback
  /^::ffff:127\./,                 // IPv4-mapped loopback
];

const BLOCKED_SUFFIXES = [
  '.local',
  '.internal',
  '.cluster.local',
  '.svc',
  '.svc.cluster.local',
];

export type UrlValidationResult = { ok: true; normalized: string } | { ok: false; error: string };

export function validateProviderUrl(raw: string, allowHttp?: boolean): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Try adding a protocol if missing
    if (!/^https?:\/\//i.test(raw)) {
      try {
        parsed = new URL('https://' + raw);
      } catch {
        return { ok: false, error: `Invalid URL: "${raw}"` };
      }
    } else {
      return { ok: false, error: `Invalid URL: "${raw}"` };
    }
  }

  // Enforce HTTPS by default
  if (parsed.protocol !== 'https:' && !(allowHttp ?? false)) {
    return { ok: false, error: 'Only HTTPS URLs are allowed. Set allowHttp=true for local dev endpoints.' };
  }

  // Block non-standard ports by default
  const port = parsed.port ? parseInt(parsed.port, 10) : null;
  if (port !== null && port !== 443 && port !== 80) {
    return { ok: false, error: `Non-standard port ${port} is not allowed.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Check against blocked IP patterns
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      return { ok: false, error: `Provider URL targets a blocked address: ${hostname}` };
    }
  }

  // Check against blocked suffixes
  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { ok: false, error: `Provider URL targets a blocked domain suffix: ${suffix}` };
    }
  }

  // Block metadata endpoints
  if (hostname === 'metadata.google.internal' ||
      hostname === '169.254.169.254' ||
      hostname === 'metadata.tencentyun.com') {
    return { ok: false, error: `Provider URL targets a cloud metadata endpoint: ${hostname}` };
  }

  return { ok: true, normalized: parsed.origin };
}
