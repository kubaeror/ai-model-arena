import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import type { ZodType } from 'zod';
import { SchedulesConfigSchema } from '../../src/scheduler/types.js';
import { BudgetConfigSchema } from '../../src/cost-tracking/types.js';
import { EvaluationConfigSchema } from '../../src/evaluation/types.js';
import { RegressionSuiteConfigSchema } from '../../src/evaluation/regression-config.js';
import { ScenarioConfigSchema } from '../../src/config.js';
import { AnomalyDetectionConfigSchema } from '../../src/anomaly-detection/config.js';
import { NotificationConfigSchema } from '../../src/notifications/types.js';
import { ApiKeysConfigSchema } from '../../src/dashboard-server/auth-api-types.js';

const CONFIGS_DIR = path.join(process.cwd(), 'configs');
const SCENARIOS_DIR = path.join(CONFIGS_DIR, 'scenarios');
const REGRESSION_DIR = path.join(CONFIGS_DIR, 'regression');

const TOP_LEVEL_SCHEMAS: Record<string, ZodType> = {
  'schedules.yaml': SchedulesConfigSchema,
  'budget.yaml': BudgetConfigSchema,
  'evaluation.yaml': EvaluationConfigSchema,
  'anomaly-detection.yaml': AnomalyDetectionConfigSchema,
  'notifications.yaml': NotificationConfigSchema,
  'api-keys.yaml': ApiKeysConfigSchema,
};

const KNOWN_MODEL_IDS = new Set(['gpt-4o', 'claude-sonnet-4']);

function listYamlFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listYamlFiles(full);
    return /\.ya?ml$/.test(entry.name) ? [full] : [];
  });
}

function parseYaml(file: string): unknown {
  return load(fs.readFileSync(file, 'utf8'));
}

test('every config yaml parses through its zod schema', () => {
  const files = listYamlFiles(CONFIGS_DIR);
  assert.ok(files.length >= 6, `expected config files, found: ${files.join(', ')}`);
  for (const file of files) {
    const rel = path.relative(CONFIGS_DIR, file);
    let schema: ZodType | undefined;
    if (rel.startsWith('scenarios' + path.sep)) {
      schema = ScenarioConfigSchema;
    } else if (rel.startsWith('regression' + path.sep)) {
      schema = RegressionSuiteConfigSchema;
    } else {
      schema = TOP_LEVEL_SCHEMAS[rel];
    }
    assert.ok(schema, `no schema mapped for config file: ${rel}`);
    assert.doesNotThrow(
      () => schema.safeParse(parseYaml(file)),
      `${rel} must parse through its schema`,
    );
    const parsed = schema.safeParse(parseYaml(file));
    assert.equal(parsed.success, true, `${rel} failed schema validation: ${JSON.stringify(parsed.error?.issues)}`);
  }
});

test('every regression suite scenario exists in configs/scenarios/*.yaml', () => {
  const scenarioNames = new Set<string>();
  for (const file of listYamlFiles(SCENARIOS_DIR)) {
    const parsed = ScenarioConfigSchema.safeParse(parseYaml(file));
    if (parsed.success) scenarioNames.add(parsed.data.name);
  }
  for (const file of listYamlFiles(REGRESSION_DIR)) {
    const parsed = RegressionSuiteConfigSchema.safeParse(parseYaml(file));
    assert.ok(parsed.success, `${path.basename(file)} must parse`);
    for (const scenario of parsed.data.scenarios) {
      assert.ok(
        scenarioNames.has(scenario),
        `regression suite ${path.basename(file)} references scenario "${scenario}" which does not exist in ${SCENARIOS_DIR}`,
      );
    }
  }
});

test('every model referenced in schedules/budget/regression is a known model id', () => {
  const referenced = new Set<string>();
  const collect = (ids: string[]) => {
    for (const id of ids) referenced.add(id);
  };

  const schedules = SchedulesConfigSchema.safeParse(parseYaml(path.join(CONFIGS_DIR, 'schedules.yaml')));
  if (schedules.success) {
    for (const s of schedules.data.schedules) collect(s.models);
  }

  const budget = BudgetConfigSchema.safeParse(parseYaml(path.join(CONFIGS_DIR, 'budget.yaml')));
  if (budget.success) {
    collect(Object.keys(budget.data.models ?? {}));
  }

  for (const file of listYamlFiles(REGRESSION_DIR)) {
    const parsed = RegressionSuiteConfigSchema.safeParse(parseYaml(file));
    if (parsed.success) collect(parsed.data.models);
  }

  assert.ok(referenced.size > 0, 'expected at least one model reference');
  for (const id of referenced) {
    assert.ok(
      KNOWN_MODEL_IDS.has(id),
      `model id "${id}" is not in the known model id list; fix the config or extend the fixture with a genuinely valid id`,
    );
  }
});
