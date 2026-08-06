import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadYamlConfig, expandEnvVars, clearConfigCache } from '../src/config-loader.js';

const Schema = z.object({ name: z.string(), retries: z.number().int().default(1) });

test('loadYamlConfig parses + validates', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cl-'));
  const f = path.join(dir, 'c.yaml');
  await fsp.writeFile(f, 'name: hello\n');
  clearConfigCache();
  assert.deepEqual(await loadYamlConfig({ filePath: f, schema: Schema, fallback: { name: 'x', retries: 1 } }), { name: 'hello', retries: 1 });
});

test('loadYamlConfig falls back to default when file missing', async () => {
  clearConfigCache();
  assert.deepEqual(
    await loadYamlConfig({ filePath: '/nonexistent/c.yaml', schema: Schema, fallback: { name: 'fb', retries: 2 } }),
    { name: 'fb', retries: 2 },
  );
});

test('expandEnvVars substitutes $VAR and ${VAR}', () => {
  process.env.CL_TEST_VAR = 'v1';
  assert.equal(expandEnvVars('a=$CL_TEST_VAR b=${CL_TEST_VAR}'), 'a=v1 b=v1');
  delete process.env.CL_TEST_VAR;
});
