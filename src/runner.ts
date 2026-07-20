import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { outputRoot } from './paths.js';
import { initDb } from './db/client.js';
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
import type { ToolExecutionContext } from './types.js';

export interface RunnerOptions {
  queue?: TaskQueue;
  signal?: AbortSignal;
}

export async function startRunner(opts: RunnerOptions = {}): Promise<void> {
  const queue = opts.queue ?? createQueue();
  const signal = opts.signal ?? new AbortController().signal;
  const logger = createLogger('ai-arena:runner');

  initDb(path.join(outputRoot(), 'arena.db'));

  const store = createSessionStore();
  const registry = new ProviderRegistry();
  loadBuiltins(registry);

  logger.info('Runner starting');

  while (!signal.aborted) {
    let task: Task | null = null;
    try {
      task = await queue.dequeue(30000);
      if (!task) continue;

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
      });

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

      const adapter = registry.createAdapter(
        resolved.providerId,
        resolved.apiModelId,
        { logger: logger.child('adapter') },
      );

      const executors = buildToolExecutors();

      const result = await runAgentLoop({
        adapter,
        tools: TOOL_DEFINITIONS,
        executors,
        systemPrompt: scenario.systemPrompt,
        task: scenario.task,
        maxTurns: (task.config.maxTurns as number) ?? scenario.maxTurns ?? 20,
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
      });

      logger.info('Agent loop finished', { taskId: task.taskId, stopReason: result.stopReason, turns: result.turnsUsed });
      await store.updateSessionStatus(session.id, result.errors.length > 0 ? 'errored' : 'completed');
      await queue.ack(task.taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Task failed', { taskId: task?.taskId, error: msg });
      if (task) await queue.nack(task.taskId, msg);
    }
  }

  logger.info('Runner stopped');
}
