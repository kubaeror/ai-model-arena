import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateProviderUrl } from '../../src/providers/url-validator.js';

describe('validateProviderUrl', () => {
  it('accepts valid HTTPS URLs', () => {
    const r = validateProviderUrl('https://api.openai.com/v1');
    assert.strictEqual(r.ok, true);
  });

  it('accepts HTTPS URL with path', () => {
    const r = validateProviderUrl('https://api.groq.com/openai/v1');
    assert.strictEqual(r.ok, true);
  });

  it('blocks localhost', () => {
    const r = validateProviderUrl('http://localhost:11434/v1');
    assert.strictEqual(r.ok, false);
  });

  it('blocks 127.0.0.1', () => {
    const r = validateProviderUrl('https://127.0.0.1:8080/v1');
    assert.strictEqual(r.ok, false);
  });

  it('blocks private 10.x.x.x', () => {
    const r = validateProviderUrl('https://10.0.0.1/v1');
    assert.strictEqual(r.ok, false);
  });

  it('blocks 192.168.x.x', () => {
    const r = validateProviderUrl('https://192.168.1.1/v1');
    assert.strictEqual(r.ok, false);
  });

  it('blocks 172.16.x.x', () => {
    const r = validateProviderUrl('https://172.16.0.1/v1');
    assert.strictEqual(r.ok, false);
  });

  it('blocks link-local 169.254.x.x', () => {
    const r = validateProviderUrl('https://169.254.169.254/latest/meta-data');
    assert.strictEqual(r.ok, false);
  });

  it('blocks kubernetes cluster local', () => {
    const r = validateProviderUrl('https://redis.ai-arena.svc.cluster.local:6379');
    assert.strictEqual(r.ok, false);
  });

  it('blocks .svc suffix', () => {
    const r = validateProviderUrl('https://postgres.ai-arena.svc:5432');
    assert.strictEqual(r.ok, false);
  });

  it('blocks non-standard port', () => {
    const r = validateProviderUrl('https://example.com:8080/v1');
    assert.strictEqual(r.ok, false);
  });

  it('blocks metadata.google.internal', () => {
    const r = validateProviderUrl('http://metadata.google.internal');
    assert.strictEqual(r.ok, false);
  });

});
