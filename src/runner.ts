import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { outputRoot, dbPath, findProjectRoot } from './paths.js';
import { initDb } from './db/index.js';
import { transitionTaskState } from './db/query.js';
import { resumeFrom } from './runner/checkpoint.js';
import { createQueue, type TaskQueue, type Task } from './queue/index.js';
import { createSessionStore } from './session/store.js';
import { ProviderRegistry, loadBuiltins } from './providers/index.js';
import { resolveModelForRun } from './db/model-resolver.js';
import { loadScenario, resolveScenarioPath, type ScenarioConfig } from './config.js';
import { createLogger } from './logger/pino-logger.js';
import { ConversationLogger } from './logger/conversation-logger.js';
import { writeReport } from './logger/report-logger.js';
import { writeResultJson, type RunResult } from './logger/result-logger.js';
import { Sandbox, sandboxEnv } from './sandbox/sandbox.js';
import { SandboxGit, writeDiffPatch } from './sandbox/git.js';
import { SHELL_METACHAR_RE } from './sandbox/shell-policy.js';
import { generateManifest, writeManifest } from './sandbox/artifact-manifest.js';
import { getProfile, getAllowedTools } from './profiles/definitions.js';
import { runAgentLoopTraced } from './observability/instrument-loop.js';
import { TOOL_DEFINITIONS, buildToolExecutors } from './tools/index.js';
import { CircuitBreaker, CircuitOpenError } from './providers/circuit-breaker.js';
import { resolveFallback, resolveMaxFallbackHops, type FallbackConfig } from './providers/fallback.js';
import { loadBudgetConfig, checkBudget, computeCost } from './cost-tracking/index.js';
import { isKillSwitchActive, isRunCancelled, clearRunCancelled } from './orchestrator/run-lifecycle.js';
import { activeTasks, taskCounter, taskDuration, startMetricsServer } from './observability/metrics.js';
import type { ToolExecutionContext, TokenUsage, ChatMessage } from './types.js';
import type { StoredMessage } from './session/store.js';
import { closeDb } from './db/index.js';
import { secretStore } from './secrets/store.js';

export interface RunnerOptions {
  queue?: TaskQueue;
  signal?: AbortSignal;
  fallbackChain?: FallbackConfig;
}

const READINESS_FILE = '/tmp/runner-ready';

