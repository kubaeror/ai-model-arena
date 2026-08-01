import { z } from 'zod/v4';
import { promises as dns } from 'node:dns';
import type { ToolExecutor } from '../types.js';

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FETCH_BYTES = 100_000;
const MAX_FETCH_BYTES = 1_048_576; // 1 MiB hard cap

// ── argument schemas ─────────────────────────────────────────────────────────

const WebFetchArgs = z.object({
  url: z.string().min(1),
  maxBytes: z.number().int().optional().default(DEFAULT_MAX_FETCH_BYTES),
}).strict();

const WebSearchArgs = z.object({
  query: z.string().min(1),
}).strict();

// ── shared helpers ───────────────────────────────────────────────────────────

function validateArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(args);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: `Invalid arguments: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
}

/**
 * Private / internal IP ranges and metadata endpoints blocked for SSRF
 * protection. Covers AWS, GCP, Azure, Alibaba, Oracle, and CGNAT.
 */
const PRIVATE_IP_RANGES = [
  /^0\.\d+\.\d+\.\d+$/,                       // 0.0.0.0/8 (this-network)
  /^10\.\d+\.\d+\.\d+$/,                      // 10.0.0.0/8 (private)
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d+\.\d+$/, // 100.64.0.0/10 (CGNAT)
  /^127\.\d+\.\d+\.\d+$/,                     // 127.0.0.0/8 (loopback)
  /^169\.254\.\d+\.\d+$/,                     // 169.254.0.0/16 (link-local + cloud metadata)
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,      // 172.16.0.0/12 (private)
  /^192\.0\.0\.\d+$/,                         // 192.0.0.0/24 (IETF protocol assignments)
  /^192\.168\.\d+\.\d+$/,                     // 192.168.0.0/16 (private)
  /^198\.(1[8-9])\.\d+\.\d+$/,               // 198.18.0.0/15 (benchmark)
  /^::1$/,                                     // IPv6 loopback
  /^::$/,                                      // IPv6 unspecified
  /^fe[89ab][0-9a-f]:/i,                      // IPv6 link-local (fe80::/10)
  /^fc00:/i,                                   // IPv6 unique-local (fc00::/7)
  /^fd[0-9a-f]{2}:/i,                         // IPv6 unique-local (fd00::/8)
  /^::ffff:\d+\.\d+\.\d+\.\d+$/i,             // IPv4-mapped IPv6 — also test the inner v4
];

/** Cloud metadata service hostnames (in addition to the 169.254.x IPs). */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',        // GCP
  'metadata.google.internal.',       // GCP (trailing-dot FQDN)
  'metadata.azure.com',              // Azure
  'metadata.azure.com.',             // Azure (trailing-dot FQDN)
]);

/**
 * In-cluster / internal DNS suffixes that should be blocked when web access
 * is enabled — these could reach k8s services or internal infrastructure.
 */
const INTERNAL_DNS_SUFFIXES = [
  '.local',
  '.local.',
  '.internal',
  '.internal.',
  '.svc',
  '.svc.',
  '.svc.cluster.local',
  '.svc.cluster.local.',
  '.kubernetes.local',
];

function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6: extract the inner v4 and test ranges too.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) {
    const v4 = mapped[1]!;
    if (isPrivateIp(v4)) return true;
  }
  for (const re of PRIVATE_IP_RANGES) {
    if (re.test(ip)) return true;
  }
  return false;
}

function isMetadataHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (METADATA_HOSTNAMES.has(lower)) return true;
  return false;
}

function isInternalDnsSuffix(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  for (const suffix of INTERNAL_DNS_SUFFIXES) {
    if (lower === suffix.slice(0, -1) || lower.endsWith(suffix)) return true;
  }
  return false;
}

function isPrivateHost(hostname: string): boolean {
  if (isMetadataHostname(hostname)) return true;
  if (isInternalDnsSuffix(hostname)) return true;
  // Strip IPv6 brackets ([::1] → ::1) for IP-range matching.
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (isPrivateIp(stripped)) return true;
  return false;
}

/**
 * Resolve a hostname via DNS and verify NONE of the resolved IPs are private
 * or internal. This defeats DNS-rebinding SSRF: an attacker-controlled DNS
 * server could return a public IP for the pre-flight check and a private IP
 * for the actual fetch. We resolve ONCE and pin the fetch to that IP.
 *
 * @returns the first resolved public IP (used to pin the fetch), or throws
 *          if all resolved IPs are private.
 */
async function resolveAndValidateHost(hostname: string): Promise<string> {
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error(`DNS resolution failed for ${hostname}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (addrs.length === 0) {
    throw new Error(`No DNS records for ${hostname}`);
  }
  const publicIps = addrs.filter((a) => !isPrivateIp(a.address));
  if (publicIps.length === 0) {
    throw new Error(
      `Host ${hostname} resolves only to private/internal addresses ` +
      `(${addrs.map((a) => a.address).join(', ')}). Blocked for SSRF protection.`,
    );
  }
  return publicIps[0]!.address;
}

