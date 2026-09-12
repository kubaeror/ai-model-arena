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

// Known secret families that must never reach a sandboxed subprocess. Enumerates
// both explicitly listed names and the generic case-insensitive suffix rule.
const KNOWN_SECRET_KEYS = [
  'SEARCH_API_KEY',
  'WEBHOOK_SECRET_KEY',
  'METRICS_TOKEN',
  'DASHBOARD_REDIS_URL',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'DATABASE_URL',
  'DASHBOARD_JWT_SECRET',
  'DASHBOARD_PASSWORD',
  'ARENA_API_KEY_CI',
  'aws_access_key_id',
  'FEATURE_TOKEN',
  'MY_SECRET',
  'DB_PASSWORD',
  'lowercase_api_key',
  'Mixed_Case_Api_Key',
];

const PRESERVED_KEYS = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR'];

function withEnvValues(keys: string[], value: string, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('sandbox env blocklist covers known secret families', () => {
  it('strips every known secret key', () => {
    withEnvValues(KNOWN_SECRET_KEYS, 'should-not-leak', () => {
      const env = sandboxEnv();
      for (const key of KNOWN_SECRET_KEYS) {
        assert.ok(!(key in env), `${key} leaked into sandbox env`);
      }
    });
  });

  it('keeps PATH, HOME, LANG, TERM and TMPDIR intact', () => {
    withEnvValues(PRESERVED_KEYS, 'kept', () => {
      const env = sandboxEnv();
      for (const key of PRESERVED_KEYS) {
        assert.strictEqual(env[key], 'kept', `${key} must survive sandboxEnv()`);
      }
    });
  });
});
