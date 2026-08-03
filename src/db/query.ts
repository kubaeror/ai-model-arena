/**
 * Typed Drizzle ORM query helpers.
 *
 * Every consumer that previously called `getDb()` for raw SQLite queries
 * should switch to these helpers. They work transparently with both drivers
 * (SQLite via better-sqlite3, Postgres via node-postgres).
 *
 * All functions are async so that callers don't need to know which driver
 * is active (Drizzle queries on Postgres are inherently async; on SQLite
 * they're sync but we `await` anyway — zero cost, same code path).
 *
 * NOTE: The db handle is `any` because SQLite and Postgres Drizzle clients
 * have incompatible TypeScript signatures (union of two disjoint types).
 * The runtime API is identical — Drizzle handles the dialect differences.
 */

import { eq, and, desc, sql, count, sum, max } from 'drizzle-orm';
import { getDrizzleDb } from './index.js';
import {
  sessions, messages, model_calls,
  run_models, cost_ledger,
  files, audit_log, output_mappings,
  anomalies, webhooks,
  prompts, prompt_versions,
  users, roles, user_roles,
  providers, models, model_providers, pricing, pricing_snapshots,
  schedules,
} from './schema.js';
import type {
  DbSession, DbMessage, DbModelCall,
  DbRunModel,
  DbAnomaly, DbWebhook,
  DbPrompt, DbPromptVersion,
  DbUser, DbRole,
  DbProvider,
  DbOutputMapping, DbSchedule, DbModel,
} from './schema.js';

// ── Sessions ──────────────────────────────────────────────────────────────

export async function createSession(data: {
  id: string; promptId?: string | null; promptVersion?: number | null;
  model: string; status?: string; createdAt: string; updatedAt: string;
}): Promise<DbSession> {
  const db = getDrizzleDb();
  await db.insert(sessions).values({
    id: data.id,
    prompt_id: data.promptId ?? null,
    prompt_version: data.promptVersion ?? null,
    model: data.model,
    status: data.status ?? 'active',
    created_at: data.createdAt,
    updated_at: data.updatedAt,
  });
  return { id: data.id, prompt_id: data.promptId ?? null, prompt_version: data.promptVersion ?? null, model: data.model, status: data.status ?? 'active', created_at: data.createdAt, updated_at: data.updatedAt };
}

export async function getSessionById(id: string): Promise<DbSession | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateSessionStatus(id: string, status: string): Promise<void> {
  const db = getDrizzleDb();
  await db.update(sessions).set({ status, updated_at: new Date().toISOString() }).where(eq(sessions.id, id));
}

export async function deleteSession(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(sessions).where(eq(sessions.id, id));
}

// ── Messages ──────────────────────────────────────────────────────────────

export async function createMessage(data: {
  id: string; sessionId: string; turn: number; role: string;
  content: string | null; toolCalls: string | null; toolCallId: string | null;
  tokenInput: number | null; tokenOutput: number | null; createdAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(messages).values({
    id: data.id, session_id: data.sessionId, turn: data.turn, role: data.role,
    content: data.content, tool_calls: data.toolCalls, tool_call_id: data.toolCallId,
    token_input: data.tokenInput, token_output: data.tokenOutput, created_at: data.createdAt,
  });
}

export async function listMessagesBySession(sessionId: string): Promise<DbMessage[]> {
  const db = getDrizzleDb();
  return db.select().from(messages)
    .where(eq(messages.session_id, sessionId))
    .orderBy(messages.turn, messages.created_at) as any;
}

export async function getMaxTurnForSession(sessionId: string): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.select({ maxTurn: max(messages.turn) })
    .from(messages)
    .where(eq(messages.session_id, sessionId));
  return rows[0]?.maxTurn ?? -1;
}

// ── Model Calls ───────────────────────────────────────────────────────────

export async function upsertModelCall(data: {
  id: string; sessionId: string; turn: number; provider: string; model: string;
  requestHash: string; responseText: string | null; usage: string | null;
  latencyMs: number | null; createdAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(model_calls).values({
    id: data.id, session_id: data.sessionId, turn: data.turn,
    provider: data.provider, model: data.model,
    request_hash: data.requestHash, response_text: data.responseText,
    usage: data.usage, latency_ms: data.latencyMs, created_at: data.createdAt,
  }).onConflictDoUpdate({
    target: [model_calls.session_id, model_calls.turn],
    set: { response_text: data.responseText, usage: data.usage, latency_ms: data.latencyMs, created_at: data.createdAt },
  });
}

export async function getModelCallBySessionAndTurn(sessionId: string, turn: number): Promise<DbModelCall | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(model_calls)
    .where(and(eq(model_calls.session_id, sessionId), eq(model_calls.turn, turn)))
    .limit(1);
  return rows[0] ?? null;
}

