#!/usr/bin/env node
/**
 * ai-model-arena CLI entry point.
 *
 * Commands:
 *   ai-arena run --scenario <name> --models gpt-4o,claude-3.7
 *   ai-arena status
 *   ai-arena logs --model <name> [--lines N]
 *   ai-arena cleanup
 *   ai-arena regress --suite <name>
 *   ai-arena schedule create/list/remove
 *   ai-arena export --format csv --output <path>
 *   ai-arena diff <runId>
 *   ai-arena budget status
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { Command } from 'commander';
import { findProjectRoot, dbPath } from './paths.js';
import { createLogger } from './logger/pino-logger.js';
import { initDb } from './db/index.js';
import { listRuns, getRunRecord } from './orchestrator/run-index.js';
import {
  runScenarioForModels,
  printStatus,
  tailLogs,
  cleanupArena,
} from './orchestrator/orchestrator.js';
import { loadSchedulesConfig, getSchedules, addSchedule, removeSchedule } from './scheduler/manager.js';
import { getBudgetStatus } from './cost-tracking/index.js';
import { readDiffPatch } from './sandbox/git.js';
import type { Schedule } from './scheduler/types.js';

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
  .description('Cancel all in-flight arena tasks.')
  .action(async () => {
    try {
      await cleanupArena();
    } catch (err) {
      console.error(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── regress ──────────────────────────────────────────────────────────────────
program
  .command('regress')
  .description('Run a regression suite comparing against stored baselines.')
  .requiredOption('-s, --suite <name>', 'Suite name (configs/regression/<name>.yaml)')
  .option('-m, --model <name>', 'Run for a specific model only')
  .option('--update-baseline', 'Update baselines after run', false)
  .action(async (opts: { suite: string; model?: string; updateBaseline: boolean }) => {
    const { suite, model: filterModel, updateBaseline } = opts;
    const root = rootDir();
    const configPath = path.join(root, 'configs', 'regression', `${suite}.yaml`);
    if (!fs.existsSync(configPath)) {
      process.stderr.write(`\nError: Regression suite config not found: ${configPath}\n`);
      process.exit(1);
    }
    const { RegressionSuiteConfigSchema } = await import('./evaluation/regression-config.js');
    const raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
    const config = RegressionSuiteConfigSchema.parse(raw);
    const models = filterModel ? config.models.filter((m) => m === filterModel) : config.models;
    if (models.length === 0) {
      process.stderr.write(`\nError: No matching models (filter: ${filterModel ?? 'none'})\n`);
      process.exit(1);
    }

    const baselineDir = path.resolve(root, config.baselineDir);
    const logger = createLogger('ai-arena:regress');
    initDb(dbPath());

    const { runRegressionSuite, createBaselineSnapshot, saveBaselineSnapshot, getBaselinePath } =
      await import('./evaluation/regression.js');
    const { readJudgeResult } = await import('./evaluation/judge.js');
    void readJudgeResult; // used in getCurrentRunResult below

    const result = await runRegressionSuite(
      suite,
      models,
      config.scenarios,
      baselineDir,
      config.thresholds,
      async (mdl, scenario) => {
        const runs = listRuns().filter(
          (r) => r.scenario === scenario && r.models.includes(mdl) && r.status === 'completed',
        );
        if (runs.length === 0) return null;
        const rec = runs[0]!;
        const perModel = rec.perModel.find((m) => m.model === mdl);
        if (!perModel) return null;
        try {
          return JSON.parse(fs.readFileSync(perModel.resultPath, 'utf8'));
        } catch {
          return null;
        }
      },
      logger,
    );

    if (updateBaseline) {
      for (const sr of result.scenarioResults) {
        if (sr.success && sr.current) {
          const snap = createBaselineSnapshot(sr.current, sr.judge ?? null);
          const bPath = getBaselinePath(baselineDir, sr.current.model, sr.scenario);
          saveBaselineSnapshot(bPath, snap, logger);
        }
      }
      console.log('\nBaselines updated.');
    }

    const passed = result.passed;
    const failedCount = result.scenarioResults.filter(
      (sr) => sr.regression && !sr.regression.passed,
    ).length;
    console.log(`\nRegression suite: ${suite}`);
    console.log(`Status: ${passed ? 'PASSED' : `FAILED -- ${failedCount} regression(s)`}`);
    for (const sr of result.scenarioResults) {
      const icon = sr.regression?.passed === false ? 'FAIL' : 'PASS';
      console.log(`  [${icon}] ${sr.scenario}`);
      for (const reg of sr.regression?.regressions ?? []) {
        console.log(`    ${reg.metric}: ${reg.baseline} -> ${reg.current} (delta ${reg.change.toFixed(2)}, threshold ${reg.threshold})`);
      }
    }
    process.exit(passed ? 0 : 1);
  });

// ── schedule ──────────────────────────────────────────────────────────────────
const scheduleCmd = program
  .command('schedule')
  .description('Manage scheduled runs.');

scheduleCmd
  .command('list')
  .description('List all scheduled jobs.')
  .action(() => {
    const root = rootDir();
    const configPath = path.join(root, 'configs', 'schedules.yaml');
    loadSchedulesConfig(configPath);
    const schedules = getSchedules();
    console.log('\nScheduled Jobs:\n');
    if (schedules.length === 0) {
      console.log('  No scheduled jobs found.');
    } else {
      for (const s of schedules) {
        const status = s.enabled ? 'enabled' : 'disabled';
        console.log(`  [${s.id}] ${s.scenario} -> ${s.models.join(', ')} (${status})`);
        console.log(`      cron: ${s.cron}\n`);
      }
    }
  });

scheduleCmd
  .command('create')
  .description('Create a new scheduled job.')
  .requiredOption('-s, --scenario <name>', 'Scenario name')
  .requiredOption('-m, --models <list>', 'Comma-separated model names')
  .requiredOption('-c, --cron <expr>', 'Cron expression')
  .option('--id <id>', 'Schedule ID (auto-generated if not provided)')
  .option('--disabled', 'Create as disabled', false)
  .action((opts) => {
    const root = rootDir();
    const configPath = path.join(root, 'configs', 'schedules.yaml');
    const models = String(opts.models).split(',').map((m: string) => m.trim()).filter(Boolean);
    const id = opts.id || `schedule-${Date.now()}`;
    
    const schedule: Schedule = {
      id,
      scenario: opts.scenario,
      models,
      cron: opts.cron,
      enabled: !opts.disabled,
    };
    
    try {
      addSchedule(configPath, schedule);
      console.log(`\nSchedule created: ${id}`);
      console.log(`  Scenario: ${opts.scenario}`);
      console.log(`  Models: ${models.join(', ')}`);
      console.log(`  Cron: ${opts.cron}\n`);
    } catch (err) {
      console.error(`Failed to create schedule: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

scheduleCmd
  .command('remove')
  .description('Remove a scheduled job.')
  .requiredOption('-i, --id <id>', 'Schedule ID')
  .action((opts) => {
    const root = rootDir();
    const configPath = path.join(root, 'configs', 'schedules.yaml');
    if (removeSchedule(configPath, opts.id)) {
      console.log(`\nSchedule removed: ${opts.id}\n`);
    } else {
      console.error(`Schedule not found: ${opts.id}`);
      process.exit(1);
    }
  });

// ── export ─────────────────────────────────────────────────────────────────────
program
  .command('export')
  .description('Export run history to CSV.')
  .option('-f, --format <format>', 'Output format (csv)', 'csv')
  .requiredOption('-o, --output <path>', 'Output file path')
  .option('-m, --model <name>', 'Filter by model')
  .option('--scenario <name>', 'Filter by scenario')
  .option('--from <date>', 'From date (ISO format)')
  .option('--to <date>', 'To date (ISO format)')
  .action((opts) => {
    const runs = listRuns();
    
    let filtered = runs;
    if (opts.model) filtered = filtered.filter(r => r.models.includes(opts.model));
    if (opts.scenario) filtered = filtered.filter(r => r.scenario === opts.scenario);
    if (opts.from) {
      const from = new Date(opts.from);
      filtered = filtered.filter(r => new Date(r.startedAt) >= from);
    }
    if (opts.to) {
      const to = new Date(opts.to);
      filtered = filtered.filter(r => new Date(r.startedAt) <= to);
    }
    
    const rows = [
      'run_id,model,scenario,started_at,duration_seconds,turns_used,success,total_tokens,estimated_cost_usd'
    ];
    
    for (const run of filtered) {
      for (const pm of run.perModel) {
        let result = null;
        try {
          if (pm.resultPath && fs.existsSync(pm.resultPath)) {
            result = JSON.parse(fs.readFileSync(pm.resultPath, 'utf8'));
          }
        } catch {}
        
        const tu = result?.tokenUsage ?? {};
        const totalTokens = (tu.prompt ?? 0) + (tu.completion ?? 0);
        
        rows.push([
          run.runId,
          pm.model,
          run.scenario,
          run.startedAt,
          Math.round((result?.durationMs ?? 0) / 1000),
          result?.turnsUsed ?? 0,
          result?.success ?? false,
          totalTokens,
          (result?.costUsd ?? 0).toFixed(4),
        ].join(','));
      }
    }
    
    fs.writeFileSync(opts.output, rows.join('\n'));
    console.log(`\nExported ${filtered.length} runs to ${opts.output}\n`);
  });

// ── diff ──────────────────────────────────────────────────────────────────────
program
  .command('diff')
  .description('Print the diff for a specific run.')
  .argument('<runId>', 'Run ID')
  .option('-m, --model <name>', 'Model name (required if run has multiple models)')
  .action(async (runId: string, opts: { model?: string }) => {
    const run = getRunRecord(runId);
    if (!run) {
      console.error(`Run not found: ${runId}`);
      process.exit(1);
    }
    
    let model = opts.model;
    if (!model && run.perModel.length === 1) {
      model = run.perModel[0]!.model;
    }
    if (!model) {
      console.error('Model name required. Available models:', run.models.join(', '));
      process.exit(1);
    }
    
    const entry = run.perModel.find(m => m.model === model);
    if (!entry) {
      console.error(`Model not found in run: ${model}`);
      process.exit(1);
    }
    
    const diff = await readDiffPatch(entry.outputDir);
    if (!diff) {
      console.log('\nNo diff available for this run (diff.patch not found).\n');
    } else {
      console.log('\n' + diff + '\n');
    }
  });

// ── budget ────────────────────────────────────────────────────────────────────
program
  .command('budget')
  .description('Show budget status.')
  .action(() => {
    const root = rootDir();
    const status = getBudgetStatus(root);
    console.log('\nBudget Status:\n');
    console.log(`  Global:`);
    console.log(`    Daily:   $${status.global.daily.spent.toFixed(2)} / ${status.global.daily.limit ?? 'unlimited'}`);
    console.log(`    Monthly: $${status.global.monthly.spent.toFixed(2)} / ${status.global.monthly.limit ?? 'unlimited'}\n`);
    
    if (Object.keys(status.models).length > 0) {
      console.log('  Per Model:');
      for (const [model, s] of Object.entries(status.models)) {
        console.log(`    ${model}:`);
        console.log(`      Daily:   $${s.daily.spent.toFixed(2)} / ${s.daily.limit ?? 'unlimited'}`);
        console.log(`      Monthly: $${s.monthly.spent.toFixed(2)} / ${s.monthly.limit ?? 'unlimited'}`);
      }
    }
    console.log('');
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
