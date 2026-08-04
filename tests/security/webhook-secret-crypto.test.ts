import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  encryptWebhookSecret,
  decryptWebhookSecret,
  _resetKeyCacheForTests,
} from '../../src/security/webhook-secret-crypto.js';

// H5: webhook HMAC secrets must be encrypted at rest with AES-256-GCM.
// Plaintext storage let anyone with DB read access (or via the S5 regression
// path-traversal before that fix) read webhook secrets and forge signatures.

beforeEach(() => {
  _resetKeyCacheForTests();
  delete process.env.WEBHOOK_SECRET_KEY;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  _resetKeyCacheForTests();
  delete process.env.WEBHOOK_SECRET_KEY;
  delete process.env.NODE_ENV;
});

test('encryptWebhookSecret returns null for null/empty input', () => {
  assert.equal(encryptWebhookSecret(null), null);
  assert.equal(encryptWebhookSecret(undefined), null);
  assert.equal(encryptWebhookSecret(''), null);
});

test('encryptWebhookSecret produces a v1:-prefixed ciphertext', () => {
  const ct = encryptWebhookSecret('my-secret-value');
  assert.ok(ct, 'expected a ciphertext');
  assert.ok(ct!.startsWith('v1:'), 'expected v1: prefix');
});

test('encryptWebhookSecret is non-deterministic (random IV per call)', () => {
  // Same plaintext must produce different ciphertexts (GCM nonce uniqueness).
  const a = encryptWebhookSecret('same-secret');
  const b = encryptWebhookSecret('same-secret');
  assert.notEqual(a, b, 'ciphertexts must differ due to random IV');
});

test('decryptWebhookSecret round-trips an encrypted secret (dev key)', () => {
  const plaintext = 'super-secret-hmac-key-123';
  const ct = encryptWebhookSecret(plaintext);
  assert.ok(ct);
  const recovered = decryptWebhookSecret(ct);
  assert.equal(recovered, plaintext);
});

test('decryptWebhookSecret returns null for null/empty input', () => {
  assert.equal(decryptWebhookSecret(null), null);
  assert.equal(decryptWebhookSecret(undefined), null);
  assert.equal(decryptWebhookSecret(''), null);
});

test('decryptWebhookSecret accepts legacy plaintext (no v1: prefix) for backward compat', () => {
  // Existing rows stored before encryption must keep working.
  const legacy = 'legacy-plaintext-secret';
  const recovered = decryptWebhookSecret(legacy);
  assert.equal(recovered, legacy);
});

test('decryptWebhookSecret rejects tampered ciphertext (GCM auth tag)', () => {
  const ct = encryptWebhookSecret('my-secret')!;
  // Flip a byte in the ciphertext body to simulate tampering.
  const blob = Buffer.from(ct.slice('v1:'.length), 'base64');
  blob[blob.length - 1] ^= 0x01; // flip a bit in the auth tag
  const tampered = 'v1:' + blob.toString('base64');
  assert.throws(() => decryptWebhookSecret(tampered), /unsupported|auth|decrypt/i);
});

test('decryptWebhookSecret treats a too-short v1: value as legacy plaintext (I5)', () => {
  // I5 — prefix-collision robustness: a v1:-prefixed value too short to be a
  // real ciphertext (iv+authTag = 28 bytes minimum) is treated as legacy
  // plaintext rather than throwing, so a row whose secret happens to start
  // with "v1:" doesn't break webhook delivery.
  const short = 'v1:' + Buffer.from('abc').toString('base64');
  const recovered = decryptWebhookSecret(short);
  assert.equal(recovered, short, 'too-short v1: value returned as legacy plaintext');
});

test('decryptWebhookSecret treats a non-base64 v1: value as legacy plaintext (I5)', () => {
  // A v1:-prefixed value whose body is not clean base64 can't be a real
  // ciphertext — fall back to legacy plaintext instead of throwing.
  const weird = 'v1:not-base64-at-all!!';
  const recovered = decryptWebhookSecret(weird);
  assert.equal(recovered, weird, 'non-base64 v1: value returned as legacy plaintext');
});

test('encrypt/decrypt works with a hex env key', () => {
  process.env.WEBHOOK_SECRET_KEY = crypto.randomBytes(32).toString('hex');
  _resetKeyCacheForTests();
  const plaintext = 'hex-key-secret';
  const ct = encryptWebhookSecret(plaintext);
  const recovered = decryptWebhookSecret(ct);
  assert.equal(recovered, plaintext);
});

test('encrypt/decrypt works with a base64 env key', () => {
  process.env.WEBHOOK_SECRET_KEY = crypto.randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
  const plaintext = 'base64-key-secret';
  const ct = encryptWebhookSecret(plaintext);
  const recovered = decryptWebhookSecret(ct);
  assert.equal(recovered, plaintext);
});

test('decrypt with a DIFFERENT key fails (key rotation requires re-encryption)', () => {
  process.env.WEBHOOK_SECRET_KEY = crypto.randomBytes(32).toString('hex');
  _resetKeyCacheForTests();
  const ct = encryptWebhookSecret('first-key-secret');
  // Switch to a different key.
  process.env.WEBHOOK_SECRET_KEY = crypto.randomBytes(32).toString('hex');
  _resetKeyCacheForTests();
  assert.throws(() => decryptWebhookSecret(ct));
});

test('encrypt throws in production when WEBHOOK_SECRET_KEY is unset', () => {
  process.env.NODE_ENV = 'production';
  assert.throws(() => encryptWebhookSecret('any'), /WEBHOOK_SECRET_KEY/);
});

test('decrypt throws in production when WEBHOOK_SECRET_KEY is unset (for v1: ciphertext)', () => {
  // First encrypt with a dev key, then try to decrypt in production without a key.
  const ct = encryptWebhookSecret('dev-secret');
  process.env.NODE_ENV = 'production';
  _resetKeyCacheForTests();
  assert.throws(() => decryptWebhookSecret(ct), /WEBHOOK_SECRET_KEY/);
});

test('encrypt rejects a malformed WEBHOOK_SECRET_KEY (wrong byte length)', () => {
  process.env.WEBHOOK_SECRET_KEY = 'aabbccdd'; // 4 bytes, not 32
  _resetKeyCacheForTests();
  assert.throws(() => encryptWebhookSecret('x'), /32 bytes/);
});
