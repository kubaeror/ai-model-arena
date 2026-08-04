import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSuitePath } from '../../src/dashboard-server/routes/regression.js';

// S5: regression route path-traversal prevention.
//
// Before the fix, loadSuiteConfig() did path.join(regressionDir(), `${suiteName}.yaml`)
// with no validation on suiteName. Express URL-decodes route params, so a
// request like GET /api/regression/suites/..%2F..%2Fapi-keys would resolve to
// configs/api-keys.yaml — letting any viewer read arbitrary YAML files.

test('resolveSuitePath accepts a bare alphanumeric suite name', () => {
  const p = resolveSuitePath('my-suite_1');
  assert.ok(p, 'expected a resolved path');
  assert.match(p!, /regression[\\/]+my-suite_1\.yaml$/);
});

test('resolveSuitePath rejects empty input', () => {
  assert.equal(resolveSuitePath(''), null);
});

test('resolveSuitePath rejects path traversal with .. segments', () => {
  // URL-decoded form of ..%2F..%2Fapi-keys
  assert.equal(resolveSuitePath('../../api-keys'), null);
  assert.equal(resolveSuitePath('..'), null);
  assert.equal(resolveSuitePath('../api-keys'), null);
  assert.equal(resolveSuitePath('subdir/../../api-keys'), null);
});

test('resolveSuitePath rejects absolute paths', () => {
  assert.equal(resolveSuitePath('/etc/passwd'), null);
  assert.equal(resolveSuitePath('/etc/cron.d/evil'), null);
});

test('resolveSuitePath rejects shell metacharacters and path separators', () => {
  assert.equal(resolveSuitePath('suite;rm -rf /'), null);
  assert.equal(resolveSuitePath('suite|cat /etc/passwd'), null);
  assert.equal(resolveSuitePath('suite/sub'), null); // path separator
  assert.equal(resolveSuitePath('suite\\sub'), null); // backslash separator
});

test('resolveSuitePath rejects names with only dots or special chars', () => {
  assert.equal(resolveSuitePath('.'), null);
  assert.equal(resolveSuitePath('..'), null);
  assert.equal(resolveSuitePath('...'), null);
  assert.equal(resolveSuitePath('!@#$%'), null);
});

test('resolveSuitePath accepts names with underscores and hyphens', () => {
  assert.ok(resolveSuitePath('my-suite'));
  assert.ok(resolveSuitePath('my_suite'));
  assert.ok(resolveSuitePath('Suite_NAME-1'));
});