// ── Runs ──────────────────────────────────────────────────────────────────

export async function listRunModels(runId?: string): Promise<DbRunModel[]> {
  const db = getDrizzleDb();
  if (runId) return db.select().from(run_models).where(eq(run_models.run_id, runId)) as any;
  return db.select().from(run_models).orderBy(run_models.run_id) as any;
}

export async function upsertRunModel(data: {
  runId: string; model: string; procName?: string; outputDir?: string;
  sandboxDir?: string; resultPath?: string; conversationPath?: string;
  reportPath?: string; logFile?: string; status: string;
  success?: number | null; turnsUsed?: number | null; totalToolCalls?: number | null;
  stopReason?: string | null; durationMs?: number | null;
  claimedAt?: string | null; startedAt?: string | null; completedAt?: string | null;
  runnerId?: string | null;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(run_models).values({
    run_id: data.runId, model: data.model,
    proc_name: data.procName ?? null, output_dir: data.outputDir ?? null,
    sandbox_dir: data.sandboxDir ?? null, result_path: data.resultPath ?? null,
    conversation_path: data.conversationPath ?? null, report_path: data.reportPath ?? null,
    log_file: data.logFile ?? null, status: data.status,
    claimed_at: data.claimedAt ?? null, started_at: data.startedAt ?? null,
    completed_at: data.completedAt ?? null, runner_id: data.runnerId ?? null,
    success: data.success, turns_used: data.turnsUsed, total_tool_calls: data.totalToolCalls,
    stop_reason: data.stopReason ?? null, duration_ms: data.durationMs,
  }).onConflictDoUpdate({
    target: [run_models.run_id, run_models.model],
    set: {
      status: data.status,
      claimed_at: data.claimedAt ?? null,
      started_at: data.startedAt ?? null,
      completed_at: data.completedAt ?? null,
      runner_id: data.runnerId ?? null,
      success: data.success, turns_used: data.turnsUsed, total_tool_calls: data.totalToolCalls,
      stop_reason: data.stopReason ?? null, duration_ms: data.durationMs,
    },
  });
}

/**
 * Update the status + timestamp columns for a task in the run_models table.
 * Used for state machine transitions: pending → claimed → running → completed/failed/dead.
 */
export async function transitionTaskState(
  runId: string,
  model: string,
  newStatus: string,
  runnerId?: string,
): Promise<void> {
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  const updates: Record<string, any> = { status: newStatus };

  switch (newStatus) {
    case 'claimed':
      updates.claimed_at = now;
      if (runnerId) updates.runner_id = runnerId;
      break;
    case 'running':
      updates.started_at = now;
      break;
    case 'completed':
    case 'failed':
    case 'dead':
      updates.completed_at = now;
      break;
  }

  // Use raw SQL for cross-driver compatibility with update + where clause
  await db.run(
    `UPDATE run_models SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')} WHERE run_id = ? AND model = ?`,
    ...Object.values(updates), runId, model,
  );
}

// ── Cost Ledger ───────────────────────────────────────────────────────────

export async function insertCostLedgerEntry(data: {
  runId: string; model: string; costUsd: number; currency?: string;
  inputTokens?: number | null; outputTokens?: number | null;
  cacheReadTokens?: number | null; totalTokens?: number | null;
  pricingVersion?: string | null; recordedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(cost_ledger).values({
    run_id: data.runId, model: data.model, cost_usd: data.costUsd,
    currency: data.currency ?? 'USD', input_tokens: data.inputTokens ?? null,
    output_tokens: data.outputTokens ?? null, cache_read_tokens: data.cacheReadTokens ?? null,
    total_tokens: data.totalTokens ?? null, pricing_version: data.pricingVersion ?? null,
    recorded_at: data.recordedAt,
  });
}

// ── Files ─────────────────────────────────────────────────────────────────

export async function insertFile(data: {
  id: string; runId: string; path: string; promptId?: string | null;
  promptVersion?: number | null; model: string; configHash?: string | null;
  taskId?: string | null; traceId?: string | null; producedAt: string;
  producedByTool?: string | null;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(files).values({
    id: data.id, run_id: data.runId, path: data.path,
    prompt_id: data.promptId ?? null, prompt_version: data.promptVersion ?? null,
    model: data.model, config_hash: data.configHash ?? null,
    task_id: data.taskId ?? null, trace_id: data.traceId ?? null,
    produced_at: data.producedAt, produced_by_tool: data.producedByTool ?? null,
  });
}

// ── Audit Log ─────────────────────────────────────────────────────────────

export async function insertAuditEntry(data: {
  actor: string; action: string; entityType: string; entityId?: string | null;
  before?: string | null; after?: string | null; at: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(audit_log).values({
    actor: data.actor, action: data.action,
    entity_type: data.entityType, entity_id: data.entityId ?? null,
    before: data.before ?? null, after: data.after ?? null, at: data.at,
  });
}

// ── Output Mappings ───────────────────────────────────────────────────────

export async function listOutputMappings(): Promise<DbOutputMapping[]> {
  const db = getDrizzleDb();
  return db.select().from(output_mappings).orderBy(output_mappings.scope, output_mappings.scope_id) as any;
}

export async function getOutputMappingById(id: string): Promise<DbOutputMapping | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(output_mappings).where(eq(output_mappings.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertOutputMapping(data: {
  id: string; scope: string; scopeId: string; parentFolder: string;
  perModelPattern: string; createdAt: string; updatedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(output_mappings).values({
    id: data.id, scope: data.scope, scope_id: data.scopeId,
    parent_folder: data.parentFolder, per_model_pattern: data.perModelPattern,
    created_at: data.createdAt, updated_at: data.updatedAt,
  });
}

export async function updateOutputMapping(id: string, data: {
  scope?: string; scopeId?: string; parentFolder?: string;
  perModelPattern?: string; updatedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  const set: Record<string, any> = { updated_at: data.updatedAt };
  if (data.scope !== undefined) set.scope = data.scope;
  if (data.scopeId !== undefined) set.scope_id = data.scopeId;
  if (data.parentFolder !== undefined) set.parent_folder = data.parentFolder;
  if (data.perModelPattern !== undefined) set.per_model_pattern = data.perModelPattern;
  await db.update(output_mappings).set(set).where(eq(output_mappings.id, id));
}

export async function deleteOutputMapping(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(output_mappings).where(eq(output_mappings.id, id));
}

// ── Anomalies ─────────────────────────────────────────────────────────────

export async function insertAnomaly(data: {
  runId: string; model: string; type: string; severity: string;
  description: string; detectedAt: string; metadataJson?: string | null;
}): Promise<DbAnomaly> {
  const db = getDrizzleDb() as any;
  const result = await db.insert(anomalies).values({
    run_id: data.runId, model: data.model, type: data.type,
    severity: data.severity, description: data.description,
    detected_at: data.detectedAt, resolved: 0, metadata_json: data.metadataJson ?? null,
  }).returning();
  return result[0] as DbAnomaly;
}

// ── Webhooks ──────────────────────────────────────────────────────────────

export async function insertWebhook(data: {
  url: string; events: string; secret?: string | null; createdAt: string;
}): Promise<DbWebhook> {
  const db = getDrizzleDb() as any;
  // Encrypt the HMAC secret at rest (H5) — mirror anomaly-detection/db.ts.
  const { encryptWebhookSecret } = await import('../security/webhook-secret-crypto.js');
  const encryptedSecret = encryptWebhookSecret(data.secret ?? null);
  const result = await db.insert(webhooks).values({
    url: data.url, events: data.events, secret: encryptedSecret,
    created_at: data.createdAt, active: 1,
  }).returning();
  return result[0] as DbWebhook;
}

export async function listWebhooks(activeOnly = false): Promise<DbWebhook[]> {
  const db = getDrizzleDb();
  if (activeOnly) return db.select().from(webhooks).where(eq(webhooks.active, 1)) as any;
  return db.select().from(webhooks).orderBy(desc(webhooks.created_at)) as any;
}

// ── Pricing ───────────────────────────────────────────────────────────────

export async function getLatestPricingVersion(): Promise<string | null> {
  const db = getDrizzleDb();
  const rows = await db.select({ version: pricing_snapshots.version })
    .from(pricing_snapshots)
    .orderBy(desc(pricing_snapshots.id))
    .limit(1);
  return rows[0]?.version ?? null;
}

// ── Schedules ─────────────────────────────────────────────────────────────

export async function listDueSchedules(now: string): Promise<DbSchedule[]> {
  const db = getDrizzleDb();
  return db.select().from(schedules)
    .where(and(eq(schedules.enabled, 1), sql`(${schedules.next_run} IS NULL OR ${schedules.next_run} <= ${now})`))
    .orderBy(schedules.next_run) as any;
}

export async function updateScheduleRun(id: string, lastRun: string, nextRun: string): Promise<void> {
  const db = getDrizzleDb();
  await db.update(schedules).set({ last_run: lastRun, next_run: nextRun }).where(eq(schedules.id, id));
}

// ── Providers (custom) ────────────────────────────────────────────────────

export async function listCustomProviders(): Promise<DbProvider[]> {
  const db = getDrizzleDb();
  return db.select().from(providers).where(eq(providers.is_builtin, 0)).orderBy(providers.id) as any;
}

export async function deleteCustomProvider(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(providers).where(and(eq(providers.id, id), eq(providers.is_builtin, 0)));
}

// ── Models (for model-resolver) ───────────────────────────────────────────

export async function getModelByNameOrId(nameOrId: string): Promise<(DbModel & { api_model_id: string; env_var: string | null; provider_adapter: string }) | null> {
  const db = getDrizzleDb();
  const rows = await db.select({
    id: models.id, name: models.name, family: models.family,
    provider_id: models.provider_id, release_date: models.release_date,
    attachment: models.attachment, reasoning: models.reasoning,
    temperature: models.temperature, tool_call: models.tool_call,
    interleaved: models.interleaved, status: models.status,
    context_limit: models.context_limit, output_limit: models.output_limit,
    api_model_id: model_providers.api_model_id,
    env_var: providersTable().env_var,
    provider_adapter: providersTable().adapter,
  })
    .from(models)
    .innerJoin(model_providers, eq(model_providers.model_id, models.id))
    .innerJoin(providers, eq(providers.id, model_providers.provider_id))
    .where(sql`${models.name} = ${nameOrId} OR ${models.id} = ${nameOrId}`)
    .limit(1);
  return rows[0] as any;
}

// ── Models (catalog listing) ──────────────────────────────────────────────

export async function listModelsWithPricing(): Promise<any[]> {
  const db = getDrizzleDb();
  return db.select({
    id: models.id, name: models.name, family: models.family,
    provider_id: models.provider_id, reasoning: models.reasoning,
    tool_call: models.tool_call, context_limit: models.context_limit,
    output_limit: models.output_limit, status: models.status,
    input: pricing.input, output: pricing.output,
    cache_read: pricing.cache_read, cache_write: pricing.cache_write,
  })
    .from(models)
    .leftJoin(pricing, and(eq(pricing.model_id, models.id), sql`${pricing.tier_size} IS NULL`))
    .orderBy(models.name) as any;
}

// ── Prompts ───────────────────────────────────────────────────────────────

export async function getPromptById(id: string): Promise<DbPrompt | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(prompts).where(eq(prompts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listPromptVersions(promptId: string): Promise<DbPromptVersion[]> {
  const db = getDrizzleDb();
  return db.select().from(prompt_versions)
    .where(eq(prompt_versions.prompt_id, promptId))
    .orderBy(desc(prompt_versions.version)) as any;
}

export async function getLatestPromptVersion(promptId: string): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.select({ maxVer: max(prompt_versions.version) })
    .from(prompt_versions)
    .where(eq(prompt_versions.prompt_id, promptId));
  return rows[0]?.maxVer ?? 1;
}

// ── Users / Roles ─────────────────────────────────────────────────────────

export async function getUserByUsername(username: string): Promise<DbUser | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return rows[0] ?? null;
}

export async function getUserById(id: string): Promise<DbUser | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listRoles(): Promise<DbRole[]> {
  const db = getDrizzleDb();
  return db.select().from(roles).orderBy(roles.id) as any;
}

export async function countRoles(): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.select({ cnt: count() }).from(roles);
  return rows[0]?.cnt ?? 0;
}

// ── Config table queries (raw-style for dynamic WHERE) ────────────────────

/**
 * Validate a SQL identifier (table or column name) against a strict allowlist
 * regex. Prevents SQL injection via the table/select/orderBy fields of
 * {@link paginatedQuery}, which string-interpolates these values into raw SQL.
 *
 * Allowed forms:
 *   - bare identifier: `users`, `model_runtime_stats`, `at`
 *   - double-quoted identifier: `"at"`, `"order"`
 *   - comma-separated list of the above (for SELECT projections): `id, name, created_at`
 *   - the literal `*` (for SELECT *)
 *
 * @returns the validated identifier (unchanged).
 * @throws Error if the identifier contains anything outside the allowlist.
 */
export function validateSqlIdentifier(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('SQL identifier cannot be empty');
  }
  if (trimmed === '*') return trimmed;
  // Split on commas, validate each segment independently.
  for (const rawSegment of trimmed.split(',')) {
    const segment = rawSegment.trim();
    if (!segment) {
      throw new Error(`SQL identifier list has an empty segment: ${JSON.stringify(input)}`);
    }
    // A segment may be a bare identifier or a double-quoted identifier.
    const bare = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    const quoted = /^"[a-zA-Z_][a-zA-Z0-9_]*"$/;
    if (!bare.test(segment) && !quoted.test(segment)) {
      throw new Error(
        `Refusing to interpolate unsafe SQL identifier: ${JSON.stringify(segment)} ` +
        `(from ${JSON.stringify(input)}). Only bare identifiers (a-z0-9_) or ` +
        `"double-quoted" identifiers are allowed in table/select fields.`,
      );
    }
  }
  return trimmed;
}

/**
 * Validate an ORDER BY clause. Same identifier rules as
 * {@link validateSqlIdentifier}, plus an optional ` ASC` or ` DESC` suffix
 * per column, and comma-separated multi-column lists (e.g. `benchmark, score DESC`).
 * @returns the validated orderBy clause (unchanged).
 * @throws Error on any disallowed character.
 */
export function validateOrderByClause(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('ORDER BY clause cannot be empty');
  }
  for (const rawSegment of trimmed.split(',')) {
    const segment = rawSegment.trim();
    if (!segment) {
      throw new Error(`ORDER BY clause has an empty segment: ${JSON.stringify(input)}`);
    }
    // Strip an optional trailing ASC|DESC (case-insensitive).
    const m = /^(.+?)\s+(ASC|DESC)$/i.exec(segment);
    const ident = m ? m[1]! : segment;
    const bare = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    const quoted = /^"[a-zA-Z_][a-zA-Z0-9_]*"$/;
    if (!bare.test(ident) && !quoted.test(ident)) {
      throw new Error(
        `Refusing to interpolate unsafe ORDER BY segment: ${JSON.stringify(segment)} ` +
        `(from ${JSON.stringify(input)}).`,
      );
    }
  }
  return trimmed;
}

/**
 * Validate a WHERE clause fragment for {@link paginatedQuery}.
 *
 * Callers build WHERE clauses from static SQL fragments joined with AND/OR,
 * with values passed via `?` placeholders (parameterized). This validator is a
 * defense-in-depth guard against accidental future refactors that pass
 * user-controlled strings into the clause. It rejects:
 *   - statement terminators (`;`)
 *   - SQL line comments (`--`, `#` at start) and block comments (`/* *\/`)
 *   - stacked-statement keywords (`UNION`, `xp_`, `exec `, stacked `SELECT`)
 *   - shell metacharacters that have no place in a WHERE clause
 *
 * It does NOT attempt to fully parse SQL (that would require a real parser).
 * The contract is: callers must build whereClause from static fragments only;
 * values go in the params array.
 *
 * @returns the validated whereClause (unchanged).
 * @throws Error if the clause contains a disallowed pattern.
 */
export function validateWhereClause(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('WHERE clause cannot be empty');
  }
  // Reject obvious injection patterns. The empty-allowlist case ('1=1') is fine.
  const forbidden = [
    /;/i,                      // statement terminator
    /--/i,                     // line comment
    /\/\*/,                    // block comment open
    /\*\//,                    // block comment close
    /\bUNION\b/i,              // stacked SELECT
    /\bEXEC\b/i,               // MSSQL exec
    /\bxp_/i,                  // MSSQL extended procs
    /\bSLEEP\s*\(/i,           // time-based blind injection
    /\bBENCHMARK\s*\(/i,       // MySQL time-based
    /\bWAITFOR\s+DELAY\b/i,    // MSSQL time-based
    /\bLOAD_FILE\s*\(/i,       // MySQL file read
    /\bINTO\s+OUTFILE\b/i,     // MySQL file write
  ];
  for (const re of forbidden) {
    if (re.test(trimmed)) {
      throw new Error(
        `Refusing to execute WHERE clause with disallowed pattern ${re.source}: ` +
        `${JSON.stringify(input)}. Build clauses from static SQL fragments ` +
        `only; values must go in the params array as ? placeholders.`,
      );
    }
  }
  return trimmed;
}

// ── Anomaly counts ────────────────────────────────────────────────────────

export async function anomalyCountsByModel(): Promise<Array<{ model: string; total: number; unresolved: number }>> {
  const db = getDrizzleDb();
  const rows = await db.select({
    model: anomalies.model,
    total: count(),
    unresolved: sum(sql<number>`CASE WHEN ${anomalies.resolved} = 0 THEN 1 ELSE 0 END`),
  })
    .from(anomalies)
    .groupBy(anomalies.model)
    .orderBy(desc(count()));
  return (rows as Array<{ model: string; total: unknown; unresolved: unknown }>)
    .map(r => ({ model: r.model, total: Number(r.total), unresolved: Number(r.unresolved) }));
}

// ── Helper: re-exported providers table ref for JOINs ─────────────────────

function providersTable() {
  return providers;
}

// ── Dashboard: generic paginated query helpers ────────────────────────────

/**
 * Run a parametrized raw-SQL select with COUNT, then SELECT with LIMIT/OFFSET.
 * Safe for both SQLite and Postgres — uses Drizzle's sql template literal
 * so dialect differences are handled per-driver.
 */
export async function paginatedQuery(opts: {
  table: string;
  select?: string;
  whereClause: string;
  params: unknown[];
  orderBy: string;
  limit: number;
  offset: number;
}): Promise<{ rows: any[]; total: number }> {
  const db = getDrizzleDb();
  // Defense-in-depth: validate interpolated identifiers before building SQL.
  // Current callers pass static literals (catalog/cost/files/audit routes),
  // but this prevents a careless future refactor — e.g. passing
  // req.query.sort straight into orderBy — from opening a SQL-injection
  // vector. See validateSqlIdentifier / validateOrderByClause / validateWhereClause.
  const safeTable = validateSqlIdentifier(opts.table);
  const safeCols = opts.select ? validateSqlIdentifier(opts.select) : '*';
  const safeWhere = validateWhereClause(opts.whereClause);
  const safeOrderBy = validateOrderByClause(opts.orderBy);
  const countRows: any[] = await db.all(
    sql.raw(`SELECT COUNT(*) AS total FROM ${safeTable} WHERE ${safeWhere}`),
    ...opts.params,
  );
  const total = Number(countRows[0]?.total ?? 0);
  const rows = await db.all(
    sql.raw(`SELECT ${safeCols} FROM ${safeTable} WHERE ${safeWhere} ORDER BY ${safeOrderBy} LIMIT ? OFFSET ?`),
    ...opts.params, opts.limit, opts.offset,
  );
  return { rows, total };
}

// ── Dashboard: prompts helpers ────────────────────────────────────────────

export async function listPromptsWithLatestVersion(): Promise<any[]> {
  const db = getDrizzleDb();
  // Use subquery for latest version — Drizzle supports this but a raw SQL
  // sub-select is cleaner for cross-dialect compatibility.
  return db.all(sql.raw(`
    SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
      pv.version AS latest_version, pv.tag AS latest_tag
    FROM prompts p
    LEFT JOIN prompt_versions pv ON pv.id = (
      SELECT pv2.id FROM prompt_versions pv2
      WHERE pv2.prompt_id = p.id
      ORDER BY pv2.version DESC LIMIT 1
    )
    ORDER BY p.name ASC
  `));
}

export async function insertPrompt(data: {
  id: string; name: string; description: string | null; createdAt: string; updatedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(prompts).values({
    id: data.id, name: data.name, description: data.description,
    created_at: data.createdAt, updated_at: data.updatedAt,
  });
}

export async function updatePromptMetadata(id: string, data: {
  name?: string; description?: string | null; updatedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  const set: Record<string, any> = { updated_at: data.updatedAt };
  if (data.name !== undefined) set.name = data.name;
  if (data.description !== undefined) set.description = data.description;
  await db.update(prompts).set(set).where(eq(prompts.id, id));
}

export async function deletePromptById(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(prompt_versions).where(eq(prompt_versions.prompt_id, id));
  await db.delete(prompts).where(eq(prompts.id, id));
}

export async function insertPromptVersion(data: {
  id: string; promptId: string; version: number; systemPrompt: string; task: string;
  config: string | null; tag: string | null; createdAt: string; createdBy: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(prompt_versions).values({
    id: data.id, prompt_id: data.promptId, version: data.version,
    system_prompt: data.systemPrompt, task: data.task,
    config: data.config, tag: data.tag,
    created_at: data.createdAt, created_by: data.createdBy,
  });
}

// ── Dashboard: users helpers ──────────────────────────────────────────────

export async function listUsersWithRoles(): Promise<any[]> {
  const db = getDrizzleDb();
  return db.all(sql.raw(`
    SELECT u.id, u.username, u.created_at,
      COALESCE(
        (SELECT string_agg(ur.role_id, ',') FROM user_roles ur WHERE ur.user_id = u.id),
        ''
      ) AS roles
    FROM users u
    ORDER BY u.created_at ASC
  `));
}

export async function insertUser(data: {
  id: string; username: string; passwordHash: string; createdAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(users).values({
    id: data.id, username: data.username, password_hash: data.passwordHash,
    created_at: data.createdAt,
  });
}

export async function updateUser(id: string, data: {
  username?: string; passwordHash?: string;
}): Promise<void> {
  const db = getDrizzleDb();
  const set: Record<string, any> = {};
  if (data.username !== undefined) set.username = data.username;
  if (data.passwordHash !== undefined) set.password_hash = data.passwordHash;
  if (Object.keys(set).length === 0) return;
  await db.update(users).set(set).where(eq(users.id, id));
}

export async function deleteUserById(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(user_roles).where(eq(user_roles.user_id, id));
  await db.delete(users).where(eq(users.id, id));
}

export async function getUserRolesByUserId(userId: string): Promise<any[]> {
  const db = getDrizzleDb();
  return db.all(sql.raw(`
    SELECT r.* FROM roles r
    INNER JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?
  `), userId);
}

export async function assignUserRole(userId: string, roleId: string): Promise<void> {
  const db = getDrizzleDb();
  await db.run(sql.raw('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)'), userId, roleId);
}

export async function unassignUserRole(userId: string, roleId: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(user_roles).where(
    and(eq(user_roles.user_id, userId), eq(user_roles.role_id, roleId)),
  );
}

export async function countUserRoles(roleId?: string, userId?: string): Promise<number> {
  const db = getDrizzleDb();
  let q = `SELECT COUNT(*) AS cnt FROM user_roles`;
  const params: any[] = [];
  if (roleId && userId) { q += ' WHERE role_id = ? AND user_id = ?'; params.push(roleId, userId); }
  else if (roleId) { q += ' WHERE role_id = ?'; params.push(roleId); }
  const rows = await db.all(sql.raw(q), ...params);
  return Number(rows[0]?.cnt ?? 0);
}

export async function insertRole(data: { id: string; description: string }): Promise<void> {
  const db = getDrizzleDb();
  await db.run(sql.raw('INSERT OR IGNORE INTO roles (id, description) VALUES (?, ?)'), data.id, data.description);
}

// ── Dashboard: catalog + model helpers ────────────────────────────────────

export async function listCatalogModels(filters: {
  provider?: string; reasoning?: boolean; toolCall?: boolean;
  minContext?: number; sort?: string;
}): Promise<any[]> {
  const db = getDrizzleDb();
  const where: string[] = [];
  const params: any[] = [];
  if (filters.provider) { where.push('m.provider_id = ?'); params.push(filters.provider); }
  if (filters.reasoning) where.push('m.reasoning = 1');
  if (filters.toolCall) where.push('m.tool_call = 1');
  if (filters.minContext != null) { where.push('m.context_limit >= ?'); params.push(filters.minContext); }
  const sort = filters.sort === 'context' ? 'm.context_limit DESC' : 'm.name ASC';
  return db.all(sql.raw(`
    SELECT m.id, m.name, m.family, m.provider_id, m.release_date, m.attachment, m.reasoning, m.temperature,
      m.tool_call, m.context_limit, m.output_limit, m.status, m.reasoning_options,
      p.input, p.output, p.cache_read, p.cache_write
    FROM models m LEFT JOIN pricing p ON p.model_id = m.id AND p.tier_size IS NULL
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${sort}
  `), ...params);
}

export async function getModelDetail(modelId: string): Promise<any[]> {
  const db = getDrizzleDb();
  return db.all(sql.raw(`
    SELECT m.*, p.input, p.output, p.cache_read, p.cache_write, p.tier_size
    FROM models m LEFT JOIN pricing p ON p.model_id = m.id
    WHERE m.id = ?
  `), modelId);
}

// ── Dashboard: cost analytics ─────────────────────────────────────────────

export async function getCostSummary(groupBy: 'model' | 'day', model?: string): Promise<any[]> {
  const db = getDrizzleDb();
  const params: any[] = [];
  let query: string;
  if (groupBy === 'day') {
    query = `SELECT date(recorded_at) AS period, model, SUM(cost_usd) AS total_cost, SUM(input_tokens) AS total_input_tokens, SUM(output_tokens) AS total_output_tokens, COUNT(*) AS entry_count FROM cost_ledger WHERE ${model ? 'model = ?' : '1=1'} GROUP BY period, model ORDER BY period DESC, model ASC`;
  } else {
    query = `SELECT model, SUM(cost_usd) AS total_cost, SUM(input_tokens) AS total_input_tokens, SUM(output_tokens) AS total_output_tokens, COUNT(*) AS entry_count FROM cost_ledger WHERE ${model ? 'model = ?' : '1=1'} GROUP BY model ORDER BY total_cost DESC`;
  }
  if (model) params.push(model);
  return db.all(sql.raw(query), ...params);
}

// ── Dashboard: metrics helpers ────────────────────────────────────────────

export async function queryModelRuntimeStats(opts: {
  modelId?: string; from?: string; to?: string; limit?: number;
}): Promise<any[]> {
  const db = getDrizzleDb();
  const where: string[] = [];
  const params: any[] = [];
  if (opts.modelId) { where.push('model_id = ?'); params.push(opts.modelId); }
  if (opts.from) { where.push('measured_at >= ?'); params.push(opts.from); }
  if (opts.to) { where.push('measured_at <= ?'); params.push(opts.to); }
  const limit = Math.min(opts.limit ?? 100, 1000);
  return db.all(sql.raw(`
    SELECT * FROM model_runtime_stats
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY measured_at DESC LIMIT ${limit}
  `), ...params);
}

export async function queryTpsLeaderboard(): Promise<any[]> {
  const db = getDrizzleDb();
  return db.all(sql.raw(`
    SELECT m.id as model_id, m.name, m.provider_id,
      AVG(r.tps) as avg_tps, MAX(r.tps) as max_tps,
      AVG(r.latency_p50_ms) as avg_latency_p50,
      AVG(r.cache_hit_rate) as avg_cache_hit_rate,
      COUNT(r.run_id) as run_count
    FROM models m
    LEFT JOIN model_runtime_stats r ON r.model_id = m.id
    GROUP BY m.id
    HAVING COUNT(r.run_id) > 0
    ORDER BY avg_tps DESC
  `));
}

// ── Dashboard: sessions helpers ───────────────────────────────────────────

export async function listSessionsWithCounts(opts: {
  status?: string; model?: string; limit: number; offset: number;
}): Promise<{ sessions: any[]; total: number }> {
  const db = getDrizzleDb();
  const where: string[] = ['1=1'];
  const params: any[] = [];
  if (opts.status) { where.push('s.status = ?'); params.push(opts.status); }
  if (opts.model) { where.push('s.model = ?'); params.push(opts.model); }
  const w = where.join(' AND ');
  const countRows = await db.all(sql.raw(`SELECT COUNT(*) AS total FROM sessions s WHERE ${w}`), ...params);
  const rows = await db.all(sql.raw(`
    SELECT s.id, s.prompt_id, s.prompt_version, s.model, s.status, s.created_at, s.updated_at,
      (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS message_count,
      (SELECT COUNT(*) FROM model_calls WHERE session_id = s.id) AS call_count
    FROM sessions s
    WHERE ${w}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `), ...params, opts.limit, opts.offset);
  return { sessions: rows, total: Number(countRows[0]?.total ?? 0) };
}

export async function getSessionWithCounts(sessionId: string): Promise<any | null> {
  const db = getDrizzleDb();
  const rows = await db.all(sql.raw(`
    SELECT s.*,
      (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS message_count,
      (SELECT COUNT(*) FROM model_calls WHERE session_id = s.id) AS call_count
    FROM sessions s WHERE s.id = ?
  `), sessionId);
  return rows[0] ?? null;
}

export async function listModelCallsForSession(sessionId: string): Promise<any[]> {
  const db = getDrizzleDb();
  return db.select().from(model_calls).where(eq(model_calls.session_id, sessionId)).orderBy(model_calls.turn) as any;
}

export async function deleteSessionCascade(sessionId: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(model_calls).where(eq(model_calls.session_id, sessionId));
  await db.delete(messages).where(eq(messages.session_id, sessionId));
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

// ── Dashboard: cache leaderboard ──────────────────────────────────────────

export async function queryCacheLeaderboard(): Promise<any[]> {
  const db = getDrizzleDb();
  return db.all(sql.raw(`
    SELECT m.id, m.name, m.provider_id, m.context_limit,
      p.input, p.output, p.cache_read,
      (SELECT score FROM benchmarks b WHERE b.model_id = m.id AND b.is_preferred = 1 AND b.benchmark = 'Intelligence Index') as intelligence,
      (SELECT score FROM benchmarks b WHERE b.model_id = m.id AND b.is_preferred = 1 AND b.benchmark = 'Coding Score') as coding,
      (SELECT AVG(r.tps) FROM model_runtime_stats r WHERE r.model_id = m.id) as arena_tps,
      (SELECT AVG(r.latency_p50_ms) FROM model_runtime_stats r WHERE r.model_id = m.id) as arena_latency,
      (SELECT COUNT(*) FROM model_runtime_stats r WHERE r.model_id = m.id) as arena_runs
    FROM models m
    LEFT JOIN pricing p ON p.model_id = m.id AND p.tier_size IS NULL
    ORDER BY intelligence DESC
  `));
}
