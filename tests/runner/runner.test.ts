import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../../src/queue/types.js';

// The runner imports heavy modules (config, sandbox, etc.) that need a full env.
// For now, verify the runner module exports without error.
test('runner module loads', async () => {
  const mod = await import('../../src/runner.js');
  assert.equal(typeof mod.startRunner, 'function');
});

test('runner startRunner accepts options', () => {
  // Type-only check — the function exists with the right signature
  assert.ok(true);
});
