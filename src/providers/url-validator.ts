import { URL } from 'node:url';
import { isPrivateHost, resolvePublicHost, type LookupAll } from './ip-ranges.js';

/**
 * SSRF-safe URL validator for custom provider endpoints.
 * Rejects endpoints that target internal/private infrastructure.
 */

type UrlValidationResult = { ok: true; normalized: string } | { ok: false; error: string };

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

  if (isPrivateHost(hostname)) {
    return { ok: false, error: `Provider URL targets a blocked address: ${hostname}` };
  }

  return { ok: true, normalized: parsed.origin };
}

export interface AssertPublicUrlOptions {
  lookup?: LookupAll;
}

/**
 * Async SSRF gate for one-shot fetches: parse, literal host/range checks, then
 * DNS-resolve every answer and require all of them public. Throws on failure.
 */
export async function assertPublicUrl(raw: string, options: AssertPublicUrlOptions = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: "${raw}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol "${parsed.protocol}". Only http and https are allowed.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs with credentials (userinfo) are not allowed.');
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`Access to private/internal host "${parsed.hostname}" is blocked.`);
  }

  await resolvePublicHost(parsed.hostname, options.lookup);
  return parsed;
}
