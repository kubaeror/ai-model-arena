import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore } from '../../src/secrets/store.js';

// The SecretStore is constructed with explicit envFile/secretsDir/platform
// overrides so every test runs against a throwaway temp dir instead of the
// real cwd/.env or /etc/arena/secrets. The production singleton
// (secretStore) is untouched.

function makeTempEnv(): { dir: string; envFile: string; store: SecretStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-secrets-test-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, '');
  return { dir, envFile, store: new SecretStore({ envFile }) };
}

function readEnv(envFile: string): string {
  return fs.readFileSync(envFile, 'utf-8');
}

function countLines(content: string, key: string): number {
  const re = new RegExp(`^${key}=`, 'm');
  let n = 0;
  for (const line of content.split('\n')) {
    if (re.test(line)) n++;
  }
  return n;
}

const ENV_CLEANUP: string[] = [];

function trackEnvVar(name: string): void {
  ENV_CLEANUP.push(name);
}

test('set writes a new entry to .env and get reads it back', () => {
  const { envFile, store } = makeTempEnv();
  trackEnvVar('OPENAI_API_KEY');
  const value = 'sk-test-1234567890';
  store.set('OPENAI_API_KEY', value);
  assert.equal(store.get('OPENAI_API_KEY'), value);
  const content = readEnv(envFile);
  assert.ok(content.includes(`OPENAI_API_KEY="${value}"`), `got: ${content}`);
  fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
});

test('set updates an existing entry without duplicating lines', () => {
  const { envFile, store } = makeTempEnv();
  trackEnvVar('OPENAI_API_KEY');
  store.set('OPENAI_API_KEY', 'v1');
  store.set('OPENAI_API_KEY', 'v2');
  assert.equal(store.get('OPENAI_API_KEY'), 'v2');
  const content = readEnv(envFile);
  assert.equal(countLines(content, 'OPENAI_API_KEY'), 1, `got: ${content}`);
  assert.ok(content.includes('OPENAI_API_KEY="v2"'), `got: ${content}`);
  fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
});

test('delete removes the entry from .env and process.env', () => {
  const { envFile, store } = makeTempEnv();
  trackEnvVar('ANTHROPIC_API_KEY');
  store.set('ANTHROPIC_API_KEY', 'sk-ant-test');
  assert.equal(store.get('ANTHROPIC_API_KEY'), 'sk-ant-test');
  store.delete('ANTHROPIC_API_KEY');
  assert.equal(store.get('ANTHROPIC_API_KEY'), undefined);
  const content = readEnv(envFile);
  assert.ok(!content.includes('ANTHROPIC_API_KEY'), `got: ${content}`);
  fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
});

test('regex-special keys (MY.KEY, MY$KEY) round-trip and stay single-line', () => {
  const { envFile, store } = makeTempEnv();
  trackEnvVar('MY.KEY');
  trackEnvVar('MY$KEY');
  store.set('MY.KEY', 'dot');
  store.set('MY.KEY', 'dot2');
  assert.equal(process.env['MY.KEY'], 'dot2', 'set must update process.env for the writer');
  store.set('MY$KEY', 'dollar');
  store.set('MY$KEY', 'dollar2');
  assert.equal(process.env['MY$KEY'], 'dollar2');
  const content = readEnv(envFile);
  assert.equal(countLines(content, 'MY\\.KEY'), 1, `got: ${content}`);
  assert.equal(countLines(content, 'MY\\$KEY'), 1, `got: ${content}`);
  assert.ok(content.includes('MY.KEY="dot2"'), `got: ${content}`);
  assert.ok(content.includes('MY$KEY="dollar2"'), `got: ${content}`);
  fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
});

