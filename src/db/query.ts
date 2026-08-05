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

import { eq, and, desc, asc, sql, count, sum, max, avg, inArray, gte, lte, like, gt, getTableColumns } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getDrizzleDb } from './index.js';
import {
  sessions, messages, model_calls,
  run_models, cost_ledger,
  files, audit_log, output_mappings,
  anomalies,
  prompts, prompt_versions,
  users, roles, user_roles,
  providers, models, model_providers, pricing, model_runtime_stats,
  schedules,
  judge_scores,
} from './schema.js';
import type {
  DbSession, DbMessage, DbModelCall,
  DbPrompt, DbPromptVersion,
  DbUser, DbRole,
  DbOutputMapping, DbSchedule, DbModel,
  DbJudgeScore,
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
  const updates: Partial<typeof run_models.$inferInsert> = { status: newStatus };

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

  // Drizzle update — works on both SQLite and Postgres dialects.
  await db.update(run_models).set(updates).where(
    and(eq(run_models.run_id, runId), eq(run_models.model, model)),
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

export interface ScheduleInput {
  id: string;
  scenario: string;
  models: string[];
  cron: string;
  enabled: boolean;
  createdAt?: string;
}

export async function insertSchedule(s: ScheduleInput): Promise<void> {
  const db = getDrizzleDb();
  const existing = await db.select({ id: schedules.id }).from(schedules).where(eq(schedules.id, s.id)).limit(1);
  if (existing.length > 0) return;
  await db.insert(schedules).values({
    id: s.id, scenario: s.scenario, models: JSON.stringify(s.models),
    cron: s.cron, enabled: s.enabled ? 1 : 0, created_at: s.createdAt ?? new Date().toISOString(),
  });
}

export async function deleteSchedule(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(schedules).where(eq(schedules.id, id));
}

// ── Judge Scores ───────────────────────────────────────────────────────────

export async function insertJudgeScore(data: {
  runId: string; model: string; judgeModel: string;
  averageScore: number; summary: string; scoresJson: string; judgedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(judge_scores).values({
    run_id: data.runId, model: data.model, judge_model: data.judgeModel,
    average_score: data.averageScore, summary: data.summary,
    scores_json: data.scoresJson, judged_at: data.judgedAt,
  }).onConflictDoNothing({ target: [judge_scores.run_id, judge_scores.model] });
}

export async function listJudgeScores(runId?: string): Promise<DbJudgeScore[]> {
  const db = getDrizzleDb();
  const rows = runId
    ? await db.select().from(judge_scores).where(eq(judge_scores.run_id, runId))
    : await db.select().from(judge_scores);
  return rows as DbJudgeScore[];
}

export async function listSchedules(): Promise<DbSchedule[]> {
  const db = getDrizzleDb();
  return db.select().from(schedules) as any;
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
    env_var: providers.env_var,
    provider_adapter: providers.adapter,
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
    .leftJoin(pricing, and(eq(pricing.model_id, models.id), sql`${pricing.tier_size} = 0`))
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

// ── Dashboard: generic paginated query helpers ────────────────────────────

/**
 * Resolve an `orderBy` string against a per-table column map, returning Drizzle
 * order expressions. Never interpolates raw identifiers into SQL. Each
 * comma-separated segment must be a key of `columns` (optionally suffixed with
 * ` ASC`/` DESC`); segments without an explicit direction use `dir` (or asc).
 */
function resolveOrderBy(
  columns: Record<string, SQL>,
  orderBy: string | undefined,
  dir: 'asc' | 'desc' | undefined,
): SQL[] {
  const segments = (orderBy ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    const first = Object.keys(columns)[0]!;
    return [dir === 'desc' ? desc(columns[first]!) : asc(columns[first]!)];
  }
  const out: SQL[] = [];
  for (const segment of segments) {
    const m = /^(.+?)\s+(ASC|DESC)$/i.exec(segment);
    const key = (m ? m[1]! : segment).trim();
    const column = columns[key];
    if (!column) {
      throw new Error(`Refusing to sort by unknown column: ${JSON.stringify(key)}`);
    }
    const d = m ? m[2]!.toLowerCase() as 'asc' | 'desc' : (dir ?? 'asc');
    out.push(d === 'desc' ? desc(column) : asc(column));
  }
  return out;
}

/**
 * Paginate a table with Drizzle: total `count(*)` + `SELECT ... LIMIT/OFFSET`.
 *
 * `orderBy` is whitelisted against `columns` (no raw identifiers in SQL).
 * `offset` takes precedence over `page` when both are provided (route callers
 * speak limit/offset; tests speak page/pageSize).
 */
export async function paginate<T extends Record<string, unknown>>(
  table: any,
  columns: Record<string, any>,
  q: {
    page?: number;
    pageSize: number;
    offset?: number;
    orderBy?: string;
    dir?: 'asc' | 'desc';
    where?: SQL;
  },
): Promise<{ rows: T[]; total: number }> {
  const db = getDrizzleDb();
  const pageSize = Math.max(q.pageSize, 1);
  const page = Math.max(q.page ?? 1, 1);
  const offset = q.offset ?? (page - 1) * pageSize;
  const conds = q.where;
  const countRows = await db.select({ count: count() }).from(table).where(conds);
  const total = (countRows[0]?.count ?? 0) as number;
  const order = resolveOrderBy(columns, q.orderBy, q.dir);
  const rows = await db.select()
    .from(table)
    .where(conds)
    .orderBy(...order)
    .limit(pageSize)
    .offset(offset);
  return { rows: rows as T[], total };
}

// ── Dashboard: prompts helpers ────────────────────────────────────────────

export async function listPromptsWithLatestVersion(): Promise<any[]> {
  const db = getDrizzleDb();
  const promptRows = await db.select().from(prompts).orderBy(asc(prompts.name));
  if (promptRows.length === 0) return [];
  const ids = promptRows.map((p: { id: string }) => p.id);
  const versions = await db.select().from(prompt_versions)
    .where(inArray(prompt_versions.prompt_id, ids))
    .orderBy(desc(prompt_versions.version));
  // First row per prompt is the latest version (descending order).
  const latest = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    if (!latest.has(v.prompt_id)) latest.set(v.prompt_id, v);
  }
  return promptRows.map((p: { id: string; name: string; description: string | null; created_at: string; updated_at: string }) => {
    const lv = latest.get(p.id);
    return {
      id: p.id, name: p.name, description: p.description,
      created_at: p.created_at, updated_at: p.updated_at,
      latest_version: lv?.version ?? null,
      latest_tag: lv?.tag ?? null,
    };
  });
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
  const userRows = await db.select().from(users).orderBy(asc(users.created_at));
  if (userRows.length === 0) return [];
  const roleRows = await db.select({ userId: user_roles.user_id, roleId: user_roles.role_id })
    .from(user_roles)
    .where(inArray(user_roles.user_id, userRows.map((u: { id: string }) => u.id)));
  const rolesByUser = new Map<string, string[]>();
  for (const r of roleRows) {
    const list = rolesByUser.get(r.userId) ?? [];
    list.push(r.roleId);
    rolesByUser.set(r.userId, list);
  }
  return userRows.map((u: { id: string; username: string; created_at: string }) => ({
    id: u.id,
    username: u.username,
    created_at: u.created_at,
    roles: (rolesByUser.get(u.id) ?? []).join(','),
  }));
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
  return db.select({ id: roles.id, description: roles.description })
    .from(roles)
    .innerJoin(user_roles, eq(user_roles.role_id, roles.id))
    .where(eq(user_roles.user_id, userId)) as any;
}

export async function assignUserRole(userId: string, roleId: string): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(user_roles).values({ user_id: userId, role_id: roleId }).onConflictDoNothing();
}

export async function unassignUserRole(userId: string, roleId: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(user_roles).where(
    and(eq(user_roles.user_id, userId), eq(user_roles.role_id, roleId)),
  );
}

export async function countUserRoles(roleId?: string, userId?: string): Promise<number> {
  const db = getDrizzleDb();
  const conds: SQL[] = [];
  if (roleId) conds.push(eq(user_roles.role_id, roleId));
  if (userId) conds.push(eq(user_roles.user_id, userId));
  const rows = await db.select({ cnt: count() }).from(user_roles)
    .where(conds.length ? and(...conds) : undefined);
  return Number(rows[0]?.cnt ?? 0);
}

export async function insertRole(data: { id: string; description: string }): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(roles).values({ id: data.id, description: data.description }).onConflictDoNothing();
}

// ── Dashboard: catalog + model helpers ────────────────────────────────────

export async function listCatalogModels(filters: {
  provider?: string; reasoning?: boolean; toolCall?: boolean;
  minContext?: number; sort?: string; q?: string;
}): Promise<any[]> {
  const db = getDrizzleDb();
  const conds: SQL[] = [];
  if (filters.provider) conds.push(eq(models.provider_id, filters.provider));
  if (filters.reasoning) conds.push(eq(models.reasoning, 1));
  if (filters.toolCall) conds.push(eq(models.tool_call, 1));
  if (filters.minContext != null) conds.push(gte(models.context_limit, filters.minContext));
  if (filters.q) conds.push(like(sql`lower(${models.name})`, `%${filters.q.toLowerCase()}%`));
  const order = filters.sort === 'context' ? desc(models.context_limit) : asc(models.name);
  return db.select({
    id: models.id, name: models.name, family: models.family, provider_id: models.provider_id,
    release_date: models.release_date, attachment: models.attachment, reasoning: models.reasoning,
    temperature: models.temperature, tool_call: models.tool_call,
    context_limit: models.context_limit, output_limit: models.output_limit,
    status: models.status, reasoning_options: models.reasoning_options,
    input: pricing.input, output: pricing.output,
    cache_read: pricing.cache_read, cache_write: pricing.cache_write,
  })
    .from(models)
    .leftJoin(pricing, and(eq(pricing.model_id, models.id), eq(pricing.tier_size, 0)))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(order) as any;
}

export async function getModelDetail(modelId: string): Promise<any[]> {
  const db = getDrizzleDb();
  return db.select({
    ...getTableColumns(models),
    input: pricing.input, output: pricing.output,
    cache_read: pricing.cache_read, cache_write: pricing.cache_write,
    tier_size: pricing.tier_size,
  })
    .from(models)
    .leftJoin(pricing, and(eq(pricing.model_id, models.id), eq(pricing.tier_size, 0)))
    .where(eq(models.id, modelId)) as any;
}

// ── Dashboard: cost analytics ─────────────────────────────────────────────

export async function getCostSummary(groupBy: 'model' | 'day', model?: string): Promise<any[]> {
  const db = getDrizzleDb();
  const where = model ? eq(cost_ledger.model, model) : undefined;
  const common = {
    total_cost: sum(cost_ledger.cost_usd),
    total_input_tokens: sum(cost_ledger.input_tokens),
    total_output_tokens: sum(cost_ledger.output_tokens),
    entry_count: count(),
  };
  if (groupBy === 'day') {
    return db.select({
      period: sql<string>`substr(${cost_ledger.recorded_at}, 1, 10)`,
      model: cost_ledger.model,
      ...common,
    })
      .from(cost_ledger)
      .where(where)
      .groupBy(sql`substr(${cost_ledger.recorded_at}, 1, 10)`, cost_ledger.model)
      .orderBy(desc(sql`substr(${cost_ledger.recorded_at}, 1, 10)`), asc(cost_ledger.model)) as any;
  }
  return db.select({ model: cost_ledger.model, ...common })
    .from(cost_ledger)
    .where(where)
    .groupBy(cost_ledger.model)
    .orderBy(desc(sum(cost_ledger.cost_usd))) as any;
}

// ── Dashboard: metrics helpers ────────────────────────────────────────────

export async function queryModelRuntimeStats(opts: {
  modelId?: string; from?: string; to?: string; limit?: number;
}): Promise<any[]> {
  const db = getDrizzleDb();
  const conds: SQL[] = [];
  if (opts.modelId) conds.push(eq(model_runtime_stats.model_id, opts.modelId));
  if (opts.from) conds.push(gte(model_runtime_stats.measured_at, opts.from));
  if (opts.to) conds.push(lte(model_runtime_stats.measured_at, opts.to));
  const limit = Math.min(opts.limit ?? 100, 1000);
  return db.select().from(model_runtime_stats)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(model_runtime_stats.measured_at))
    .limit(limit) as any;
}

