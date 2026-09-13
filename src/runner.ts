import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { outputRoot, dbPath, findProjectRoot, modelDirSegment } from './paths.js';
import { initDb } from './db/index.js';
import { transitionTaskState, listModelCallsForSession, listMessagesBySession, getPromptVersion } from './db/query.js';
import { getRunRecord } from './db/runs.js';
import { resumeFrom } from './runner/checkpoint.js';
import { createQueue, type TaskQueue, type Task, DEFAULT_MAX_ATTEMPTS, isTerminalAttempt } from './queue/index.js';
import { createSessionStore } from './session/store.js';
import { ProviderRegistry, loadBuiltins } from './providers/index.js';
import { resolveModelForRun, type ResolvedModel } from './db/model-resolver.js';
import { loadScenario, resolveScenarioPath, toSendOptsReasoning, type ScenarioConfig } from './config.js';
import { createLogger } from './logger/pino-logger.js';
import { ConversationLogger } from './logger/conversation-logger.js';
import { writeReport } from './logger/report-logger.js';
import { writeResultJson, type RunResult } from './logger/result-logger.js';
import { Sandbox, sandboxEnv, resolveSeedDir, isWithin } from './sandbox/sandbox.js';
import { SandboxGit, writeDiffPatch } from './sandbox/git.js';
import { SHELL_METACHAR_RE } from './sandbox/shell-policy.js';
import { generateManifest, writeManifest, buildProducedByTool } from './sandbox/artifact-manifest.js';
import { getProfile, getAllowedTools } from './profiles/definitions.js';
import { evaluateRunLimits, resolveExecutionStartMs } from './runner/limits.js';
import { runAgentLoopTraced } from './observability/instrument-loop.js';
import { TOOL_DEFINITIONS, buildToolExecutors } from './tools/index.js';
import { CircuitBreaker, CircuitOpenError } from './providers/circuit-breaker.js';
import { resolveFallback, resolveMaxFallbackHops, type FallbackConfig } from './providers/fallback.js';
import { loadBudgetConfig, checkBudget, computeCost, computeTotalCost, budgetStateRoot } from './cost-tracking/index.js';
import type { CostTokenUsage } from './cost-tracking/types.js';
import { isKillSwitchActive, isRunCancelled, clearRunCancelled, dispatchBudgetExceeded } from './orchestrator/run-lifecycle.js';
import { activeTasks, taskCounter, taskDuration, tasksClaimed, tasksFailed, startMetricsServer } from './observability/metrics.js';
import type { ToolExecutionContext, TokenUsage, ChatMessage, Logger } from './types.js';
import type { SendOpts } from './providers/adapters/base.js';
import type { StoredMessage } from './session/store.js';
import { closeDb } from './db/index.js';
import { secretStore } from './secrets/store.js';
import { assertRequiredEnv } from './env/required.js';

interface RunnerOptions {
  queue?: TaskQueue;
  signal?: AbortSignal;
  fallbackChain?: FallbackConfig;
}

// Per-pod emptyDir mount (k8s/base/*runner*.yaml), writable by the non-root
// runner image user. Not the OS temp dir — CodeQL js/insecure-temporary-file
// flags any predictable write under /tmp, and /tmp is an emptyDir mount that
// a pre-planted symlink could otherwise abuse.
const READINESS_FILE = '/var/arena/readiness/runner-ready';

/**
 * Write the readiness file. Created with O_EXCL ('wx') so a pre-placed
 * symlink is never followed: on EEXIST we unlink (which removes the link
 * itself, not its target) and re-create exclusively. Failures are
 * non-fatal — the k8s probe simply sees not-ready and retries.
 */
export function markReady(filePath: string = READINESS_FILE): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(filePath, Date.now().toString(), { flag: 'wx' });
    } catch {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      try { fs.writeFileSync(filePath, Date.now().toString(), { flag: 'wx' }); } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal — probe will retry */ }
}

export function unmarkReady(filePath: string = READINESS_FILE): void {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

interface SuccessOutcome {
  command?: string;
  expectedExitCode: number;
  exitCode: number | null;
  output: string;
  outputContainsPassed?: boolean;
  passed: boolean;
}

// Ported verbatim from the legacy worker (src/worker.ts): runs the scenario's
// successCriteria command inside the sandbox and reports whether it passed.
export async function runSuccessCriteria(
  scenario: ScenarioConfig,
  sandboxDir: string,
  ctx: ToolExecutionContext,
): Promise<SuccessOutcome | undefined> {
  const sc = scenario.successCriteria;
  if (!sc || !sc.command) return undefined;

  const outcome: SuccessOutcome = {
    command: sc.command,
    expectedExitCode: sc.expectedExitCode,
    exitCode: null,
    output: '',
    outputContainsPassed: undefined,
    passed: false,
  };

  if (SHELL_METACHAR_RE.test(sc.command)) {
    return {
      command: sc.command,
      expectedExitCode: sc.expectedExitCode,
      exitCode: -1,
      output: 'successCriteria.command contains disallowed shell metacharacters. ' +
              'Use a simple command like "npm test" or "python -m pytest".',
      passed: false,
    };
  }
  const [bin = '', ...args] = sc.command.trim().split(/\s+/);
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        bin, args,
        {
          cwd: sandboxDir,
          timeout: ctx.shellTimeoutMs,
          maxBuffer: ctx.maxShellOutputBytes,
          env: sandboxEnv(),
        },
        (err, stdout, stderr) => {
          if (err) reject(Object.assign(err, { stdout, stderr }));
          else resolve({ stdout });
        },
      );
    });
    outcome.output = stdout;
    outcome.exitCode = 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    outcome.output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
    outcome.exitCode = typeof e.code === 'number' ? e.code : null;
  }

  let ok = outcome.exitCode === outcome.expectedExitCode;
  if (sc.expectedOutputContains) {
    const contains = outcome.output.includes(sc.expectedOutputContains);
    outcome.outputContainsPassed = contains;
    ok = ok && contains;
  }
  outcome.passed = ok;
  return outcome;
}

