import { z } from 'zod/v4';
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

const PRIVATE_IP_RANGES = [
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
];

function isPrivateHost(hostname: string): boolean {
  // Block metadata service endpoints
  if (hostname === 'metadata.google.internal') return true;
  if (hostname === '169.254.169.254') return true;
  for (const re of PRIVATE_IP_RANGES) {
    if (re.test(hostname)) return true;
  }
  return false;
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

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/html,application/json,text/plain,*/*',
        'User-Agent': 'AI-Model-Arena/1.0',
      },
      redirect: 'follow',
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
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
    response = await fetchWithTimeout(urlCheck.url.toString(), DEFAULT_FETCH_TIMEOUT_MS);
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
    const response = await fetchWithTimeout(ddgUrl, DEFAULT_FETCH_TIMEOUT_MS);
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
