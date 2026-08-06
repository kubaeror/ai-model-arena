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

/** Low-level HTTP namespace (get/post/put/patch/del) returning a `Response`. */
export const api = {
  get: (path: string, init?: RequestInit) => request(path, { ...init, method: 'GET' }),
  post: (path: string, init?: RequestInit) => request(path, { ...init, method: 'POST' }),
  put: (path: string, init?: RequestInit) => request(path, { ...init, method: 'PUT' }),
  patch: (path: string, init?: RequestInit) => request(path, { ...init, method: 'PATCH' }),
  del: (path: string, init?: RequestInit) => request(path, { ...init, method: 'DELETE' }),
};

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
export interface JudgeScoreRow {
  id: number;
  run_id: string;
  model: string;
  judge_model: string;
  average_score: number;
  summary: string;
  scores_json: string;
  judged_at: string;
}

export async function listRuns(): Promise<RunIndexRecord[]> {
  const r = await apiFetch<{ runs: RunIndexRecord[] }>('/api/runs');
  return r.runs;
}
export async function getRun(
  runId: string,
): Promise<{
  run: RunIndexRecord;
  statuses: { model: string; status: string; online: boolean; exitCode: number | null }[];
  judge: JudgeScoreRow[];
}> {
  return apiFetch(`/api/runs/${encodeURIComponent(runId)}`);
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

// ── Budget ───────────────────────────────────────────────────────────────────
export interface BudgetModelStatus {
  daily: { spent: number; limit: number | null };
  monthly: { spent: number; limit: number | null };
}
export interface BudgetStatus {
  global: BudgetModelStatus;
  models: Record<string, BudgetModelStatus>;
}
export async function getBudget(): Promise<BudgetStatus> {
  return apiFetch<BudgetStatus>('/api/budget');
}

// ── Schedules ────────────────────────────────────────────────────────────────
export interface ScheduleState {
  id: string;
  lastRun?: string;
  nextRun?: string;
  status: 'idle' | 'running' | 'error';
  lastError?: string;
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
}
export interface Schedule {
  id: string;
  scenario: string;
  models: string[];
  cron: string;
  enabled: boolean;
  state: ScheduleState | null;
}
export async function listSchedules(): Promise<Schedule[]> {
  const r = await apiFetch<{ schedules: Schedule[] }>('/api/schedules');
  return r.schedules;
}
export async function createSchedule(opts: {
  id?: string; scenario: string; models: string[]; cron: string; enabled?: boolean;
}): Promise<{ id: string }> {
  return apiFetch('/api/schedules', { method: 'POST', body: JSON.stringify(opts) });
}
export async function deleteSchedule(id: string): Promise<void> {
  await apiFetch(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
export async function updateSchedule(id: string, opts: { enabled: boolean }): Promise<Schedule> {
  return apiFetch<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(opts),
  });
}

// ── Regression ───────────────────────────────────────────────────────────────
export interface RegressionResult {
  suite: string; runId: string; model: string; passed: boolean; timestamp: string;
  scenarioResults: Array<{
    scenario: string; success: boolean;
    regression?: { passed: boolean; regressions: Array<{ metric: string; baseline: number; current: number; change: number; threshold: number }> };
    current: { model: string; scenario: string; success: boolean; durationMs: number; turnsUsed: number };
  }>;
}
export async function listRegressionSuites(): Promise<string[]> {
  const r = await apiFetch<{ suites: string[] }>('/api/regression/suites');
  return r.suites;
}
export async function runRegression(opts: { suite: string; model?: string; updateBaseline?: boolean }): Promise<RegressionResult> {
  return apiFetch('/api/regression', { method: 'POST', body: JSON.stringify(opts) });
}
export async function listRegressionResults(limit?: number): Promise<RegressionResult[]> {
  const q = limit ? `?limit=${limit}` : '';
  const r = await apiFetch<{ results: RegressionResult[] }>(`/api/regression/results${q}`);
  return r.results;
}

// ── Diff ─────────────────────────────────────────────────────────────────────
export async function getRunDiff(runId: string, model: string): Promise<{ model: string; diff: string | null }> {
  return apiFetch(`/api/runs/${encodeURIComponent(runId)}/models/${encodeURIComponent(model)}/diff`);
}

// ── Killswitch ───────────────────────────────────────────────────────────────
export async function getKillswitch(): Promise<{ active: boolean }> {
  return apiFetch('/api/ops/killswitch');
}
export async function activateKillswitch(): Promise<{ active: boolean }> {
  return apiFetch('/api/ops/killswitch', { method: 'POST' });
}
export async function deactivateKillswitch(): Promise<{ active: boolean }> {
  return apiFetch('/api/ops/killswitch', { method: 'DELETE' });
}

// ── Export ───────────────────────────────────────────────────────────────────
export function getExportCsvUrl(params?: { model?: string; scenario?: string; from?: string; to?: string }): string {
  const sp = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) sp.set(k, v);
    }
  }
  return `${API_BASE}/api/export/csv?${sp.toString()}`;
}