/**
 * Self-finalize the run once all of its model tasks reach a terminal state.
 * Queue-driven runs previously depended on the dashboard watcher polling
 * every 3s; if the dashboard was down they never finalized. finalizeRunByRunId
 * is idempotent (skips already-completed runs), so racing the watcher or a
 * CLI finalize is safe.
 */
async function maybeFinalizeRun(runId: string, log: Logger): Promise<void> {
  try {
    const { isRunCompleteByRunId, finalizeRunByRunId } = await import('./orchestrator/run-lifecycle.js');
    if (!(await isRunCompleteByRunId(runId))) return;
    await finalizeRunByRunId(runId, log);
  } catch (err) {
    log.warn('Self-finalize failed (non-fatal)', { runId, error: String(err) });
  }
}

/**
 * True iff `id` cannot be used as a run-id directory segment. Dots are allowed
 * (CLI scenario stems and timestamps may contain them); a path separator, NUL,
 * or a "."/".." segment is not. The containment assert downstream is the
 * actual boundary — this is the pre-fs-write rejection.
 */
function isUnsafeRunId(id: string): boolean {
  return id.length === 0
    || id === '.' || id === '..'
    || /[\\/\0]/.test(id)
    || path.isAbsolute(id)
    || id.startsWith('~');
}

/** Sum of a session's prior model-call spend (for resume budget continuity). */
export async function sumPriorRunSpend(sessionId: string, modelName: string): Promise<number> {
  let total = 0;
  const priorCalls = await listModelCallsForSession(sessionId);
  for (const c of priorCalls) {
    const usage = JSON.parse(c.usage ?? '{}') as {
      prompt?: number; completion?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
    };
    const prior = await computeCost(modelName, {
      prompt: Number(usage.prompt ?? 0),
      completion: Number(usage.completion ?? 0),
      cached: Number(usage.cacheReadTokens ?? 0),
      cacheWrite: Number(usage.cacheWriteTokens ?? 0),
    });
    total = Math.max(total, prior.total);
  }
  return total;
}

