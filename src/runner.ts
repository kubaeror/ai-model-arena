import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { outputRoot } from './paths.js';
import { initDb } from './db/index.js';
import { createQueue, type TaskQueue, type Task } from './queue/index.js';
import { createSessionStore } from './session/store.js';
import { ProviderRegistry, loadBuiltins } from './providers/index.js';
import { resolveModelForRun } from './db/model-resolver.js';
import { loadScenario, resolveScenarioPath } from './config.js';
import { createLogger } from './logger/pino-logger.js';
import { ConversationLogger } from './logger/conversation-logger.js';
import { Sandbox } from './sandbox/sandbox.js';
import { runAgentLoop } from './agent-loop/loop.js';
import { TOOL_DEFINITIONS, buildToolExecutors } from './tools/index.js';
import { CircuitBreaker, CircuitOpenError } from './providers/circuit-breaker.js';
import { resolveFallback, type FallbackConfig } from './providers/fallback.js';
import { loadBudgetConfig, checkBudget } from './cost-tracking/index.js';
import { isKillSwitchActive, isRunCancelled, clearRunCancelled } from './orchestrator/run-lifecycle.js';
import type { ToolExecutionContext, TokenUsage } from './types.js';
import { closeDb } from './db/index.js';

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

export async function startRunner(opts: RunnerOptions = {}): Promise<void> {
  const queue = opts.queue ?? createQueue();
  const ac = new AbortController();
  const signal = opts.signal ?? ac.signal;
  const logger = createLogger('ai-arena:runner');

  initDb(path.join(outputRoot(), 'arena.db'));

  // Load budget config for enforcement in the runner loop
  loadBudgetConfig(path.join(outputRoot(), '..', 'configs', 'budget.yaml'), logger);

  const store = createSessionStore();
  const registry = new ProviderRegistry();
  loadBuiltins(registry);

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

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
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
  void cleanupInterval; // keep interval alive, never unref

  while (!signal.aborted) {
    if (isKillSwitchActive()) {
      if (!runningTask) {
        logger.info('Kill switch active — stopping dequeue loop');
        break;
      }
      logger.info('Kill switch active — finishing in-flight task before stopping');
    }
    let task: Task | null = null;
    try {
      task = await queue.dequeue(30000);
      if (!task) continue;
      runningTask = task;

      // Check per-run cancellation before starting execution
      const runId = task.config.modelRunId as string ?? task.sessionId;
      if (isRunCancelled(runId)) {
        logger.info('Run cancelled before execution', { runId, taskId: task.taskId });
        clearRunCancelled(runId);
        await queue.ack(task._redisId ?? task.taskId);
        continue;
      }

      logger.info('Task dequeued', { taskId: task.taskId, model: task.model, scenario: task.scenario });

      let session = await store.loadSession(task.sessionId);
      if (!session) {
        session = await store.createSession({ model: task.model });
      }

      const modelRunId = task.config.modelRunId as string ?? task.sessionId;
      const scenarioName = task.scenario;
      const modelName = task.model;

      const scenarioDir = path.join(process.cwd(), 'configs', 'scenarios');
      const scenario = loadScenario(resolveScenarioPath(scenarioDir, scenarioName));

      const runOutputDir = path.join(outputRoot(), modelName, modelRunId);
      const sandboxDir = path.join(runOutputDir, 'files');
      fs.mkdirSync(runOutputDir, { recursive: true });
      fs.mkdirSync(sandboxDir, { recursive: true });

      const conv = new ConversationLogger(path.join(runOutputDir, 'conversation.json'), {
        model: modelName,
        scenario: scenarioName,
        runId: modelRunId,
        startedAt: new Date().toISOString(),
      }, { disableFile: true });

      const toolCtx: ToolExecutionContext = {
        sandboxDir,
        logger: logger.child('tools'),
        shellTimeoutMs: scenario.shellTimeoutMs,
        maxShellOutputBytes: scenario.maxShellOutputBytes,
        shellPolicy: scenario.shellPolicy,
      };

      const sandbox = new Sandbox(sandboxDir);
      sandbox.ensure();
      if (scenario.starterFiles) {
        const templateDir = path.resolve(scenarioDir, scenario.starterFiles);
        sandbox.seedFrom(templateDir);
      }

      const resolved = resolveModelForRun(modelName);
      if (!resolved) {
        logger.error('Model not found', { model: modelName });
        await queue.nack(task.taskId, `Model not found: ${modelName}`);
        continue;
      }

      let currentProvider = resolved.providerId;
      let currentModel = resolved.apiModelId;
      const executors = buildToolExecutors();
      let adapter = registry.createAdapter(currentProvider, currentModel, { logger: logger.child('adapter') });
      let loopResult;
      let maxFallbackHops = 3;

      while (maxFallbackHops >= 0) {
        const breaker = CircuitBreaker.for(currentProvider, currentModel);
        try {
          loopResult = await breaker.exec(() => runAgentLoop({
            adapter,
            tools: TOOL_DEFINITIONS,
            executors,
            systemPrompt: scenario.systemPrompt,
            task: scenario.task,
            maxTurns: (task!.config.maxTurns as number) ?? scenario.maxTurns ?? 20,
            toolCtx,
            conv,
            logger: logger.child('loop'),
            onTurnComplete: async (turn) => {
              await store.appendMessage(session.id, {
                id: crypto.randomUUID(),
                sessionId: session.id,
                turn,
                role: 'assistant',
                content: null,
                toolCalls: null,
                toolCallId: null,
                tokenInput: null,
                tokenOutput: null,
                createdAt: new Date().toISOString(),
              });
            },
            onBudgetCheck: async (_turn: number, _tokenUsage: TokenUsage) => {
              const cancelledRunId = task!.config.modelRunId as string ?? task!.sessionId;
              if (isRunCancelled(cancelledRunId)) {
                logger.info('Run cancelled during execution', { runId: cancelledRunId });
                return false;
              }
              const budgetCheck = checkBudget(modelName, outputRoot(), false, logger);
              if (!budgetCheck.allowed) {
                logger.warn('Budget exceeded during run', { model: modelName, spent: budgetCheck.spentUsd, limit: budgetCheck.limitUsd });
                return false;
              }
              return true;
            },
          }));
          break;
        } catch (err) {
          if (err instanceof CircuitOpenError && opts.fallbackChain) {
            const next = resolveFallback({ provider: currentProvider, model: currentModel }, opts.fallbackChain);
            if (next && maxFallbackHops > 0) {
              logger.warn('Falling back', { from: `${currentProvider}/${currentModel}`, to: `${next.provider}/${next.model}` });
              currentProvider = next.provider;
              currentModel = next.model;
              adapter = registry.createAdapter(currentProvider, currentModel, { logger: logger.child('adapter') });
              maxFallbackHops--;
              continue;
            }
          }
          throw err;
        }
      }

      const result = loopResult!;

      logger.info('Agent loop finished', { taskId: task!.taskId, stopReason: result.stopReason, turns: result.turnsUsed });
      await store.updateSessionStatus(session.id, result.errors.length > 0 ? 'errored' : 'completed');
      await queue.ack(task!._redisId ?? task!.taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Task failed', { taskId: task?.taskId, error: msg });
      if (task) await queue.nack(task._redisId ?? task.taskId, msg);
    } finally {
      runningTask = null;
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
