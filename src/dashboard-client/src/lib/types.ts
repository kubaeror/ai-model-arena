// Shared types mirroring the dashboard server's response shapes.

export interface ModelConfig {
  name: string;
  provider: 'openai' | 'anthropic' | 'google' | 'ollama' | 'openai-compatible';
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxTurns: number;
  temperature: number;
  maxTokens: number;
  retry?: { maxRetries: number; initialDelayMs: number; maxDelayMs: number };
}

export interface SuccessCriteria {
  command?: string;
  expectedExitCode?: number;
  expectedOutputContains?: string;
}

export interface ScenarioConfig {
  name: string;
  description?: string;
  systemPrompt: string;
  task: string;
  starterFiles?: string;
  successCriteria?: SuccessCriteria;
  maxTurns?: number;
  shellTimeoutMs?: number;
  maxShellOutputBytes?: number;
}

export interface StarterFile {
  path: string;
  content: string;
}

export type RunStatus = 'running' | 'completed' | 'stopped' | 'errored' | 'unknown';

export interface RunIndexModelEntry {
  model: string;
  runId: string;
  procName: string;
  status: RunStatus;
  success?: boolean;
  turnsUsed?: number;
  totalToolCalls?: number;
  stopReason?: string;
  durationMs?: number;
  resultPath: string;
  conversationPath: string;
  reportPath: string;
  logFile: string;
  sandboxDir: string;
  outputDir: string;
}

export interface RunIndexRecord {
  runId: string;
  scenario: string;
  models: string[];
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  source: 'cli' | 'dashboard';
  perModel: RunIndexModelEntry[];
  comparisonMdPath: string | null;
  comparisonJsonPath: string | null;
}

export interface ConversationEntry {
  timestamp: string;
  type: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'info' | 'error';
  turn?: number;
  role?: string;
  content?: string | null;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
  toolResult?: string;
  isError?: boolean;
  usage?: { prompt?: number; completion?: number; total?: number };
  stopReason?: string;
  meta?: Record<string, unknown>;
}

export interface ConversationFile {
  model: string;
  scenario: string;
  runId: string;
  startedAt: string;
  endedAt?: string;
  entries: ConversationEntry[];
}

export interface ProcStatus {
  name: string;
  model?: string;
  scenario?: string;
  runId?: string;
  status: string;
  pid: number | null;
  cpu?: number;
  memory?: number;
  uptime?: number;
  restarts?: number;
  exitCode: number | null;
  online: boolean;
}

// ── Observability / anomaly types ───────────────────────────────────────────

export type AnomalyType = 'latency' | 'loop' | 'token_spike' | 'cost_spike' | 'error_rate' | 'silent_failure';
export type AnomalySeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AnomalyRecord {
  id: number;
  run_id: string;
  model: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  description: string;
  detected_at: string;
  resolved: boolean;
  resolved_at: string | null;
  resolved_as: string | null;
  metadata_json: string | null;
}

export interface SpanMeta {
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  name: string;
  type: 'root' | 'chat' | 'execute_tool' | 'other';
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'unset';
  attributes: Record<string, unknown>;
}

export interface TraceTree {
  model: string;
  traceId: string | null;
  spanCount: number;
  totalDurationMs: number;
  errorCount: number;
  externalUrl: string | null;
  spans: SpanMeta[];
}

export interface TraceResponse {
  runId: string;
  scenario: string;
  externalBackend: boolean;
  traces: TraceTree[];
}

export interface WebhookRecord {
  id: number;
  url: string;
  events: string;
  secret: string | null;
  created_at: string;
  active: boolean;
}

export interface ObservabilityStats {
  generatedAt: string;
  latency: Array<{ model: string; tool: string; count: number; avgMs: number; p95Ms: number; p99Ms: number }>;
  models: Array<{ model: string; runs: number; errorRate: number; anomalies: number; unresolvedAnomalies: number }>;
  baselines: Array<{ model: string; scenario: string; sampleCount: number; avgTokens: number; avgCostUsd: number }>;
}