// ── Analytics (cost leaderboard) ─────────────────────────────────────────────
export interface CostLeaderboardEntry {
  model: string; runs: number; successes: number; successRate: number;
  totalCost: number; costPerSuccess: number; avgCostPerRun: number; totalTokens: number;
}
export async function getCostLeaderboard(): Promise<CostLeaderboardEntry[]> {
  const r = await apiFetch<{ leaderboard: CostLeaderboardEntry[] }>('/api/analytics/cost');
  return r.leaderboard;
}


// ── Sessions ─────────────────────────────────────────────────────────────────
export interface SessionRow {
  id: string;
  prompt_id: string | null;
  prompt_version: number | null;
  model: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  call_count: number;
}

export async function listSessions(params?: {
  status?: string; model?: string; limit?: number; offset?: number;
}): Promise<{ sessions: SessionRow[]; total: number }> {
  const sp = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) sp.set(k, String(v));
    }
  }
  return apiFetch<{ sessions: SessionRow[]; total: number }>(`/api/sessions?${sp.toString()}`);
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  return apiFetch<SessionRow | null>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export async function getSessionMessages(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const r = await apiFetch<{ messages: Array<Record<string, unknown>> }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  return r.messages;
}

export async function getSessionCalls(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const r = await apiFetch<{ calls: Array<Record<string, unknown>> }>(`/api/sessions/${encodeURIComponent(sessionId)}/calls`);
  return r.calls;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

// ── Files ────────────────────────────────────────────────────────────────────
export interface FileRow {
  id: number;
  run_id: string;
  prompt_id: string | null;
  model: string | null;
  produced_at: string;
  produced_by_tool: string | null;
  path: string;
}

export async function listFiles(params?: {
  model?: string; runId?: string; tool?: string; limit?: number; offset?: number;
}): Promise<{ files: FileRow[]; total: number }> {
  const sp = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) sp.set(k, String(v));
    }
  }
  return apiFetch<{ files: FileRow[]; total: number }>(`/api/files?${sp.toString()}`);
}

