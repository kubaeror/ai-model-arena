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
