import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { BUILTIN_PROVIDERS } from '../../src/providers/index.js';
import { BLOCKED_ENV_PREFIXES, sandboxEnv } from '../../src/sandbox/sandbox.js';

const ENV_VARS = [...new Set(
  BUILTIN_PROVIDERS
    .map((d) => d.envVar)
    .filter((v): v is string => typeof v === 'string' && v.length > 0),
)].sort();

describe('sandbox env blocklist covers provider descriptors', () => {
  for (const envVar of ENV_VARS) {
    it(`covers ${envVar}`, () => {
      const covered = BLOCKED_ENV_PREFIXES.some(
        (prefix) => envVar.toLowerCase().startsWith(prefix.toLowerCase()),
      );
      assert.ok(
        covered,
        `No BLOCKED_ENV_PREFIXES entry covers ${envVar} (blocklist: ${BLOCKED_ENV_PREFIXES.join(', ')})`,
      );
    });
  }

  it('strips every provider envVar from sandboxEnv', () => {
    const saved: Record<string, string | undefined> = {};
    for (const envVar of ENV_VARS) {
      saved[envVar] = process.env[envVar];
      process.env[envVar] = 'should-not-leak';
    }
    try {
      const env = sandboxEnv();
      for (const envVar of ENV_VARS) {
        assert.ok(!(envVar in env), `${envVar} leaked into sandbox env`);
      }
    } finally {
      for (const envVar of ENV_VARS) {
        if (saved[envVar] === undefined) delete process.env[envVar];
        else process.env[envVar] = saved[envVar];
      }
    }
  });

  after(() => {
    assert.ok(BLOCKED_ENV_PREFIXES.length > 0);
  });
});