function validateUrl(urlString: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, error: `Invalid URL: ${urlString}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Unsupported protocol "${url.protocol}". Only http and https are allowed.` };
  }
  if (url.username || url.password) {
    // Reject userinfo (credentials in URL) — often used for SSRF bypasses.
    return { ok: false, error: 'URLs with credentials (userinfo) are not allowed.' };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, error: `Access to private/internal host "${url.hostname}" is blocked.` };
  }
  return { ok: true, url };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '');
}

/**
 * SSRF-safe fetch: resolve the hostname, validate that it does not resolve
 * to a private IP, then fetch pinning to that validated IP (preserving the
 * original Host header) to defeat DNS rebinding. Follows redirects manually,
 * re-validating each Location target with the same checks.
 *
 * The manual redirect-follow is necessary because Node's `fetch(url,
 * {redirect:'follow'})` does NOT re-run the URL validation on redirect
 * targets — a server could 30x to http://169.254.169.254/...
 */
async function ssrfSafeFetch(
  url: URL,
  timeoutMs: number,
  maxRedirects = 5,
): Promise<Response> {
  let currentUrl = url;
  const visited: string[] = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (visited.includes(currentUrl.toString())) {
      throw new Error(`Redirect loop detected at ${currentUrl}`);
    }
    visited.push(currentUrl.toString());

    // Re-validate the URL (catches redirect to private IP / bad scheme).
    const check = validateUrl(currentUrl.toString());
    if (!check.ok) throw new Error(check.error);

    // Resolve + validate the host's DNS, pin to the validated IP.
    const pinnedIp = await resolveAndValidateHost(currentUrl.hostname);
    // Construct a URL with the IP literal so fetch connects to the validated
    // IP (defeating DNS rebinding between resolution and connection). Preserve
    // the original port and path. Set the Host header to the original hostname.
    const pinnedUrl = new URL(currentUrl.toString());
    pinnedUrl.hostname = currentUrl.port ? `[${pinnedIp}]:${currentUrl.port}` : `[${pinnedIp}]`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(pinnedUrl, {
        signal: controller.signal,
        redirect: 'manual', // we follow manually to re-validate each hop
        headers: {
          'Accept': 'text/html,application/json,text/plain,*/*',
          'User-Agent': 'AI-Model-Arena/1.0',
          'Host': currentUrl.host, // preserve original host
        },
      });
    } finally {
      clearTimeout(timer);
    }

    // 3xx → follow Location manually with re-validation.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res; // malformed redirect — return as-is
      const nextUrl = new URL(location, currentUrl);
      currentUrl = nextUrl;
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects (>${maxRedirects})`);
}

// ── web_fetch ────────────────────────────────────────────────────────────────

export const webFetch: ToolExecutor = async (args, ctx) => {
  if (!ctx.webAccess) {
    return { content: 'Error: web access is disabled. Enable webAccess in the tool context to use web_fetch.', isError: true };
  }
  const v = validateArgs(WebFetchArgs, args);
  if (!v.ok) return { content: v.error, isError: true };

  const { url: urlString, maxBytes } = v.data;
  const urlCheck = validateUrl(urlString);
  if (!urlCheck.ok) return { content: urlCheck.error, isError: true };

  const maxToRead = Math.min(maxBytes, MAX_FETCH_BYTES);

  let response: Response;
  try {
    response = await ssrfSafeFetch(urlCheck.url, DEFAULT_FETCH_TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError'
      ? `Request to ${urlString} timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms.`
      : `Network error fetching ${urlString}: ${err instanceof Error ? err.message : String(err)}`;
    return { content: msg, isError: true };
  }

  const contentType = response.headers.get('content-type') ?? '';
  let body: string;

  if (contentType.includes('application/json')) {
    body = await response.text();
    if (body.length > maxToRead) body = body.slice(0, maxToRead) + '\n…[truncated]';
  } else {
    const raw = await response.text();
    body = stripHtml(raw);
    if (body.length > maxToRead) body = body.slice(0, maxToRead) + '\n…[truncated]';
  }

  const header = `[HTTP ${response.status} ${response.statusText}] ${urlCheck.url.toString()}`;
  const result = `${header}\n${body}`;
  return { content: result, isError: !response.ok && response.status >= 400 };
};

// ── web_search ───────────────────────────────────────────────────────────────

export const webSearch: ToolExecutor = async (args, ctx) => {
  if (!ctx.webAccess) {
    return { content: 'Error: web access is disabled. Enable webAccess in the tool context to use web_search.', isError: true };
  }
  const v = validateArgs(WebSearchArgs, args);
  if (!v.ok) return { content: v.error, isError: true };

  const { query } = v.data;

  // Prefer a configured search API endpoint if available.
  const apiUrl = process.env.SEARCH_API_URL;
  const apiKey = process.env.SEARCH_API_KEY;

  if (apiUrl) {
    let url: string;
    try {
      url = apiUrl.replace('{query}', encodeURIComponent(query));
    } catch {
      return { content: 'Error: invalid SEARCH_API_URL template.', isError: true };
    }
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'User-Agent': 'AI-Model-Arena/1.0',
      };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal, headers });
      } catch (err) {
        const msg = err instanceof Error && err.name === 'AbortError'
          ? `Search API timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms.`
          : `Search API error: ${err instanceof Error ? err.message : String(err)}`;
        return { content: msg, isError: true };
      } finally {
        clearTimeout(timer);
      }
      const body = await response.text();
      return { content: `[HTTP ${response.status}] ${url}\n${body.length > 5000 ? body.slice(0, 5000) + '\n…[truncated]' : body}`, isError: !response.ok };
    } catch (err) {
      return { content: `Search API error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  // Fallback: DuckDuckGo Instant Answer API (free, no key required)
  const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  try {
    const response = await ssrfSafeFetch(new URL(ddgUrl), DEFAULT_FETCH_TIMEOUT_MS);
    const json: Record<string, unknown> = await response.json() as Record<string, unknown>;

    const lines: string[] = [];

    const heading = json.Heading as string | undefined;
    if (heading) lines.push(heading);

    const abstract = json.Abstract as string | undefined;
    const abstractUrl = json.AbstractURL as string | undefined;
    if (abstract) {
      lines.push(`${abstract}${abstractUrl ? `\n  → ${abstractUrl}` : ''}`);
    }

    const answer = json.Answer as string | undefined;
    const answerType = json.AnswerType as string | undefined;
    if (answer) {
      lines.push(`${answerType ? `[${answerType}] ` : ''}${answer}`);
    }

    const related = json.RelatedTopics as Array<{ Text?: string; FirstURL?: string }> | undefined;
    if (related && related.length > 0) {
      lines.push('');
      lines.push('Related topics:');
      for (let i = 0; i < Math.min(related.length, 5); i++) {
        const t = related[i]!;
        if (t.Text) {
          lines.push(`- ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ''}`);
        }
      }
    }

    if (!heading && !abstract && !answer && (!related || related.length === 0)) {
      return { content: 'No results found.', isError: false };
    }

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    return { content: `Search error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
};