export async function startRunner(opts: RunnerOptions = {}): Promise<void> {
  const logger = createLogger('ai-arena:runner');

  // Fail fast on missing required env before createQueue/initDb connect.
  try {
    assertRequiredEnv('runner');
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err), { component: 'runner', action: 'exit' });
    process.exit(1);
  }

  const queue = opts.queue ?? createQueue();
  // Mirrors each queue driver's nack dead-letter decision: a nack bumps the
  // task's attempts and dead-letters at >= maxAttempts, so the attempt being
  // nacked right now is terminal iff attempts + 1 >= maxAttempts.
  const maxTaskAttempts = queue.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const isTerminalFailure = (attempts: number): boolean => isTerminalAttempt(attempts, maxTaskAttempts);
  const ac = new AbortController();
  const signal = opts.signal ?? ac.signal;
  const runnerId = process.env.REDIS_CONSUMER_NAME ?? `runner-${process.pid}`;

  const root = findProjectRoot();
  initDb(dbPath());

  // Expose this process's prom-client registry (task/queue metrics) so
  // Prometheus can actually scrape runner counters. Disable in tests.
  if (process.env.RUNNER_METRICS_ENABLED !== 'false') {
    startMetricsServer();
  }

  // Load budget config for enforcement in the runner loop
  loadBudgetConfig(path.join(root, 'configs', 'budget.yaml'), logger);

  const store = createSessionStore();
  const registry = new ProviderRegistry();
  loadBuiltins(registry);
  await registry.loadCustomFromDb();

  let runningTask: Task | null = null;

  const shutdown = async () => {
    logger.info('Runner shutting down...');
    unmarkReady();
    ac.abort();
    const task = runningTask;
    if (task) {
      logger.info('Waiting for in-flight task to complete', { taskId: task.taskId });
      const deadline = Date.now() + 30_000;
      while (runningTask && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
      }
      if (runningTask) {
        logger.warn('Task did not finish within 30s, abandoning', { taskId: task.taskId });
        try {
          await queue.nack(task._redisId ?? task.taskId, 'runner shutdown timeout');
        } catch { /* best-effort nack */ }
      }
    }
    if (queue.close) await queue.close();
    await closeDb();
    logger.info('Runner stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown().catch((err) => {
      logger.error('Shutdown error', { signal: 'SIGINT', error: String(err) });
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    shutdown().catch((err) => {
      logger.error('Shutdown error', { signal: 'SIGTERM', error: String(err) });
      process.exit(1);
    });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { error: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  logger.info('Runner starting');

  // Mark runner as ready after all initialization (DB, registry, store)
  // but before entering the dequeue loop.
  markReady();

  const cleanupInterval = setInterval(() => {
    CircuitBreaker.cleanup();
  }, 300_000);
  cleanupInterval.unref();

  while (!signal.aborted) {
    if (await isKillSwitchActive()) {
      if (!runningTask) {
        logger.info('Kill switch active — stopping dequeue loop');
        break;
      }
      logger.info('Kill switch active — finishing in-flight task before stopping');
    }
    let task: Task | null = null;
    let taskStartedAt: Date | null = null;
    let taskCounted = false;
    try {
      // Race the dequeue against the abort signal so shutdown does not wait
      // out a 30s blocked XREADGROUP/XREAD.
      let abortCleanup: () => void = () => {};
      const abortWait = new Promise<Task | null>((resolve) => {
        if (signal.aborted) { resolve(null); return; }
        const onAbort = () => resolve(null);
        signal.addEventListener('abort', onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener('abort', onAbort);
      });
      task = await Promise.race([queue.dequeue(30000), abortWait]);
      abortCleanup();
      if (!task) continue;
      runningTask = task;
      taskStartedAt = new Date();
      activeTasks.inc();

      // Queue tasks are untrusted input: the run-id segment is validated here
      // and the run directory (derived from the resolved model below) must stay
      // under outputRoot() before any directory is created or artifact written.
      const modelRunId = String(task.config.modelRunId ?? task.sessionId);
      const runId = modelRunId;
      const modelName = task.model;
      if (isUnsafeRunId(modelRunId)) {
        throw new Error(`Invalid run id "${modelRunId}": path separators and parent references are not allowed`);
      }
      const startedAt = new Date();

      // Check per-run cancellation before starting execution
      if (await isRunCancelled(runId)) {
        logger.info('Run cancelled before execution', { runId, taskId: task.taskId });
        await clearRunCancelled(runId);
        await queue.ack(task._redisId ?? task.taskId);
        continue;
      }
      // Only count claimed once the task is actually executed — a cancelled
      // task acked without running would skew claimed/failed ratios.
      tasksClaimed.inc();

      logger.info('Task dequeued', { taskId: task.taskId, model: task.model, scenario: task.scenario });

      // Transition task to 'claimed' state (persisted in DB). Awaited so the
      // ordering contract holds on Postgres (queries spread across pool
      // connections): terminal writes must never land before the claimed/
      // running transitions they follow.
      try {
        await transitionTaskState(runId, task.model, 'claimed', runnerId);
      } catch (e) {
        logger.warn('Failed to write claimed state', { error: String(e) });
      }

      let initialTurn = 1;
      // Cumulative spend of this run's tokens, so per-turn budget checks see
      // the current run (addSpend is only called during finalize otherwise).
      // Seeded from persisted model calls on resume so a restarted run does
      // not lose sight of what the pre-crash attempt already spent.
      let prevRunCost = 0;
      // Wall-clock cap anchor: the session is created at first dequeue with a
      // deterministic id (`${runId}-${model}`), so session.created_at marks the
      // first execution for this run+model. Queue wait and sibling-model runtime
      // do not count toward the cap, while nack retries and runner restarts
      // cannot reset it. First attempt (no session yet) falls back to now.
      let session = await store.loadSession(task.sessionId);
      const executionStartedAtMs = resolveExecutionStartMs(session?.createdAt, startedAt.getTime());
      let resumedMessages: ChatMessage[] | undefined;
      if (!session) {
        session = await store.createSession({
          id: task.sessionId, model: task.model,
          promptId: task.promptId, promptVersion: task.promptVersion,
        });
        // Nothing to resume — nothing persisted yet.
      } else {
        const resumed = await resumeFrom(session.id);
        if (resumed.messages.length > 0) {
          resumedMessages = resumed.messages;
          initialTurn = resumed.lastCompletedTurn + 1;
          try {
            prevRunCost = await sumPriorRunSpend(session.id, task.model);
          } catch (e) {
            logger.warn('Failed to sum prior run spend (non-fatal)', { sessionId: session.id, err: String(e) });
          }
          logger.info('Resuming session from checkpoint', { sessionId: session.id, turns: initialTurn, messages: resumed.messages.length, priorSpend: prevRunCost });
        }
      }

      const scenarioName = task.scenario;
      const scenarioDir = path.join(process.cwd(), 'configs', 'scenarios');
      const scenario = loadScenario(resolveScenarioPath(scenarioDir, scenarioName, {
        allowPath: task.config.scenarioSource === 'cli',
      }));

      // A prompt-version run uses the stored prompt text instead of the
      // scenario's; a prompt that no longer exists fails the run rather than
      // silently executing different instructions.
      const storedPrompt = task.promptId
        ? await getPromptVersion(task.promptId, task.promptVersion ?? 1)
        : null;
      if (task.promptId && !storedPrompt) {
        throw new Error(`Prompt version not found: ${task.promptId}@${task.promptVersion ?? 1}`);
      }
      const systemPrompt = storedPrompt?.system_prompt ?? scenario.systemPrompt;
      const taskPrompt = storedPrompt?.task ?? scenario.task;

      // Resolve the model before any fs write so a catalog miss cannot leave
      // an output directory behind.
      const resolved = await resolveModelForRun(modelName);
      if (!resolved) {
        logger.error('Model not found', { model: modelName });
        // nack requeues below the DLQ threshold — count failed + duration
        // only when the nack dead-letters (terminal).
        if (isTerminalFailure(task!.attempts)) {
          taskCounter.inc({ model: modelName, scenario: scenarioName, status: 'failed' });
          taskDuration.observe({ model: modelName, scenario: scenarioName }, (Date.now() - startedAt.getTime()) / 1000);
          taskCounted = true;
          tasksFailed.inc();
          // The nack below dead-letters this attempt, so the model task just
          // reached a terminal state. Mark the model row failed and finalize
          // the run; without this the run stays wedged in 'running' forever
          // (isRunCompleteByRunId never sees a terminal status).
          try {
            await transitionTaskState(runId, task!.model, 'failed', runnerId);
          } catch (err: unknown) {
            const detail = err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) };
            logger.error('transitionTaskState to "failed" failed for missing model — run may be stuck in "running" state', { taskId: task!.taskId, modelRunId: runId, ...detail });
          }
          void maybeFinalizeRun(runId, logger).catch(() => undefined);
        }
        await queue.nack(task!._redisId ?? task!.taskId, `Model not found: ${modelName}`);
        continue;
      }

      // Derive the directory from the resolved canonical id (falling back to
      // the lookup key) the same way createRunSpec does, so orchestrator and
      // runner agree on outputDir without task.model ever reaching a path.
      const modelDir = modelDirSegment(resolved.canonicalId || modelName);
      const runOutputDir = path.join(outputRoot(), modelDir, modelRunId);
      const sandboxDir = path.join(runOutputDir, 'files');
      if (!isWithin(outputRoot(), path.resolve(runOutputDir))) {
        throw new Error(`Run output path escapes the output root: ${runOutputDir}`);
      }

      // Fresh sessions persist the initial system+task as turn 0 so a later
      // resume can replay the full context.
      if (!resumedMessages) {
        const t0 = new Date().toISOString();
        const turnZero: StoredMessage[] = [
          { id: crypto.randomUUID(), sessionId: session.id, turn: 0, role: 'system', content: systemPrompt, toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: t0 },
          { id: crypto.randomUUID(), sessionId: session.id, turn: 0, role: 'user', content: taskPrompt, toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: t0 },
        ];
        for (const m of turnZero) await store.appendMessage(session.id, m);
      }

      fs.mkdirSync(runOutputDir, { recursive: true });
      fs.mkdirSync(sandboxDir, { recursive: true });

      // Ported from worker.ts: conversation.json is written so report.md can
      // be generated from it at the end of the run.
      const conv = new ConversationLogger(path.join(runOutputDir, 'conversation.json'), {
        model: modelName,
        scenario: scenarioName,
        runId: modelRunId,
        startedAt: startedAt.toISOString(),
      });

      // Resume continuity: replay the persisted transcript into
      // conversation.json so artifacts (report.md, manifest) cover the whole
      // run, not just the post-resume fragment.
      if (resumedMessages) {
        try {
          const stored = await listMessagesBySession(session.id);
          for (const m of stored) {
            if (m.role === 'system' || m.role === 'user') {
              conv.append({ type: m.role === 'system' ? 'system' : 'user', role: m.role, content: m.content, turn: m.turn });
            } else if (m.role === 'assistant') {
              conv.append({ type: 'assistant', role: 'assistant', content: m.content, turn: m.turn, toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined });
            } else if (m.role === 'tool') {
              conv.append({ type: 'tool_result', role: 'tool', content: m.content, toolCallId: m.tool_call_id ?? undefined, turn: m.turn });
            }
          }
        } catch (e) {
          logger.warn('Failed to replay persisted transcript (non-fatal)', { sessionId: session.id, err: String(e) });
        }
      }

      const profile = getProfile(scenario.executionProfile ?? 'read-only-analysis');
      const allowedTools = new Set(getAllowedTools(profile));

      const toolCtx: ToolExecutionContext = {
        sandboxDir,
        logger: logger.child('tools'),
        shellTimeoutMs: scenario.shellTimeoutMs,
        maxShellOutputBytes: scenario.maxShellOutputBytes,
        shellPolicy: scenario.shellPolicy,
        webAccess: scenario.webAccess && profile.webAccess,
        executionProfile: profile.name,
        allowedTools,
      };

      const sandbox = new Sandbox(sandboxDir);
      sandbox.ensure();
      if (scenario.starterFiles) {
        const templateDir = resolveSeedDir(scenarioDir, scenario.starterFiles);
        if (templateDir) sandbox.seedFrom(templateDir);
      }

      // Ported from worker.ts: init git after seeding so the final diff.patch
      // captures only agent-made changes relative to the starter state.
      const sandboxGit = new SandboxGit({ sandboxDir, modelName, logger });
      await sandboxGit.init();

      // Ported from worker.ts: fail fast on a missing API key instead of
      // letting the adapter surface a confusing auth error mid-loop.
      const descriptor = registry.get(resolved.providerId);
      // Bedrock authenticates via SigV4/IAM credentials and its catalog
      // "envVar" is the region: it has no API-key secret to require.
      const keylessProvider = descriptor?.adapter === 'bedrock' || descriptor?.authScheme === 'none';
      if (!keylessProvider && resolved.envVar && !secretStore.get(resolved.envVar)) {
        const msg = `Missing API key: set ${resolved.envVar} in your .env`;
        logger.error(msg, { model: modelName });
        writeResultJson(path.join(runOutputDir, 'result.json'), {
          model: modelName, scenario: scenarioName, runId: modelRunId,
          startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
          durationMs: 0, turnsUsed: 0, maxTurns: 0, totalToolCalls: 0, toolsCalled: [],
          tokenUsage: {}, stopReason: 'setup_error', errors: [msg], success: false,
        });
        // Awaited before maybeFinalizeRun below: on Postgres the pg.Pool
        // spreads queries across connections, so a fire-and-forget UPDATE
        // could lose the race against the isRunCompleteByRunId SELECT.
        try {
          await transitionTaskState(runId, task.model, 'failed', runnerId);
        } catch (err: unknown) {
          const detail = err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) };
          logger.error('transitionTaskState to "failed" failed — run may be stuck in "running" state', { taskId: task!.taskId, modelRunId: runId, ...detail });
        }
        taskCounter.inc({ model: modelName, scenario: scenarioName, status: 'failed' });
        taskDuration.observe({ model: modelName, scenario: scenarioName }, (Date.now() - startedAt.getTime()) / 1000);
        taskCounted = true;
        tasksFailed.inc();
        await queue.ack(task!._redisId ?? task!.taskId);
        void maybeFinalizeRun(runId, logger).catch(() => undefined);
        continue;
      }

      let currentProvider = resolved.providerId;
      let currentModel = resolved.apiModelId;
      const apiKey = descriptor?.envVar ? secretStore.get(descriptor.envVar) : undefined;
      const executors = buildToolExecutors();
      let adapter = registry.createAdapter(currentProvider, currentModel, { apiKey, logger: logger.child('adapter') });

      // Scenario-configured reasoning plus the catalog sampling/output limits.
      // These must ride in sendOpts (not only as span attributes) so every
      // adapter — and the subagent — receives them. Null capability fields
      // mean "omit": unsupported temperature on reasoning-only models
      // (o-series) and max_tokens with no known output limit both 400.
      const reasoningOpt = toSendOptsReasoning(scenario.reasoning);
      const buildSendOpts = (m: ResolvedModel | null): SendOpts => {
        const opts: SendOpts = {};
        if (m?.temperature != null) opts.temperature = m.temperature;
        if (m?.maxTokens != null && !m.reasoningOnly) opts.maxTokens = m.maxTokens;
        if (reasoningOpt) opts.reasoning = reasoningOpt;
        return opts;
      };
      let sendOpts = buildSendOpts(resolved);

      // Wire subagent support: strip recursive tools
      const subagentToolNames = new Set(['task', 'todo_read', 'todo_write']);
      const subagentTools = TOOL_DEFINITIONS.filter(t => !subagentToolNames.has(t.name));
      const subagentExecutors: typeof executors = {};
      for (const [name, fn] of Object.entries(executors)) {
        if (!subagentToolNames.has(name)) subagentExecutors[name] = fn;
      }
      toolCtx.subagent = {
        maxTurns: 5,
        sendMessage: (msgs, tools, opts) => adapter.sendMessage(msgs, tools, opts),
        sendOpts,
        supportsReasoning: adapter.supportsReasoning(),
        supportsPromptCaching: adapter.supportsPromptCaching(),
        logger: logger.child('subagent'),
        tools: subagentTools,
        executors: subagentExecutors,
        shellTimeoutMs: toolCtx.shellTimeoutMs,
        maxShellOutputBytes: toolCtx.maxShellOutputBytes,
        shellPolicy: toolCtx.shellPolicy,
        webAccess: toolCtx.webAccess,
        executionProfile: toolCtx.executionProfile,
        allowedTools: toolCtx.allowedTools,
      };
      let loopResult;
      let maxFallbackHops = resolveMaxFallbackHops();

      // Transition to 'running'
      try {
        await transitionTaskState(runId, task.model, 'running', runnerId);
      } catch (e) {
        logger.warn('Failed to write running state', { error: String(e) });
      }

      // Per-call spend tracking for the budget check. The turn hook receives
      // cumulative usage, so each turn's cost is the delta from the previous
      // cumulative snapshot; attemptRunCost resets on a fallback so a retried
      // attempt is not counted twice on top of the pre-attempt seed.
      const seededRunCost = prevRunCost;
      while (maxFallbackHops >= 0) {
        const breaker = CircuitBreaker.for(currentProvider, currentModel);
        let attemptRunCost = 0;
        let prevTurnUsage: TokenUsage = {};
        try {
          const traced = await breaker.exec(() => runAgentLoopTraced({
            adapter,
            tools: TOOL_DEFINITIONS,
            executors,
            systemPrompt,
            task: taskPrompt,
            maxTurns: scenario.maxTurns ?? profile.maxTurns,
            toolCtx,
            conv,
            logger: logger.child('loop'),
            initialMessages: resumedMessages,
            initialTurn,
            provider: currentProvider,
            model: currentModel,
            temperature: sendOpts.temperature,
            maxTokens: sendOpts.maxTokens,
            sendOpts,
            scenario: scenarioName,
            runId: modelRunId,
            modelConfig: modelName,
            outputDir: runOutputDir,
            onTurnComplete: async (turn, newMessages, usage, durationMs) => {
              // Persist the real conversation so checkpoint/resume replays
              // actual content instead of empty stubs.
              for (const m of newMessages) {
                await store.appendMessage(session.id, {
                  id: crypto.randomUUID(),
                  sessionId: session.id,
                  turn,
                  role: m.role,
                  content: m.content ?? null,
                  toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
                  toolCallId: m.toolCallId ?? null,
                  tokenInput: usage.prompt ?? null,
                  tokenOutput: usage.completion ?? null,
                  createdAt: new Date().toISOString(),
                });
              }
              // Record the model call for this turn; the request latency is
              // the TTFT for non-streaming sends (first byte ≈ full latency).
              try {
                const assistantMsg = [...newMessages].reverse().find((m) => m.role === 'assistant');
                await store.recordModelCall({
                  sessionId: session.id,
                  turn,
                  provider: currentProvider,
                  model: currentModel,
                  requestHash: `${task!.taskId}:${turn}`,
                  responseText: assistantMsg?.content ?? null,
                  usage: {
                    prompt: usage.prompt ?? 0,
                    completion: usage.completion ?? 0,
                    total: usage.total ?? 0,
                    cacheReadTokens: usage.cacheReadTokens ?? 0,
                    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                  },
                  latencyMs: durationMs ?? null,
                  ttftMs: durationMs ?? null,
                });
              } catch (e) {
                logger.warn('Failed to record model call (non-fatal)', { turn, err: String(e) });
              }
              // Track this run's spend so the per-turn budget check below can
              // trip on it (spend only reaches the ledger at finalize time).
              // Price the current turn's token delta, not the cumulative total,
              // so the over-200k tier is applied per request.
              try {
                const turnUsage: CostTokenUsage = {
                  prompt: Math.max(0, (usage.prompt ?? 0) - (prevTurnUsage.prompt ?? 0)),
                  completion: Math.max(0, (usage.completion ?? 0) - (prevTurnUsage.completion ?? 0)),
                  cached: Math.max(0, (usage.cacheReadTokens ?? 0) - (prevTurnUsage.cacheReadTokens ?? 0)),
                  cacheWrite: Math.max(0, (usage.cacheWriteTokens ?? 0) - (prevTurnUsage.cacheWriteTokens ?? 0)),
                };
                prevTurnUsage = {
                  prompt: usage.prompt,
                  completion: usage.completion,
                  cacheReadTokens: usage.cacheReadTokens,
                  cacheWriteTokens: usage.cacheWriteTokens,
                };
                const turnCost = await computeCost(modelName, turnUsage);
                attemptRunCost += turnCost.total;
                prevRunCost = Math.max(prevRunCost, seededRunCost + attemptRunCost);
              } catch (e) {
                logger.warn('Failed to compute run spend (non-fatal)', { model: modelName, err: String(e) });
              }
            },
            onBudgetCheck: async (_turn: number, _tokenUsage: TokenUsage) => {
              const cancelledRunId = modelRunId;
              if (await isRunCancelled(cancelledRunId)) {
                logger.info('Run cancelled during execution', { runId: cancelledRunId });
                return false;
              }
              const elapsedMs = Date.now() - executionStartedAtMs;
              const limitReason = evaluateRunLimits(
                { maxExecutionSec: profile.maxExecutionSec, maxCostUsd: profile.maxCostUsd },
                { elapsedMs, runCostUsd: prevRunCost },
              );
              if (limitReason) {
                logger.warn('Run limit exceeded during run', {
                  runId: modelRunId, reason: limitReason, elapsedMs, spentUsd: prevRunCost,
                  maxExecutionSec: profile.maxExecutionSec, maxCostUsd: profile.maxCostUsd,
                });
                return limitReason;
              }
              const budgetCheck = checkBudget(modelName, budgetStateRoot(root), false, logger, prevRunCost);
              if (!budgetCheck.allowed) {
                logger.warn('Budget exceeded during run', { model: modelName, spent: budgetCheck.spentUsd, limit: budgetCheck.limitUsd });
                void dispatchBudgetExceeded(modelName, budgetCheck, logger).catch(() => undefined);
                return false;
              }
              return true;
            },
          }));
          loopResult = traced.result;
          break;
        } catch (err) {
          if (err instanceof CircuitOpenError && opts.fallbackChain) {
            const next = resolveFallback({ provider: currentProvider, model: currentModel }, opts.fallbackChain);
            if (next && maxFallbackHops > 0) {
              logger.warn('Falling back', { from: `${currentProvider}/${currentModel}`, to: `${next.provider}/${next.model}` });
              currentProvider = next.provider;
              currentModel = next.model;
              // Rebuild sampling options from the hop's own catalog row so a
              // fallback never inherits the primary's temperature/maxTokens
              // (a lower output cap or a reasoning-only model would 400).
              const hopResolved = await resolveModelForRun(currentModel, currentProvider);
              sendOpts = buildSendOpts(hopResolved);
              // The subagent shares the live adapter; keep its inherited
              // options in sync with the hop as well.
              if (toolCtx.subagent) toolCtx.subagent.sendOpts = sendOpts;
              const fallbackDescriptor = registry.get(currentProvider);
              const fallbackApiKey = fallbackDescriptor?.envVar ? secretStore.get(fallbackDescriptor.envVar) : undefined;
              adapter = registry.createAdapter(currentProvider, currentModel, { apiKey: fallbackApiKey, logger: logger.child('adapter') });
              maxFallbackHops--;
              continue;
            }
          }
          throw err;
        }
      }

      const result = loopResult!;

      // ── Ported from worker.ts: success criteria + git diff + result/report artifacts ──
      let success = result.stopReason === 'task_complete';
      let successOutcome: Awaited<ReturnType<typeof runSuccessCriteria>> | undefined;
      try {
        successOutcome = await runSuccessCriteria(scenario, sandboxDir, toolCtx);
        success = successOutcome ? successOutcome.passed : success;
      } catch { /* non-fatal */ }

      // Sum the per-call costs so each request is tiered on its own tokens;
      // the aggregate fallback covers runs with no per-call usage (legacy).
      const costBreakdown = await computeTotalCost(modelName, result.usagePerCall, result.tokenUsage);

      await sandboxGit.commitFinal(success ? 'Task completed successfully' : 'Task failed or incomplete');
      const diff = await sandboxGit.generateDiff();
      if (diff) await writeDiffPatch(runOutputDir, diff, logger);

      const finishedAt = new Date();
      const runResult: RunResult = {
        model: modelName, scenario: scenarioName, runId: modelRunId,
        startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        // turn-loop's turnsUsed is already the absolute turn number, including
        // the resumed run's initialTurn offset.
        turnsUsed: result.turnsUsed, maxTurns: result.maxTurns,
        totalToolCalls: result.totalToolCalls, toolsCalled: result.toolsCalled,
        tokenUsage: result.tokenUsage, stopReason: result.stopReason,
        errors: result.errors, success, costUsd: costBreakdown.total,
        toolSuccessRates: result.toolSuccessRates,
        successCriteria: successOutcome ? {
          command: successOutcome.command, expectedExitCode: successOutcome.expectedExitCode,
          exitCode: successOutcome.exitCode, output: successOutcome.output,
          outputContainsPassed: successOutcome.outputContainsPassed, passed: successOutcome.passed,
        } : undefined,
      };
      writeResultJson(path.join(runOutputDir, 'result.json'), runResult);
      conv.setEnded(runResult.finishedAt);
      try {
        const convFile = JSON.parse(fs.readFileSync(path.join(runOutputDir, 'conversation.json'), 'utf8'));
        writeReport(path.join(runOutputDir, 'report.md'), runResult, convFile);
      } catch { /* best-effort */ }

      // A run stopped mid-execution stays stopped: stopRun records the cancel
      // signal and a terminal 'stopped' index row, and finalizeRunByRunId
      // writes the index directly (bypassing transitionTaskState's terminal
      // guard), so success finalization is skipped entirely below.
      const runStopped = (await isRunCancelled(modelRunId))
        || (await getRunRecord(modelRunId))?.status === 'stopped';

      // run_models.status reflects loop health, not the success-criteria result:
      // a clean loop whose criteria failed stays 'completed' (criteria is
      // recorded in result.json). Loop errors still map to 'failed'.
      const finalStatus = runStopped ? 'stopped' : result.errors.length > 0 ? 'failed' : 'completed';
      // Awaited before maybeFinalizeRun's completeness SELECT: on Postgres the
      // pool spreads queries across connections, so a fire-and-forget UPDATE
      // could lose the race and leave the run wedged in 'running'.
      try {
        await transitionTaskState(runId, task.model, finalStatus, runnerId);
      } catch (e) {
        logger.warn('Failed to write final state', { error: String(e) });
      }
      try {
        const producedByTool = buildProducedByTool(conv.entries);
        const manifest = generateManifest(sandboxDir, modelRunId, modelName, producedByTool);
        writeManifest(manifest, runOutputDir, logger);
        // Persist per-file rows so the dashboard Files page has lineage data.
        // Replaced per runId so restarts do not duplicate rows.
        try {
          const { replaceFilesForRun } = await import('./db/query.js');
          await replaceFilesForRun({
            runId: modelRunId,
            entries: manifest.entries.map((e) => ({ path: e.path, producedByTool: e.producedByTool ?? null })),
            model: modelName,
            producedAt: manifest.generatedAt,
          });
        } catch (e) {
          logger.warn('Failed to persist file lineage rows (non-fatal)', { error: String(e) });
        }
      } catch (manifestErr) {
        logger.warn('Failed to generate artifact manifest (non-fatal)',
          { error: manifestErr instanceof Error ? manifestErr.message : String(manifestErr) });
      }

      taskCounter.inc({ model: modelName, scenario: scenarioName, status: finalStatus });
      taskDuration.observe({ model: modelName, scenario: scenarioName }, (finishedAt.getTime() - startedAt.getTime()) / 1000);
      taskCounted = true;

      logger.info('Agent loop finished', { taskId: task!.taskId, stopReason: result.stopReason, turns: result.turnsUsed, success });
      // Bookkeeping after a finished loop must never fall through to the task
      // failure path: log and continue instead of nacking a completed session.
      if (!runStopped) {
        try {
          await store.updateSessionStatus(session.id, result.errors.length > 0 ? 'errored' : 'completed');
        } catch (e) {
          logger.warn('Failed to update session status (non-fatal)', { sessionId: session.id, error: String(e) });
        }
      }
      try {
        await queue.ack(task!._redisId ?? task!.taskId);
      } catch (e) {
        logger.warn('Failed to ack finished task; it may be redelivered', { taskId: task!.taskId, error: String(e) });
      }
      if (!runStopped) void maybeFinalizeRun(runId, logger).catch(() => undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Task failed', { taskId: task?.taskId, error: msg });
      if (task) {
        // Capture task in a const so the async .catch closure can reference it
        // without TypeScript narrowing it back to `T | null` across the await
        // boundary (the `if (task)` guard does not propagate into callbacks).
        const failedTask = task;
        // Best-effort state transition to 'failed'. If THIS throws, the run
        // would stay stuck in 'running' forever — log at error level so
        // operators can see the dropped transition (previously this was
        // `.catch(() => {})` which hid the failure entirely).
        // The transition MUST be awaited before maybeFinalizeRun below: on
        // Postgres the pg.Pool spreads queries across connections, so a
        // fire-and-forget UPDATE here could lose the race against the
        // isRunCompleteByRunId SELECT in maybeFinalizeRun running on another
        // connection — the run would still read 'running' and the
        // self-finalize would be skipped with no retry (SQLite's synchronous
        // driver serializes this and cannot reproduce the race).
        const failedRunId = failedTask.config.modelRunId as string ?? failedTask.sessionId;
        try {
          await transitionTaskState(failedRunId, failedTask.model, 'failed', runnerId);
        } catch (err: unknown) {
          const detail = err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) };
          logger.error('transitionTaskState to "failed" failed — run may be stuck in "running" state', { taskId: failedTask.taskId, modelRunId: failedRunId, ...detail });
        }
        // nack requeues below the DLQ threshold — count failed + duration
        // only when the nack dead-letters (terminal).
        if (!taskCounted && isTerminalFailure(failedTask.attempts)) {
          taskCounter.inc({ model: failedTask.model, scenario: failedTask.scenario, status: 'failed' });
          if (taskStartedAt) taskDuration.observe({ model: failedTask.model, scenario: failedTask.scenario }, (Date.now() - taskStartedAt.getTime()) / 1000);
          taskCounted = true;
          // The nack below dead-letters this attempt, so the run's model task
          // just reached a terminal state — finalize the run if all models are
          // done, without waiting for the dashboard watcher. The 'failed'
          // transition above was awaited, so the UPDATE has committed before
          // this SELECT-based completeness check runs.
          void maybeFinalizeRun(failedRunId, logger).catch(() => undefined);
        }
        // nack requeues below the DLQ threshold — count only when it dead-letters.
        if (isTerminalFailure(failedTask.attempts)) tasksFailed.inc();
        await queue.nack(failedTask._redisId ?? failedTask.taskId, msg);
      }
    } finally {
      if (runningTask) activeTasks.dec();
      runningTask = null;
      taskStartedAt = null;
    }
  }

  logger.info('Runner loop exited');
}

// Self-start when invoked directly (container entrypoint)
const isMain = process.argv[1]?.endsWith('runner.js') || process.argv[1]?.endsWith('runner.ts');
if (isMain) {
  startRunner().catch((err) => {
    console.error('Runner crashed', err);
    process.exit(1);
  });
}
