#!/usr/bin/env node
/**
 * ai-model-arena worker process.
 *
 * Spawned (one per model) by the orchestrator via the PM2 programmatic API.
 * Each worker:
 *   1. Loads its model + scenario config.
 *   2. Creates a timestamped output folder + sandbox workspace (seeded from the
 *      scenario template if present).
 *   3. Runs the agentic loop with sandboxed tools.
 *   4. Validates the scenario success criteria (optional shell command).
 *   5. Writes conversation.json, report.md, result.json, and the final sandbox
 *      state (the `files/` dir IS the final state).
 *   6. Exits with code 0 so PM2 marks it "stopped" (not "errored"), even when the
 *      task itself failed — failures are recorded in result.json.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  loadModelsConfig,
  loadScenario,
  findModel,
  resolveScenarioPath,
} from './config.js';
import type { ModelConfig, ScenarioConfig } from './config.js';
import { createLogger } from './logger/pino-logger.js';
import { ConversationLogger } from './logger/conversation-logger.js';
import { writeReport } from './logger/report-logger.js';
import { writeResultJson, type RunResult } from './logger/result-logger.js';
import { Sandbox } from './sandbox/sandbox.js';
import { SandboxGit, writeDiffPatch } from './sandbox/git.js';
import { TOOL_DEFINITIONS, buildToolExecutors } from './tools/index.js';
import { createAdapter } from './adapters/index.js';
import { runAgentLoop } from './agent-loop/index.js';
import { findProjectRoot } from './paths.js';
import type { ToolExecutionContext } from './types.js';
import { loadPricingConfig, computeCost } from './cost-tracking/index.js';

const execAsync = promisify(exec);

function rootDir(): string {
  if (process.env.AI_ARENA_ROOT) return process.env.AI_ARENA_ROOT;
  return findProjectRoot();
}

function scenarioDir(root: string): string {
  return process.env.AI_ARENA_SCENARIOS_DIR ?? path.join(root, 'configs', 'scenarios');
}

function modelsConfigPath(root: string): string {
  return process.env.AI_ARENA_MODELS_CONFIG ?? path.join(root, 'configs', 'models.yaml');
}

interface SuccessOutcome {
  command?: string;
  expectedExitCode: number;
  exitCode: number | null;
  output: string;
  outputContainsPassed?: boolean;
  passed: boolean;
}

async function runSuccessCriteria(
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

  try {
    const { stdout } = await execAsync(sc.command, {
      cwd: sandboxDir,
      timeout: ctx.shellTimeoutMs,
      maxBuffer: ctx.maxShellOutputBytes,
      env: process.env,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
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

async function main(): Promise<void> {
  const root = rootDir();
  const logger = createLogger('ai-arena:worker', process.env.LOG_LEVEL);

  const modelName = process.env.AI_ARENA_MODEL;
  const scenarioName = process.env.AI_ARENA_SCENARIO;
  const runId = process.env.AI_ARENA_RUN_ID;

  if (!modelName || !scenarioName || !runId) {
    logger.error('Missing required env vars', { AI_ARENA_MODEL: modelName, AI_ARENA_SCENARIO: scenarioName, AI_ARENA_RUN_ID: runId });
    throw new Error('AI_ARENA_MODEL, AI_ARENA_SCENARIO, and AI_ARENA_RUN_ID must be set.');
  }

  logger.info('Worker starting', { model: modelName, scenario: scenarioName, runId });

  // ── Load configs ───────────────────────────────────────────────────────
  const models = loadModelsConfig(modelsConfigPath(root));
  const modelCfg: ModelConfig = findModel(models.models, modelName);
  const scenario = loadScenario(resolveScenarioPath(scenarioDir(root), scenarioName));

  // ── Output + sandbox dirs ─────────────────────────────────────────────
  const outputDir = path.join(root, 'outputs', modelName, runId);
  const sandboxDir = path.join(outputDir, 'files');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(sandboxDir, { recursive: true });

  // ── Load pricing config for cost tracking ───────────────────────────────────
  loadPricingConfig(path.join(root, 'configs', 'pricing.yaml'), logger);

  // ── Git integration ───────────────────────────────────────────────────────
  const sandboxGit = new SandboxGit({ sandboxDir, modelName, logger });
  
  const startedAt = new Date();
  const conv = new ConversationLogger(path.join(outputDir, 'conversation.json'), {
    model: modelName,
    scenario: scenarioName,
    runId,
    startedAt: startedAt.toISOString(),
  });

  const toolCtx: ToolExecutionContext = {
    sandboxDir,
    logger: logger.child('tools'),
    shellTimeoutMs: scenario.shellTimeoutMs,
    maxShellOutputBytes: scenario.maxShellOutputBytes,
  };

  const sandbox = new Sandbox(sandboxDir);
  sandbox.ensure();
  if (scenario.starterFiles) {
    const templateDir = path.resolve(scenarioDir(root), scenario.starterFiles);
    logger.info('Seeding sandbox from template', { templateDir });
    sandbox.seedFrom(templateDir);
  }

  // Initialize git after seeding starter files
  await sandboxGit.init();

  const resultBase = {
    model: modelName,
    scenario: scenarioName,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: '',
    durationMs: 0,
  };

  // Write a result.json for an early failure and return (exit 0).
  const fail = (errors: string[], extra?: Partial<RunResult>): RunResult => {
    const finishedAt = new Date();
    const r: RunResult = {
      ...resultBase,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      turnsUsed: 0,
      maxTurns: scenario.maxTurns ?? modelCfg.maxTurns,
      totalToolCalls: 0,
      toolsCalled: [],
      tokenUsage: {},
      stopReason: 'setup_error',
      errors,
      success: false,
      ...extra,
    };
    writeResultJson(path.join(outputDir, 'result.json'), r);
    conv.setEnded(finishedAt.toISOString());
    try {
      const convFile = JSON.parse(fs.readFileSync(path.join(outputDir, 'conversation.json'), 'utf8'));
      writeReport(path.join(outputDir, 'report.md'), r, convFile);
    } catch {
      /* best-effort */
    }
    return r;
  };

  // ── Validate API key ──────────────────────────────────────────────────
  if (modelCfg.apiKeyEnv && !process.env[modelCfg.apiKeyEnv]) {
    const msg = `Missing API key: set ${modelCfg.apiKeyEnv} in your .env`;
    logger.error(msg);
    conv.append({ type: 'error', content: msg });
    fail([msg]);
    return;
  }

  // ── Run the agentic loop ───────────────────────────────────────────────
  const adapter = createAdapter(modelCfg, logger.child('adapter'));
  const executors = buildToolExecutors();
  const maxTurns = scenario.maxTurns ?? modelCfg.maxTurns;

  let loopResult;
  try {
    loopResult = await runAgentLoop({
      adapter,
      tools: TOOL_DEFINITIONS,
      executors,
      systemPrompt: scenario.systemPrompt,
      task: scenario.task,
      maxTurns,
      toolCtx,
      conv,
      logger,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Agent loop crashed', { error: msg });
    conv.append({ type: 'error', content: `Agent loop crashed: ${msg}` });
    fail([`Agent loop crashed: ${msg}`]);
    return;
  }

  // ── Validate success criteria ─────────────────────────────────────────
  let success = false;
  let successOutcome: SuccessOutcome | undefined;
  try {
    successOutcome = await runSuccessCriteria(scenario, sandboxDir, toolCtx);
    success = successOutcome ? successOutcome.passed : loopResult.stopReason === 'task_complete';
  } catch (err) {
    logger.warn('Success criteria evaluation failed', { error: err instanceof Error ? err.message : String(err) });
  }

  const finishedAt = new Date();
  
  // ── Compute cost ─────────────────────────────────────────────────────────
  const costBreakdown = computeCost(modelName, {
    prompt: loopResult.tokenUsage.prompt ?? 0,
    completion: loopResult.tokenUsage.completion ?? 0,
    cached: loopResult.tokenUsage.total ?? 0,
  });
  
  // ── Finalize git repo ─────────────────────────────────────────────────────
  const finalCommitSummary = success ? 'Task completed successfully' : 'Task failed or incomplete';
  await sandboxGit.commitFinal(finalCommitSummary);
  const diff = await sandboxGit.generateDiff();
  if (diff) {
    await writeDiffPatch(outputDir, diff, logger);
  }
  
  const result: RunResult = {
    ...resultBase,
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    turnsUsed: loopResult.turnsUsed,
    maxTurns: loopResult.maxTurns,
    totalToolCalls: loopResult.totalToolCalls,
    toolsCalled: loopResult.toolsCalled,
    tokenUsage: loopResult.tokenUsage,
    stopReason: loopResult.stopReason,
    errors: loopResult.errors,
    success,
    costUsd: costBreakdown.total,
    successCriteria: successOutcome
      ? {
          command: successOutcome.command,
          expectedExitCode: successOutcome.expectedExitCode,
          exitCode: successOutcome.exitCode,
          output: successOutcome.output,
          outputContainsPassed: successOutcome.outputContainsPassed,
          passed: successOutcome.passed,
        }
      : undefined,
  };

  // ── Write final artifacts ─────────────────────────────────────────────
  writeResultJson(path.join(outputDir, 'result.json'), result);
  conv.setEnded(finishedAt.toISOString());
  try {
    const convFile = JSON.parse(fs.readFileSync(path.join(outputDir, 'conversation.json'), 'utf8'));
    writeReport(path.join(outputDir, 'report.md'), result, convFile);
  } catch (err) {
    logger.warn('Failed to write report.md', { error: err instanceof Error ? err.message : String(err) });
  }

  logger.info('Worker finished', {
    model: modelName, scenario: scenarioName, runId, success,
    stopReason: result.stopReason, turnsUsed: result.turnsUsed,
    totalToolCalls: result.totalToolCalls, durationMs: result.durationMs,
  });
}

// Top-level: write a result.json even on catastrophic failure, then exit 0
// so PM2 records "stopped" (not "errored"). Real failures are in result.json.
main()
  .catch((err) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[worker] fatal: ${msg}`);
    try {
      const root = rootDir();
      const modelName = process.env.AI_ARENA_MODEL ?? 'unknown';
      const runId = process.env.AI_ARENA_RUN_ID ?? `crash_${Date.now()}`;
      const outputDir = path.join(root, 'outputs', modelName, runId);
      fs.mkdirSync(outputDir, { recursive: true });
      const finishedAt = new Date();
      writeResultJson(path.join(outputDir, 'result.json'), {
        model: modelName,
        scenario: process.env.AI_ARENA_SCENARIO ?? 'unknown',
        runId,
        startedAt: finishedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: 0,
        turnsUsed: 0,
        maxTurns: 0,
        totalToolCalls: 0,
        toolsCalled: [],
        tokenUsage: {},
        stopReason: 'fatal_error',
        errors: [msg],
        success: false,
      });
    } catch {
      /* nothing more we can do */
    }
  })
  .finally(() => {
    // Always exit 0: the orchestrator reads result.json to judge success, and a
    // 0 exit keeps PM2 status "stopped" rather than triggering restarts/errored.
    process.exit(0);
  });
