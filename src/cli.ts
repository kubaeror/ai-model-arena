#!/usr/bin/env node
/**
 * ai-model-arena CLI entry point.
 *
 * Commands:
 *   ai-arena run --scenario <name> --models gpt-4o,claude-3.7
 *   ai-arena status
 *   ai-arena logs --model <name> [--lines N]
 *   ai-arena cleanup
 */
import 'dotenv/config';
import { Command } from 'commander';
import { findProjectRoot } from './paths.js';
import { createLogger } from './logger/pino-logger.js';
import {
  runScenarioForModels,
  printStatus,
  tailLogs,
  cleanupArena,
} from './orchestrator/orchestrator.js';

const program = new Command();

program
  .name('ai-arena')
  .description('Automated, multi-model agentic coding arena (PM2-managed sandboxed sessions).')
  .version('0.1.0');

function rootDir(): string {
  return findProjectRoot();
}

// ── run ────────────────────────────────────────────────────────────────────
program
  .command('run')
  .description('Run a scenario against one or more models concurrently (one PM2 worker each).')
  .requiredOption('-s, --scenario <name>', 'Scenario name (configs/scenarios/<name>.yaml) or a .yaml path')
  .requiredOption('-m, --models <list>', 'Comma-separated model names from configs/models.yaml')
  .option('--models-config <path>', 'Path to models.yaml (default: configs/models.yaml)')
  .option('--scenarios-dir <path>', 'Directory containing scenario files (default: configs/scenarios)')
  .option('--timeout <minutes>', 'Overall wait timeout in minutes (default: 30)', (v) => Number(v))
  .action(async (opts) => {
    const logger = createLogger('ai-arena:cli');
    const models = String(opts.models)
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length === 0) {
      console.error('Error: --models requires at least one model name.');
      process.exit(1);
    }

    const root = rootDir();
    const runOpts = {
      scenario: opts.scenario,
      models,
      modelsConfigPath: opts.modelsConfig,
      scenariosDir: opts.scenariosDir,
      timeoutMs: opts.timeout ? opts.timeout * 60 * 1000 : undefined,
      logger,
    };

    logger.info('ai-arena run', { scenario: opts.scenario, models, root });
    try {
      await runScenarioForModels(runOpts);
      logger.info('Run complete. See outputs/ for conversation.json, report.md, and comparison reports.');
    } catch (err) {
      logger.error('Run failed', { error: err instanceof Error ? err.message : String(err) });
      console.error(`\nRun failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── status ──────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show PM2-managed arena sessions and their status.')
  .action(async () => {
    try {
      await printStatus();
    } catch (err) {
      console.error(`status failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── logs ────────────────────────────────────────────────────────────────────
program
  .command('logs')
  .description('Show the latest PM2 log file for a model.')
  .requiredOption('-m, --model <name>', 'Model name whose logs to tail')
  .option('-n, --lines <n>', 'Number of trailing lines to show (default: 200)', (v) => Number(v))
  .action(async (opts) => {
    try {
      await tailLogs(opts.model, opts.lines ?? 200);
    } catch (err) {
      console.error(`logs failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── cleanup ──────────────────────────────────────────────────────────────────
program
  .command('cleanup')
  .description('Delete all ai-arena PM2 processes (running or stopped).')
  .action(async () => {
    try {
      await cleanupArena();
    } catch (err) {
      console.error(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