test('a regex-special key must not clobber another key\'s .env line', () => {
  // Without escaping, ^MY.KEY= matches the MYAKEY= line, destroying it.
  const { envFile, store } = makeTempEnv();
  trackEnvVar('MY.KEY');
  trackEnvVar('MYAKEY');
  store.set('MY.KEY', 'dot');
  store.set('MYAKEY', 'a');
  store.set('MY.KEY', 'dot2');
  assert.equal(process.env['MY.KEY'], 'dot2');
  assert.equal(store.get('MYAKEY'), 'a');
  const content = readEnv(envFile);
  assert.ok(content.includes('MYAKEY="a"'), `got: ${content}`);
  assert.equal(countLines(content, 'MY\\.KEY'), 1, `got: ${content}`);
  assert.equal(countLines(content, 'MYAKEY'), 1, `got: ${content}`);
  fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
});

test('list() masks values in bare-metal mode', () => {
  const { dir, store } = makeTempEnv();
  const raw = 'sk-abcdef1234567890';
  process.env.TEST_API_KEY = raw;
  try {
    const entries = store.list();
    const entry = entries.find((e) => e.envVar === 'TEST_API_KEY');
    assert.ok(entry, `expected TEST_API_KEY in list, got: ${entries.map((e) => e.envVar).join(',')}`);
    assert.equal(entry.status, 'set');
    assert.ok(entry.maskedValue);
    assert.ok(!entry.maskedValue.includes(raw), 'masked value must not contain raw secret');
    assert.ok(entry.maskedValue.includes(raw.slice(0, 4)), 'mask keeps first 4 chars');
    assert.ok(entry.maskedValue.includes(raw.slice(-4)), 'mask keeps last 4 chars');
  } finally {
    delete process.env.TEST_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('list() in k8s mode filters to [A-Za-z0-9_] filenames and masks values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-secrets-k8s-'));
  fs.writeFileSync(path.join(dir, 'OPENAI_API_KEY'), 'sk-1234567890abcdef');
  fs.writeFileSync(path.join(dir, 'EMPTY'), '');
  fs.writeFileSync(path.join(dir, '.env'), 'sidecar\n');
  fs.writeFileSync(path.join(dir, 'sidecar-1'), 'x');
  fs.writeFileSync(path.join(dir, 'data.txt'), 'y');
  fs.mkdirSync(path.join(dir, 'subdir'));
  const store = new SecretStore({ platform: 'kubernetes', secretsDir: dir });
  try {
    const entries = store.list();
    const names = entries.map((e) => e.envVar).sort();
    assert.deepEqual(names, ['EMPTY', 'OPENAI_API_KEY']);
    const key = entries.find((e) => e.envVar === 'OPENAI_API_KEY');
    assert.equal(key?.status, 'set');
    assert.ok(key?.maskedValue);
    assert.ok(!key?.maskedValue.includes('sk-1234567890abcdef'), 'k8s masked value must not leak raw secret');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set/delete throw in k8s mode', () => {
  const store = new SecretStore({ platform: 'kubernetes', secretsDir: '/tmp/does-not-exist' });
  assert.rejects(store.set('K', 'v'), /requires k8s API/);
  assert.rejects(store.delete('K'), /requires k8s API/);
});

test('get() refuses path traversal outside the k8s secrets dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-secrets-traversal-'));
  const secretsDir = path.join(root, 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'serviceaccount-token'), 'top-secret-token');
  const store = new SecretStore({ platform: 'kubernetes', secretsDir });
  try {
    assert.equal(store.get('../serviceaccount-token'), undefined, 'parent traversal must not read outside the mount');
    assert.equal(store.get('../../etc/passwd'), undefined, 'deep traversal must not read host files');
    assert.equal(store.get('lower-case'), undefined, 'invalid env names must return undefined');
    assert.equal(store.get('MY.KEY'), undefined, 'path separators/dots are not valid env names');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('get() refuses names that are not valid env var identifiers in bare-metal mode', () => {
  const { dir, store } = makeTempEnv();
  process.env['LOWER_case'] = 'x';
  process.env['MY.DOT'] = 'y';
  try {
    assert.equal(store.get('LOWER_case'), undefined);
    assert.equal(store.get('MY.DOT'), undefined);
  } finally {
    delete process.env['LOWER_case'];
    delete process.env['MY.DOT'];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => {
  for (const name of ENV_CLEANUP) {
    delete process.env[name];
  }
});
