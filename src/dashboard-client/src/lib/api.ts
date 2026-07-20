import type {
  ModelConfig,
  ScenarioConfig,
  StarterFile,
  RunIndexRecord,
  ConversationFile,
  AnomalyRecord,
  TraceResponse,
  ObservabilityStats,
  RecentTraceEntry,
  WebhookRecord,
} from './types.js';

// In production the API is same-origin. In dev, Vite proxies /api → :4000.
const API_BASE = import.meta.env.VITE_API_URL ?? '';

const TOKEN_KEY = 'ai-arena-token';
const USER_KEY = 'ai-arena-user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string, username: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, username);
}
export function getUser(): string | null {
  return localStorage.getItem(USER_KEY);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/**
 * Raw fetch wrapper (returns a `Response`) for callers that need the full
 * response (e.g. `.json()` / status inspection) rather than the typed
 * `apiFetch<T>` helper. Adds the JWT bearer header + same-origin API base.
 */
async function request(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(API_BASE + path, { ...init, headers });
}

/** Low-level HTTP namespace (get/post/patch/del) returning a `Response`. */
export const api = {
  get: (path: string, init?: RequestInit) => request(path, { ...init, method: 'GET' }),
  post: (path: string, init?: RequestInit) => request(path, { ...init, method: 'POST' }),
  patch: (path: string, init?: RequestInit) => request(path, { ...init, method: 'PATCH' }),
  del: (path: string, init?: RequestInit) => request(path, { ...init, method: 'DELETE' }),
};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.headers.get('content-type')?.includes('application/json')) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

