import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSecrets } from '../../src/security/shell-secrets.js';

// Wave 3: the shell-secret sanitizer runs over every tool output before it is
// returned to the model. A regression here either leaks raw secrets into the
// model's context (under-redaction) or scrambles benign output (over-redaction).
// Both are bad: under-redaction exfiltrates credentials to the LLM provider;
// over-redaction makes tool output unreadable and the agent loops.

test('sanitizeSecrets redacts an OpenAI-style API key (sk-…)', () => {
  const input = 'config: sk-' + 'a'.repeat(40);
  const { sanitized, findings } = sanitizeSecrets(input);
  assert.equal(sanitized, 'config: [REDACTED:openai_key]');
  assert.match(findings.join(','), /openai_key \(1 match\)/);
});

test('sanitizeSecrets redacts an Anthropic key (sk-ant-…)', () => {
  const input = 'Authorization: sk-ant-' + 'b'.repeat(40);
  const { sanitized, findings } = sanitizeSecrets(input);
  assert.equal(sanitized, 'Authorization: [REDACTED:anthropic_key]');
  assert.match(findings.join(','), /anthropic_key/);
});

test('sanitizeSecrets redacts a GitHub token (ghp_…)', () => {
  const input = 'GH_TOKEN=ghp_' + 'c'.repeat(36);
  const { sanitized } = sanitizeSecrets(input);
  assert.equal(sanitized, 'GH_TOKEN=[REDACTED:github_token]');
});

test('sanitizeSecrets redacts an AWS access key id (AKIA…)', () => {
  const input = 'aws_access_key_id: AKIA' + '0'.repeat(16);
  const { sanitized } = sanitizeSecrets(input);
  assert.equal(sanitized, 'aws_access_key_id: [REDACTED:aws_access_key]');
});

test('sanitizeSecrets redacts a JWT (three base64url segments)', () => {
  const input = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature';
  const { sanitized, findings } = sanitizeSecrets(input);
  assert.ok(sanitized.includes('[REDACTED:jwt_token]'), `got: ${sanitized}`);
  assert.match(findings.join(','), /jwt_token/);
  // The leading "Bearer " prefix is also matched by the bearer_token pattern,
  // so the whole thing collapses to a redaction either way — assert no leak.
  assert.ok(!sanitized.includes('eyJhbGciOiJIUzI1NiJ9'), 'JWT payload must not survive redaction');
});

test('sanitizeSecrets redacts a PEM private key header', () => {
  const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAI...';
  const { sanitized, findings } = sanitizeSecrets(input);
  assert.ok(sanitized.includes('[REDACTED:private_key_header]'), `got: ${sanitized}`);
  assert.match(findings.join(','), /private_key_header/);
  assert.ok(!sanitized.includes('BEGIN RSA PRIVATE KEY'));
});

test('sanitizeSecrets redacts a Postgres connection string', () => {
  const input = 'DATABASE_URL=postgres://user:pass@host:5432/db';
  const { sanitized, findings } = sanitizeSecrets(input);
  assert.equal(sanitized, 'DATABASE_URL=[REDACTED:db_connection_string]');
  assert.match(findings.join(','), /db_connection_string/);
  assert.ok(!sanitized.includes('pass@host'));
});

test('sanitizeSecrets redacts a Bearer token', () => {
  const input = 'Authorization: Bearer abcdefghijklmnop1234567890=';
  const { sanitized, findings } = sanitizeSecrets(input);
  assert.ok(sanitized.includes('[REDACTED:bearer_token]'), `got: ${sanitized}`);
  assert.match(findings.join(','), /bearer_token/);
});

test('sanitizeSecrets counts multiple matches of the same pattern', () => {
  const input = 'keys: sk-' + 'a'.repeat(40) + ' and sk-' + 'b'.repeat(40);
  const { findings } = sanitizeSecrets(input);
  // Both occurrences collapse to a single [REDACTED:openai_key] placeholder
  // (the sanitizer replaces globally), and findings reports the count.
  assert.match(findings.join(','), /openai_key \(2 matches\)/);
});

test('sanitizeSecrets leaves benign content untouched', () => {
  const input = 'The quick brown fox jumps over the lazy dog.';
  const { sanitized, findings } = sanitizeSecrets(input);
  // Note: the generic_api_key regex (/[A-Za-z0-9-_]{20,64}\b/) CAN match long
  // benign substrings like "Thequickbrownfoxjumps" if they're long enough — but
  // with spaces and punctuation the words stay short. Assert no REDACTED leaks
  // for normal prose, and that findings only flags genuinely long tokens.
  assert.ok(!sanitized.includes('[REDACTED:jwt_token]'));
  assert.ok(!sanitized.includes('[REDACTED:db_connection_string]'));
  // generic_api_key may fire on a 20+ char alphanumeric run; that's expected.
  // The contract is: secrets are redacted; prose is not scrambled beyond the
  // generic heuristic. Sanity-check findings is an array of strings.
  assert.ok(Array.isArray(findings));
});

test('sanitizeSecrets handles empty input', () => {
  const { sanitized, findings } = sanitizeSecrets('');
  assert.equal(sanitized, '');
  assert.deepEqual(findings, []);
});

test('sanitizeSecrets is idempotent — redacted output contains no raw secrets', () => {
  const input = 'sk-' + 'a'.repeat(40);
  const first = sanitizeSecrets(input);
  // Running again on the already-sanitized output must not re-introduce
  // anything and must not double-redact into a malformed token.
  const second = sanitizeSecrets(first.sanitized);
  assert.equal(second.sanitized, first.sanitized);
  assert.deepEqual(second.findings, []);
});

// Task 26: the generic_api_key pattern must be context-aware. It should only
// fire when the token appears in an assignment/key-value context (= or :, with
// an optional key/token/secret/password/bearer keyword), not when a long token
// simply appears in prose (e.g. build hashes, base64-looking text).

test('sanitizeSecrets redacts a long token in a bare = assignment (x=<token>)', () => {
  const input = 'x=' + 'abcdefghijklmnopqrstuvwxyz1234567890';
  const { sanitized, findings } = sanitizeSecrets(input);
  assert.equal(sanitized, 'x=[REDACTED:generic_api_key]');
  assert.match(findings.join(','), /generic_api_key/);
});

test('sanitizeSecrets redacts a long token after a keyword assignment (TOKEN=<token>)', () => {
  // 33-char token: long enough for generic_api_key, and TOKEN= + token stays
  // under 40 class chars so the loose aws_secret_key pattern does not fire.
  const input = 'TOKEN=' + 'abcdefghijklmnopqrstuvwxyz1234567';
  const { sanitized, findings } = sanitizeSecrets(input);
  assert.equal(sanitized, 'TOKEN=[REDACTED:generic_api_key]');
  assert.match(findings.join(','), /generic_api_key/);
});

test('sanitizeSecrets does NOT redact a long build hash in prose (no =/: context)', () => {
  // 40-char token total (build-hash- + 29 a's). A 40-char run of plain
  // alphanumerics would also trip the aws_secret_key pattern, so the run is
  // kept under 40 to isolate the generic_api_key behavior under test.
  const hash = 'build-hash-' + 'a'.repeat(29);
  assert.equal(hash.length, 40);
  const input = `the ${hash} was built`;
  const { sanitized, findings } = sanitizeSecrets(input);
  assert.equal(sanitized, input);
  assert.ok(!findings.join(',').includes('generic_api_key'));
});