export async function queryTpsLeaderboard(): Promise<any[]> {
  const db = getDrizzleDb();
  const r = model_runtime_stats;
  return db.select({
    model_id: models.id,
    name: models.name,
    provider_id: models.provider_id,
    avg_tps: avg(r.tps),
    max_tps: max(r.tps),
    avg_latency_p50: avg(r.latency_p50_ms),
    avg_cache_hit_rate: avg(r.cache_hit_rate),
    run_count: count(r.run_id),
  })
    .from(models)
    .leftJoin(r, eq(r.model_id, models.id))
    .groupBy(models.id)
    .having(gt(count(r.run_id), 0))
    .orderBy(desc(avg(r.tps))) as any;
}

// ── Dashboard: sessions helpers ───────────────────────────────────────────

export async function listSessionsWithCounts(opts: {
  status?: string; model?: string; limit: number; offset: number;
}): Promise<{ sessions: any[]; total: number }> {
  const db = getDrizzleDb();
  const conds: SQL[] = [];
  if (opts.status) conds.push(eq(sessions.status, opts.status));
  if (opts.model) conds.push(eq(sessions.model, opts.model));
  const where = conds.length ? and(...conds) : undefined;

  const { rows, total } = await paginate(sessions, {
    id: sessions.id,
    model: sessions.model,
    status: sessions.status,
    created_at: sessions.created_at,
    updated_at: sessions.updated_at,
  }, {
    orderBy: 'created_at',
    dir: 'desc',
    pageSize: opts.limit,
    offset: opts.offset,
    where,
  });

  const ids = (rows as Array<{ id: string }>).map(r => r.id);
  const groups = async (table: any, col: any) =>
    ids.length
      ? db.select({ sessionId: col, c: count() }).from(table).where(inArray(col, ids)).groupBy(col)
      : [];
  const msgCounts = new Map((await groups(messages, messages.session_id)).map((g: any) => [g.sessionId, g.c]));
  const callCounts = new Map((await groups(model_calls, model_calls.session_id)).map((g: any) => [g.sessionId, g.c]));

  const result = (rows as Array<{ id: string }>).map(r => ({
    ...r,
    message_count: msgCounts.get(r.id) ?? 0,
    call_count: callCounts.get(r.id) ?? 0,
  }));
  return { sessions: result, total };
}