// ── Auth ────────────────────────────────────────────────────────────────────
export async function login(username: string, password: string): Promise<{ token: string; username: string }> {
  const r = await apiFetch<{ token: string; username: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setToken(r.token, r.username);
  return r;
}

// ── Models ───────────────────────────────────────────────────────────────────
export async function listModels(): Promise<ModelConfig[]> {
  const r = await apiFetch<{ models: ModelConfig[] }>('/api/models');
  return r.models;
}
export async function upsertModel(model: Partial<ModelConfig> & { name: string }): Promise<ModelConfig[]> {
  const r = await apiFetch<{ models: ModelConfig[] }>('/api/models', {
    method: 'POST',
    body: JSON.stringify(model),
  });
  return r.models;
}
export async function deleteModel(name: string): Promise<ModelConfig[]> {
  const r = await apiFetch<{ models: ModelConfig[] }>(`/api/models/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  return r.models;
}

// ── Scenarios ───────────────────────────────────────────────────────────────
export async function listScenarios(): Promise<ScenarioConfig[]> {
  const r = await apiFetch<{ scenarios: ScenarioConfig[] }>('/api/scenarios');
  return r.scenarios;
}
export async function getScenario(
  name: string,
): Promise<{ scenario: ScenarioConfig; starterFiles: StarterFile[] }> {
  return apiFetch(`/api/scenarios/${encodeURIComponent(name)}`);
}
export async function createScenario(
  scenario: Partial<ScenarioConfig> & { name: string },
  starterFilesContent?: StarterFile[],
): Promise<ScenarioConfig> {
  const r = await apiFetch<{ scenario: ScenarioConfig }>('/api/scenarios', {
    method: 'POST',
    body: JSON.stringify({ ...scenario, starterFilesContent }),
  });
  return r.scenario;
}
export async function updateScenario(
  name: string,
  scenario: Partial<ScenarioConfig> & { name: string },
  starterFilesContent?: StarterFile[],
): Promise<ScenarioConfig> {
  const r = await apiFetch<{ scenario: ScenarioConfig }>(`/api/scenarios/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ ...scenario, starterFilesContent }),
  });
  return r.scenario;
}
export async function deleteScenario(name: string): Promise<void> {
  await apiFetch(`/api/scenarios/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ── Runs ────────────────────────────────────────────────────────────────────
export async function listRuns(): Promise<RunIndexRecord[]> {
  const r = await apiFetch<{ runs: RunIndexRecord[] }>('/api/runs');
  return r.runs;
}
export async function getRun(
  runId: string,
): Promise<{
  run: RunIndexRecord;
  statuses: { model: string; status: string; online: boolean; exitCode: number | null }[];
}> {
  return apiFetch(`/api/runs/${encodeURIComponent(runId)}`);
}
export async function triggerRun(scenario: string, models: string[]): Promise<{ runId: string }> {
  return apiFetch('/api/runs', { method: 'POST', body: JSON.stringify({ scenario, models }) });
}
export async function stopRun(runId: string): Promise<void> {
  await apiFetch(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
}
export async function restartRun(runId: string): Promise<void> {
  await apiFetch(`/api/runs/${encodeURIComponent(runId)}/restart`, { method: 'POST' });
}
export async function getConversation(runId: string, model: string): Promise<ConversationFile> {
  const r = await apiFetch<{ conversation: ConversationFile }>(
    `/api/runs/${encodeURIComponent(runId)}/models/${encodeURIComponent(model)}/conversation`,
  );
  return r.conversation;
}
export async function getReport(runId: string, model: string): Promise<string> {
  return apiFetch<string>(
    `/api/runs/${encodeURIComponent(runId)}/models/${encodeURIComponent(model)}/report`,
  );
}
export async function getRunFiles(runId: string, model: string): Promise<string[]> {
  const r = await apiFetch<{ files: string[] }>(
    `/api/runs/${encodeURIComponent(runId)}/models/${encodeURIComponent(model)}/files`,
  );
  return r.files;
}
export async function getRunFile(runId: string, model: string, path: string): Promise<string> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return apiFetch<string>(
    `/api/runs/${encodeURIComponent(runId)}/models/${encodeURIComponent(model)}/files/${encoded}`,
  );
}
export async function getRunLogs(runId: string, model: string): Promise<string> {
  return apiFetch<string>(
    `/api/runs/${encodeURIComponent(runId)}/models/${encodeURIComponent(model)}/logs`,
  );
}

// ── Traces ───────────────────────────────────────────────────────────────────
export async function getTrace(runId: string, model?: string): Promise<TraceResponse> {
  const q = model ? `?model=${encodeURIComponent(model)}` : '';
  return apiFetch<TraceResponse>(`/api/traces/${encodeURIComponent(runId)}${q}`);
}

// ── Anomalies ────────────────────────────────────────────────────────────────
export async function listAnomalies(params?: {
  model?: string; type?: string; severity?: string; resolved?: boolean;
  from?: string; to?: string; limit?: number; offset?: number;
}): Promise<AnomalyRecord[]> {
  const sp = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) sp.set(k, String(v));
    }
  }
  const r = await apiFetch<{ anomalies: AnomalyRecord[] }>(`/api/anomalies?${sp.toString()}`);
  return r.anomalies;
}

export async function resolveAnomaly(id: number, resolvedAs: 'resolved' | 'false_positive'): Promise<AnomalyRecord> {
  const r = await apiFetch<{ anomaly: AnomalyRecord }>(`/api/anomalies/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ resolved_as: resolvedAs }),
  });
  return r.anomaly;
}

// ── Observability ────────────────────────────────────────────────────────────
export async function getObservabilityStats(model?: string): Promise<ObservabilityStats> {
  const q = model ? `?model=${encodeURIComponent(model)}` : '';
  return apiFetch<ObservabilityStats>(`/api/observability/stats${q}`);
}

export async function getRecentTraces(limit?: number): Promise<RecentTraceEntry[]> {
  const q = limit ? `?limit=${limit}` : '';
  const r = await apiFetch<{ traces: RecentTraceEntry[] }>(`/api/observability/recent-traces${q}`);
  return r.traces;
}

// ── Webhooks ─────────────────────────────────────────────────────────────────
export async function listWebhooks(): Promise<WebhookRecord[]> {
  const r = await apiFetch<{ webhooks: WebhookRecord[] }>(`/api/webhooks`);
  return r.webhooks;
}
export async function registerWebhook(url: string, events: string[], secret?: string): Promise<WebhookRecord> {
  const r = await apiFetch<{ webhook: WebhookRecord }>(`/api/webhooks`, {
    method: 'POST',
    body: JSON.stringify({ url, events, secret }),
  });
  return r.webhook;
}
export async function deleteWebhook(id: number): Promise<void> {
  await apiFetch(`/api/webhooks/${id}`, { method: 'DELETE' });
}