// ── Prompts ─────────────────────────────────────────────────────────────────
export interface PromptRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  latest_version: number | null;
  latest_tag: string | null;
}
export interface PromptVersion {
  id: string;
  prompt_id: string;
  version: number;
  system_prompt: string;
  task: string;
  config: string | null;
  tag: string | null;
  created_at: string;
  created_by: string;
}
export async function listPrompts(): Promise<PromptRow[]> {
  const r = await apiFetch<{ prompts: PromptRow[] }>('/api/prompts');
  return r.prompts;
}
export async function createPrompt(input: {
  name: string; description?: string; systemPrompt: string; task: string; tag?: string;
}): Promise<{ id: string; version: number }> {
  return apiFetch('/api/prompts', { method: 'POST', body: JSON.stringify(input) });
}
export async function updatePrompt(
  id: string,
  input: { name?: string; description?: string },
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/prompts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}
export async function deletePrompt(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
export async function listPromptVersions(id: string): Promise<PromptVersion[]> {
  const r = await apiFetch<{ prompt: PromptRow; versions: PromptVersion[] }>(
    `/api/prompts/${encodeURIComponent(id)}`,
  );
  return r.versions;
}
export async function enqueuePrompt(input: {
  promptId: string; promptVersion?: number; models: string[]; scenario: string;
}): Promise<{ tasks: Array<{ taskId: string; model: string; provider: string }>; count: number }> {
  return apiFetch('/api/prompts/enqueue', { method: 'POST', body: JSON.stringify(input) });
}

// ── Output Mappings ─────────────────────────────────────────────────────────
export interface OutputMappingRow {
  id: string;
  scope: string;
  scope_id: string;
  parent_folder: string;
  per_model_pattern: string;
  created_at: string;
  updated_at: string;
}
export async function listOutputMappings(): Promise<OutputMappingRow[]> {
  const r = await apiFetch<{ mappings: OutputMappingRow[] }>('/api/output-mappings');
  return r.mappings;
}
export async function createOutputMapping(input: {
  scope: string; scopeId: string; parentFolder: string; perModelPattern: string;
}): Promise<OutputMappingRow> {
  return apiFetch('/api/output-mappings', { method: 'POST', body: JSON.stringify(input) });
}
export async function updateOutputMapping(
  id: string,
  input: { scope?: string; scopeId?: string; parentFolder?: string; perModelPattern?: string },
): Promise<OutputMappingRow> {
  return apiFetch(`/api/output-mappings/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}
export async function deleteOutputMapping(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/output-mappings/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Users / Roles (admin only) ───────────────────────────────────────────────
export interface ArenaUser {
  id: string;
  username: string;
  created_at: string;
  roles: string[];
}

export interface ArenaRole {
  id: string;
  description: string;
}

export async function listUsers(): Promise<ArenaUser[]> {
  const r = await apiFetch<{ users: ArenaUser[] }>('/api/users');
  return r.users;
}

export async function listUserRoles(): Promise<ArenaRole[]> {
  const r = await apiFetch<{ roles: ArenaRole[] }>('/api/users/roles');
  return r.roles;
}

export async function createUser(username: string, password: string): Promise<ArenaUser> {
  return apiFetch<ArenaUser>('/api/users', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function updateUser(id: string, opts: { username?: string; password?: string }): Promise<unknown> {
  return apiFetch(`/api/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(opts),
  });
}

export async function deleteUser(id: string): Promise<unknown> {
  return apiFetch(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function assignUserRole(id: string, roleId: string): Promise<unknown> {
  return apiFetch(`/api/users/${encodeURIComponent(id)}/roles`, {
    method: 'POST',
    body: JSON.stringify({ roleId }),
  });
}

export async function removeUserRole(id: string, roleId: string): Promise<unknown> {
  return apiFetch(`/api/users/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`, {
    method: 'DELETE',
  });
}

// ── Audit ────────────────────────────────────────────────────────────────────
export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  at: string;
  before: unknown;
  after: unknown;
}

export async function listAudit(params?: {
  actor?: string; action?: string; entity_type?: string; entity_id?: string;
  from?: string; to?: string; limit?: number; offset?: number;
}): Promise<{ entries: AuditEntry[]; total: number }> {
  const sp = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) sp.set(k, String(v));
    }
  }
  return apiFetch<{ entries: AuditEntry[]; total: number }>(`/api/audit?${sp.toString()}`);
}

// ── Notifications (admin only) ───────────────────────────────────────────────
export interface NotificationRow {
  id: string;
  eventType: string;
  channel: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
}

export async function listNotifications(): Promise<NotificationRow[]> {
  const r = await apiFetch<{ notifications: NotificationRow[] }>('/api/notifications');
  return r.notifications;
}

export async function retryNotification(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/notifications/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}