function markReady(): void {
  try {
    const dir = path.dirname(READINESS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(READINESS_FILE, Date.now().toString());
  } catch { /* non-fatal — probe will retry */ }
}

function unmarkReady(): void {
  try { fs.unlinkSync(READINESS_FILE); } catch { /* ignore */ }
}

export interface SuccessOutcome {
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

export async function startRunner(opts: RunnerOptions = {}): Promise<void> {
  const queue = opts.queue ?? createQueue();
  const ac = new AbortController();
  const signal = opts.signal ?? ac.signal;
  const logger = createLogger('ai-arena:runner');
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
    if (isKillSwitchActive()) {
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

      // Check per-run cancellation before starting execution
      const runId = task.config.modelRunId as string ?? task.sessionId;
      if (isRunCancelled(runId)) {
        logger.info('Run cancelled before execution', { runId, taskId: task.taskId });
        clearRunCancelled(runId);
        await queue.ack(task._redisId ?? task.taskId);
        continue;
      }

      logger.info('Task dequeued', { taskId: task.taskId, model: task.model, scenario: task.scenario });

      // Transition task to 'claimed' state (persisted in DB)
      transitionTaskState(runId, task.model, 'claimed', runnerId).catch(e =>
        logger.warn('Failed to write claimed state', { error: String(e) }),
      );

      let session = await store.loadSession(task.sessionId);
      let resumedMessages: ChatMessage[] | undefined;
      if (!session) {
        session = await store.createSession({ model: task.model });
        // Nothing to resume — nothing persisted yet.
      } else {
        const resumed = await resumeFrom(session.id);
        if (resumed.messages.length > 0) {
          resumedMessages = resumed.messages;
          logger.info('Resuming session from checkpoint', { sessionId: session.id, turns: resumed.lastCompletedTurn + 1, messages: resumed.messages.length });
        }
      }

      const modelRunId = task.config.modelRunId as string ?? task.sessionId;
      const scenarioName = task.scenario;
      const modelName = task.model;

      const scenarioDir = path.join(process.cwd(), 'configs', 'scenarios');
      const scenario = loadScenario(resolveScenarioPath(scenarioDir, scenarioName));

      // Fresh sessions persist the initial system+task as turn 0 so a later
      // resume can replay the full context.
      if (!resumedMessages) {
        const t0 = new Date().toISOString();
        const turnZero: StoredMessage[] = [
          { id: crypto.randomUUID(), sessionId: session.id, turn: 0, role: 'system', content: scenario.systemPrompt, toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: t0 },
          { id: crypto.randomUUID(), sessionId: session.id, turn: 0, role: 'user', content: scenario.task, toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: t0 },
        ];
        for (const m of turnZero) await store.appendMessage(session.id, m);
      }

      const runOutputDir = path.join(outputRoot(), modelName, modelRunId);
      const sandboxDir = path.join(runOutputDir, 'files');
      fs.mkdirSync(runOutputDir, { recursive: true });
      fs.mkdirSync(sandboxDir, { recursive: true });

      const startedAt = new Date();

      // Ported from worker.ts: conversation.json is written so report.md can
      // be generated from it at the end of the run.
      const conv = new ConversationLogger(path.join(runOutputDir, 'conversation.json'), {
        model: modelName,
        scenario: scenarioName,
        runId: modelRunId,
        startedAt: startedAt.toISOString(),
      });

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
        const templateDir = path.resolve(scenarioDir, scenario.starterFiles);
        sandbox.seedFrom(templateDir);
      }

      // Ported from worker.ts: init git after seeding so the final diff.patch
      // captures only agent-made changes relative to the starter state.
      const sandboxGit = new SandboxGit({ sandboxDir, modelName, logger });
      await sandboxGit.init();

      const resolved = await resolveModelForRun(modelName);
      if (!resolved) {
        logger.error('Model not found', { model: modelName });
        taskCounter.inc({ model: modelName, scenario: scenarioName, status: 'failed' });
        taskDuration.observe({ model: modelName, scenario: scenarioName }, (Date.now() - startedAt.getTime()) / 1000);
        taskCounted = true;
        await queue.nack(task!._redisId ?? task!.taskId, `Model not found: ${modelName}`);
        continue;
      }

      // Ported from worker.ts: fail fast on a missing API key instead of
      // letting the adapter surface a confusing auth error mid-loop.
      if (resolved.envVar && !secretStore.get(resolved.envVar)) {
        const msg = `Missing API key: set ${resolved.envVar} in your .env`;
        logger.error(msg, { model: modelName });
        writeResultJson(path.join(runOutputDir, 'result.json'), {
          model: modelName, scenario: scenarioName, runId: modelRunId,
          startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
          durationMs: 0, turnsUsed: 0, maxTurns: 0, totalToolCalls: 0, toolsCalled: [],
          tokenUsage: {}, stopReason: 'setup_error', errors: [msg], success: false,
        });
        transitionTaskState(runId, task.model, 'failed', runnerId).catch(e =>
          logger.warn('Failed to write failed state', { error: String(e) }),
        );
        taskCounter.inc({ model: modelName, scenario: scenarioName, status: 'failed' });
        taskDuration.observe({ model: modelName, scenario: scenarioName }, (Date.now() - startedAt.getTime()) / 1000);
        taskCounted = true;
        await queue.ack(task!._redisId ?? task!.taskId);
        continue;
      }

      let currentProvider = resolved.providerId;
      let currentModel = resolved.apiModelId;
      const descriptor = registry.get(currentProvider);
      const apiKey = descriptor?.envVar ? secretStore.get(descriptor.envVar) : undefined;
      const executors = buildToolExecutors();
      let adapter = registry.createAdapter(currentProvider, currentModel, { apiKey, logger: logger.child('adapter') });

      // Wire subagent support: strip recursive tools
      const subagentToolNames = new Set(['task', 'todo_read', 'todo_write']);
      const subagentTools = TOOL_DEFINITIONS.filter(t => !subagentToolNames.has(t.name));
      const subagentExecutors: typeof executors = {};
      for (const [name, fn] of Object.entries(executors)) {
        if (!subagentToolNames.has(name)) subagentExecutors[name] = fn;
      }
      toolCtx.subagent = {
        maxTurns: 5,
        sendMessage: (msgs, tools) => adapter.sendMessage(msgs, tools),
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
      // Cumulative spend of this run's tokens, so per-turn budget checks see
      // the current run (addSpend is only called during finalize otherwise).
      let prevRunCost = 0;

      // Transition to 'running'
      transitionTaskState(runId, task.model, 'running', runnerId).catch(e =>
        logger.warn('Failed to write running state', { error: String(e) }),
      );

      while (maxFallbackHops >= 0) {
        const breaker = CircuitBreaker.for(currentProvider, currentModel);
        try {
          const traced = await breaker.exec(() => runAgentLoopTraced({
            adapter,
            tools: TOOL_DEFINITIONS,
            executors,
            systemPrompt: scenario.systemPrompt,
            task: scenario.task,
            maxTurns: Math.min(
              (task!.config.maxTurns as number) ?? scenario.maxTurns ?? profile.maxTurns,
              profile.maxTurns,
            ),
            toolCtx,
            conv,
            logger: logger.child('loop'),
            initialMessages: resumedMessages,
            provider: currentProvider,
            model: currentModel,
            temperature: 0,
            maxTokens: 0,
            scenario: scenarioName,
            runId: modelRunId,
            modelConfig: modelName,
            outputDir: runOutputDir,
            onTurnComplete: async (turn, newMessages, usage) => {
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
              // Track this run's spend so the per-turn budget check below can
              // trip on it (spend only reaches the ledger at finalize time).
              try {
                const cumulative = await computeCost(modelName, {
                  prompt: usage.prompt ?? 0,
                  completion: usage.completion ?? 0,
                  cached: usage.cacheReadTokens ?? 0,
                });
                prevRunCost = Math.max(prevRunCost, cumulative.total);
              } catch (e) {
                logger.warn('Failed to compute run spend (non-fatal)', { model: modelName, err: String(e) });
              }
            },
            onBudgetCheck: async (_turn: number, _tokenUsage: TokenUsage) => {
              const cancelledRunId = task!.config.modelRunId as string ?? task!.sessionId;
              if (isRunCancelled(cancelledRunId)) {
                logger.info('Run cancelled during execution', { runId: cancelledRunId });
                return false;
              }
              const budgetCheck = checkBudget(modelName, root, false, logger, prevRunCost);
              if (!budgetCheck.allowed) {
                logger.warn('Budget exceeded during run', { model: modelName, spent: budgetCheck.spentUsd, limit: budgetCheck.limitUsd });
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

      const costBreakdown = await computeCost(modelName, {
        prompt: result.tokenUsage.prompt ?? 0,
        completion: result.tokenUsage.completion ?? 0,
        cached: result.tokenUsage.cacheReadTokens ?? 0,
      });

      await sandboxGit.commitFinal(success ? 'Task completed successfully' : 'Task failed or incomplete');
      const diff = await sandboxGit.generateDiff();
      if (diff) await writeDiffPatch(runOutputDir, diff, logger);

      const finishedAt = new Date();
      const runResult: RunResult = {
        model: modelName, scenario: scenarioName, runId: modelRunId,
        startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
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

      // run_models.status reflects loop health, not the success-criteria result:
      // a clean loop whose criteria failed stays 'completed' (criteria is
      // recorded in result.json). Loop errors still map to 'failed'.
      const finalStatus = result.errors.length > 0 ? 'failed' : 'completed';
      transitionTaskState(runId, task.model, finalStatus, runnerId).catch(e =>
        logger.warn('Failed to write final state', { error: String(e) }),
      );
      try {
        const manifest = generateManifest(sandboxDir, modelRunId, modelName);
        writeManifest(manifest, runOutputDir, logger);
        // Persist per-file rows so the dashboard Files page has lineage data.
        // Replaced per runId so restarts do not duplicate rows.
        try {
          const { insertFile } = await import('./db/query.js');
          const { files } = await import('./db/schema.js');
          const { getDrizzleDb } = await import('./db/index.js');
          const { eq } = await import('drizzle-orm');
          const db = getDrizzleDb();
          await db.delete(files).where(eq(files.run_id, modelRunId));
          for (const entry of manifest.entries) {
            await insertFile({
              id: crypto.randomUUID(),
              runId: modelRunId,
              path: entry.path,
              model: modelName,
              producedAt: manifest.generatedAt,
              producedByTool: entry.producedByTool ?? null,
            });
          }
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
      await store.updateSessionStatus(session.id, result.errors.length > 0 ? 'errored' : 'completed');
      await queue.ack(task!._redisId ?? task!.taskId);
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
        transitionTaskState(failedTask.config.modelRunId as string ?? failedTask.sessionId, failedTask.model, 'failed', runnerId).catch((err: unknown) => {
          const detail = err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) };
          logger.error('transitionTaskState to "failed" failed — run may be stuck in "running" state', { taskId: failedTask.taskId, modelRunId: failedTask.config.modelRunId ?? failedTask.sessionId, ...detail });
        });
        if (!taskCounted) {
          taskCounter.inc({ model: failedTask.model, scenario: failedTask.scenario, status: 'failed' });
          if (taskStartedAt) taskDuration.observe({ model: failedTask.model, scenario: failedTask.scenario }, (Date.now() - taskStartedAt.getTime()) / 1000);
        }
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