export async function getSessionWithCounts(sessionId: string): Promise<any | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!rows[0]) return null;
  const [msgCount, callCount] = await Promise.all([
    db.select({ c: count() }).from(messages).where(eq(messages.session_id, sessionId)),
    db.select({ c: count() }).from(model_calls).where(eq(model_calls.session_id, sessionId)),
  ]);
  return {
    ...rows[0],
    message_count: msgCount[0]?.c ?? 0,
    call_count: callCount[0]?.c ?? 0,
  };
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
  const r = model_runtime_stats;
  return db.select({
    id: models.id,
    name: models.name,
    provider_id: models.provider_id,
    context_limit: models.context_limit,
    input: pricing.input,
    output: pricing.output,
    cache_read: pricing.cache_read,
    intelligence: sql<number>`(SELECT score FROM benchmarks b WHERE b.model_id = ${models.id} AND b.is_preferred = 1 AND b.benchmark = 'Intelligence Index')`,
    coding: sql<number>`(SELECT score FROM benchmarks b WHERE b.model_id = ${models.id} AND b.is_preferred = 1 AND b.benchmark = 'Coding Score')`,
    arena_tps: sql<number>`(SELECT AVG(x.tps) FROM ${r} x WHERE x.model_id = ${models.id})`,
    arena_latency: sql<number>`(SELECT AVG(x.latency_p50_ms) FROM ${r} x WHERE x.model_id = ${models.id})`,
    arena_runs: sql<number>`(SELECT COUNT(*) FROM ${r} x WHERE x.model_id = ${models.id})`,
  })
    .from(models)
    .leftJoin(pricing, and(eq(pricing.model_id, models.id), eq(pricing.tier_size, 0)))
    .orderBy(desc(sql`(SELECT score FROM benchmarks b WHERE b.model_id = ${models.id} AND b.is_preferred = 1 AND b.benchmark = 'Intelligence Index')`)) as any;
}
