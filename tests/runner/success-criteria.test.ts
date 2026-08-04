import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScenarioConfigSchema } from '../../src/config.js';
import type { Logger, ToolExecutionContext } from '../../src/types.js';
import { runSuccessCriteria } from '../../src/runner.js';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

function scenarioWithCriteria(criteria: unknown): ReturnType<typeof ScenarioConfigSchema.parse> {
  return ScenarioConfigSchema.parse({
    name: 'success-criteria-test',
    systemPrompt: 'test prompt',
    task: 'test task',
    successCriteria: criteria,
  });
}

function ctx(over: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sandboxDir: '',
    logger: noopLogger,
    shellTimeoutMs: 5000,
    maxShellOutputBytes: 1024 * 1024,
    shellPolicy: 'strict',
    webAccess: false,
    executionProfile: 'read-only-analysis',
    allowedTools: new Set(),
    ...over,
  };
}

function makeSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sc-'));
  fs.writeFileSync(path.join(dir, 'pass.js'), 'console.log("criteria ok");\n');
  fs.writeFileSync(path.join(dir, 'fail.js'), 'process.exit(3);\n');
  fs.writeFileSync(path.join(dir, 'big.js'), 'console.log("x".repeat(20000));\n');
  fs.writeFileSync(path.join(dir, 'slow.js'), 'setTimeout(() => {}, 10000);\n');
  return dir;
}

test('runSuccessCriteria: returns undefined when no successCriteria configured', async () => {
  const scenario = scenarioWithCriteria(undefined);
  const dir = makeSandbox();
  const outcome = await runSuccessCriteria(scenario, dir, ctx({ sandboxDir: dir }));
  assert.equal(outcome, undefined);
});

test('runSuccessCriteria: rejects commands with shell metacharacters', async () => {
  const scenario = scenarioWithCriteria({ command: 'node pass.js && echo doomed' });
  const dir = makeSandbox();
  const outcome = await runSuccessCriteria(scenario, dir, ctx({ sandboxDir: dir }));
  assert.ok(outcome);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.exitCode, -1);
  assert.match(outcome.output, /metacharacters/);
});

test('runSuccessCriteria: passes when exit code matches', async () => {
  const scenario = scenarioWithCriteria({ command: `node pass.js` });
  const dir = makeSandbox();
  const outcome = await runSuccessCriteria(scenario, dir, ctx({ sandboxDir: dir }));
  assert.ok(outcome);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.output, /criteria ok/);
});

test('runSuccessCriteria: honors a non-default expectedExitCode', async () => {
  const scenario = scenarioWithCriteria({ command: `node fail.js`, expectedExitCode: 3 });
  const dir = makeSandbox();
  const outcome = await runSuccessCriteria(scenario, dir, ctx({ sandboxDir: dir }));
  assert.ok(outcome);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.exitCode, 3);
});

test('runSuccessCriteria: fails when exit code mismatches', async () => {
  const scenario = scenarioWithCriteria({ command: `node fail.js`, expectedExitCode: 0 });
  const dir = makeSandbox();
  const outcome = await runSuccessCriteria(scenario, dir, ctx({ sandboxDir: dir }));
  assert.ok(outcome);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.exitCode, 3);
});

test('runSuccessCriteria: output-contains gates the pass verdict', async () => {
  const dir = makeSandbox();
  const hit = await runSuccessCriteria(
    scenarioWithCriteria({ command: `node pass.js`, expectedOutputContains: 'criteria' }),
    dir, ctx({ sandboxDir: dir }),
  );
  assert.ok(hit);
  assert.equal(hit.outputContainsPassed, true);
  assert.equal(hit.passed, true);

  const miss = await runSuccessCriteria(
    scenarioWithCriteria({ command: `node pass.js`, expectedOutputContains: 'not-present' }),
    dir, ctx({ sandboxDir: dir }),
  );
  assert.ok(miss);
  assert.equal(miss.outputContainsPassed, false);
  assert.equal(miss.passed, false);
});

test('runSuccessCriteria: records null exitCode when maxBuffer is exceeded', async () => {
  const scenario = scenarioWithCriteria({ command: `node big.js` });
  const dir = makeSandbox();
  const outcome = await runSuccessCriteria(scenario, dir, ctx({ sandboxDir: dir, maxShellOutputBytes: 256 }));
  assert.ok(outcome);
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.passed, false);
});

test('runSuccessCriteria: records null exitCode when the command times out', async () => {
  const scenario = scenarioWithCriteria({ command: `node slow.js` });
  const dir = makeSandbox();
  const outcome = await runSuccessCriteria(scenario, dir, ctx({ sandboxDir: dir, shellTimeoutMs: 100 }));
  assert.ok(outcome);
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.passed, false);
});
