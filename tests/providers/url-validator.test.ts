import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateProviderUrl, assertPublicUrl } from '../../src/providers/url-validator.js';
import { normalizeIp, isPrivateIp } from '../../src/providers/ip-ranges.js';

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

  it('blocks HTTPS localhost by literal name', () => {
    assert.strictEqual(validateProviderUrl('https://localhost/v1').ok, false);
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

  it('blocks Tencent Cloud metadata hostname', () => {
    assert.strictEqual(validateProviderUrl('https://metadata.tencentyun.com/latest/meta-data').ok, false);
  });

});

describe('validateProviderUrl IPv6 and mapped literals', () => {
  it('blocks bracketed IPv6 loopback [::1]', () => {
    assert.strictEqual(validateProviderUrl('https://[::1]/v1').ok, false);
  });

  it('blocks bracketed unique-local [fd00::1]', () => {
    assert.strictEqual(validateProviderUrl('https://[fd00::1]/v1').ok, false);
  });

  it('blocks bracketed link-local [fe80::abcd]', () => {
    assert.strictEqual(validateProviderUrl('https://[fe80::abcd]/v1').ok, false);
  });

  it('blocks unique-local addresses across fc00::/7 [fc01::1] and [fcff::1]', () => {
    assert.strictEqual(validateProviderUrl('https://[fc01::1]/v1').ok, false);
    assert.strictEqual(validateProviderUrl('https://[fcff::1]/v1').ok, false);
  });

  it('blocks deprecated site-local [fec0::1]', () => {
    assert.strictEqual(validateProviderUrl('https://[fec0::1]/v1').ok, false);
  });

  it('accepts a public IPv6 literal [2606:4700::1]', () => {
    assert.strictEqual(validateProviderUrl('https://[2606:4700::1]/v1').ok, true);
  });

  it('blocks IPv4-mapped loopback in hex form [::ffff:7f00:1]', () => {
    assert.strictEqual(validateProviderUrl('https://[::ffff:7f00:1]/v1').ok, false);
  });

  it('blocks IPv4-mapped loopback in long form [0:0:0:0:0:ffff:7f00:1]', () => {
    assert.strictEqual(validateProviderUrl('https://[0:0:0:0:0:ffff:7f00:1]/v1').ok, false);
  });

  it('blocks IPv4-mapped metadata in hex form [::ffff:a9fe:a9fe]', () => {
    assert.strictEqual(validateProviderUrl('https://[::ffff:a9fe:a9fe]/v1').ok, false);
  });

  it('blocks IPv4-mapped private [::ffff:c0a8:101]', () => {
    assert.strictEqual(validateProviderUrl('https://[::ffff:c0a8:101]/v1').ok, false);
  });

  it('accepts public IPv4-mapped IPv6 [::ffff:808:808]', () => {
    assert.strictEqual(validateProviderUrl('https://[::ffff:808:808]/v1').ok, true);
  });

  it('accepts a public IPv6 literal', () => {
    assert.strictEqual(validateProviderUrl('https://[2606:4700:4700::1111]/v1').ok, true);
  });
});

describe('normalizeIp / isPrivateIp', () => {
  it('normalizes mapped hex pairs to dotted IPv4', () => {
    assert.strictEqual(normalizeIp('::ffff:7f00:1'), '127.0.0.1');
    assert.strictEqual(normalizeIp('::ffff:a9fe:a9fe'), '169.254.169.254');
    assert.strictEqual(normalizeIp('0:0:0:0:0:ffff:7f00:1'), '127.0.0.1');
    assert.strictEqual(normalizeIp('::ffff:808:808'), '8.8.8.8');
  });

  it('strips brackets and zone ids and lowercases', () => {
    assert.strictEqual(normalizeIp('[FD00::1]'), 'fd00::1');
    assert.strictEqual(normalizeIp('[fe80::1%25eth0]'), 'fe80::1');
    assert.strictEqual(normalizeIp('FE80::1%eth0'), 'fe80::1');
  });

  it('flags mapped private ranges but not mapped public IPs', () => {
    assert.strictEqual(isPrivateIp('::ffff:7f00:1'), true);
    assert.strictEqual(isPrivateIp('0:0:0:0:0:ffff:a9fe:a9fe'), true);
    assert.strictEqual(isPrivateIp('::ffff:808:808'), false);
    assert.strictEqual(isPrivateIp('8.8.8.8'), false);
  });
});

describe('assertPublicUrl', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  it('rejects literal private IPv4', async () => {
    await assert.rejects(assertPublicUrl('https://127.0.0.1/hook'), /blocked|private/i);
  });

  it('rejects bracketed private IPv6', async () => {
    await assert.rejects(assertPublicUrl('https://[::1]/hook'), /blocked|private/i);
  });

  it('rejects mapped loopback in hex form', async () => {
    await assert.rejects(assertPublicUrl('https://[::ffff:7f00:1]/hook'), /blocked|private/i);
  });

  it('rejects hostnames that resolve to a private address', async () => {
    const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];
    await assert.rejects(
      assertPublicUrl('https://internal.example.test/hook', { lookup: privateLookup }),
      /blocked|private/i,
    );
  });

  it('rejects when ANY resolved answer is private', async () => {
    const mixedLookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    await assert.rejects(
      assertPublicUrl('https://mixed.example.test/hook', { lookup: mixedLookup }),
      /blocked|private/i,
    );
  });

  it('accepts a hostname that resolves only to public addresses', async () => {
    const url = await assertPublicUrl('https://hooks.example.test/hook', { lookup: publicLookup });
    assert.strictEqual(url.href, 'https://hooks.example.test/hook');
  });

  it('rejects DNS resolution failures', async () => {
    const failingLookup = async () => { throw new Error('ENOTFOUND'); };
    await assert.rejects(
      assertPublicUrl('https://missing.example.test/hook', { lookup: failingLookup }),
      /DNS resolution failed/,
    );
  });

  it('rejects non-http protocols', async () => {
    await assert.rejects(assertPublicUrl('ftp://example.com/hook'), /protocol/i);
  });

  it('rejects URLs with userinfo', async () => {
    await assert.rejects(assertPublicUrl('https://user:pass@example.com/hook'), /credentials|userinfo/i);
  });
});
