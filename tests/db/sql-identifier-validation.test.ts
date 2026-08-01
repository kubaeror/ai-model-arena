import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSqlIdentifier,
  validateOrderByClause,
  validateWhereClause,
} from '../../src/db/query.js';

// ── validateSqlIdentifier ─────────────────────────────────────────────────

test('validateSqlIdentifier accepts bare identifiers', () => {
  assert.equal(validateSqlIdentifier('users'), 'users');
  assert.equal(validateSqlIdentifier('model_runtime_stats'), 'model_runtime_stats');
  assert.equal(validateSqlIdentifier('at'), 'at');
  assert.equal(validateSqlIdentifier('_private'), '_private');
});

test('validateSqlIdentifier accepts the literal *', () => {
  assert.equal(validateSqlIdentifier('*'), '*');
});

test('validateSqlIdentifier accepts double-quoted identifiers', () => {
  assert.equal(validateSqlIdentifier('"at"'), '"at"');
  assert.equal(validateSqlIdentifier('"order"'), '"order"');
});

test('validateSqlIdentifier accepts comma-separated column lists', () => {
  assert.equal(validateSqlIdentifier('id, name, created_at'), 'id, name, created_at');
  assert.equal(validateSqlIdentifier('"at", name'), '"at", name');
});

test('validateSqlIdentifier rejects empty input', () => {
  assert.throws(() => validateSqlIdentifier(''), /empty/i);
  assert.throws(() => validateSqlIdentifier('   '), /empty/i);
});

test('validateSqlIdentifier rejects semicolons (SQL injection)', () => {
  assert.throws(() => validateSqlIdentifier('users; DROP TABLE users'), /unsafe/i);
});

test('validateSqlIdentifier rejects identifiers starting with digits', () => {
  assert.throws(() => validateSqlIdentifier('1user'), /unsafe/i);
});

test('validateSqlIdentifier rejects identifiers with spaces in segments', () => {
  assert.throws(() => validateSqlIdentifier('user name'), /unsafe/i);
});

test('validateSqlIdentifier rejects backtick-quoted identifiers (MySQL style not allowed)', () => {
  assert.throws(() => validateSqlIdentifier('`order`'), /unsafe/i);
});

test('validateSqlIdentifier rejects empty segments in lists', () => {
  assert.throws(() => validateSqlIdentifier('a,, b'), /empty segment/i);
});

test('validateSqlIdentifier rejects UNION injection', () => {
  assert.throws(() => validateSqlIdentifier('users UNION SELECT password FROM users'), /unsafe/i);
});

// ── validateOrderByClause ─────────────────────────────────────────────────

test('validateOrderByClause accepts bare identifiers', () => {
  assert.equal(validateOrderByClause('benchmark'), 'benchmark');
  assert.equal(validateOrderByClause('measured_at DESC'), 'measured_at DESC');
  assert.equal(validateOrderByClause('name ASC'), 'name ASC');
});

test('validateOrderByClause accepts quoted identifiers', () => {
  assert.equal(validateOrderByClause('"at" DESC'), '"at" DESC');
});

test('validateOrderByClause accepts multi-column lists', () => {
  assert.equal(validateOrderByClause('benchmark, score DESC'), 'benchmark, score DESC');
});

test('validateOrderByClause rejects empty input', () => {
  assert.throws(() => validateOrderByClause(''), /empty/i);
});

test('validateOrderByClause rejects semicolons', () => {
  assert.throws(() => validateOrderByClause('name; DROP TABLE x'), /ORDER BY segment/i);
});

test('validateOrderByClause rejects UNION', () => {
  assert.throws(() => validateOrderByClause('UNION SELECT 1'), /ORDER BY segment/i);
});

test('validateOrderByClause rejects comment markers', () => {
  assert.throws(() => validateOrderByClause('name --'), /ORDER BY segment/i);
});

// ── validateWhereClause ───────────────────────────────────────────────────

test('validateWhereClause accepts the 1=1 empty-allowlist form', () => {
  assert.equal(validateWhereClause('1=1'), '1=1');
  assert.equal(validateWhereClause('model_id = ?'), 'model_id = ?');
  assert.equal(validateWhereClause('actor = ? AND action = ?'), 'actor = ? AND action = ?');
  assert.equal(validateWhereClause('"at" >= ?'), '"at" >= ?');
});

test('validateWhereClause rejects empty input', () => {
  assert.throws(() => validateWhereClause(''), /empty/i);
});

test('validateWhereClause rejects statement terminators', () => {
  assert.throws(() => validateWhereClause('1=1; DROP TABLE users'), /disallowed pattern ;/i);
});

test('validateWhereClause rejects line comments', () => {
  assert.throws(() => validateWhereClause('1=1 --'), /disallowed pattern --/i);
});

test('validateWhereClause rejects block comments', () => {
  assert.throws(() => validateWhereClause('1=1 /* */'), /disallowed pattern/i);
});

test('validateWhereClause rejects UNION', () => {
  assert.throws(() => validateWhereClause('1=1 UNION SELECT password FROM users'), /disallowed pattern/i);
});

test('validateWhereClause rejects time-based blind injection', () => {
  assert.throws(() => validateWhereClause('1=1 OR SLEEP(5)'), /SLEEP/i);
  assert.throws(() => validateWhereClause('1=1 OR BENCHMARK(1000000, MD5(1))'), /BENCHMARK/i);
});

test('validateWhereClause rejects file-read/write injection', () => {
  assert.throws(() => validateWhereClause('1=1 OR LOAD_FILE("/etc/passwd")'), /LOAD_FILE/i);
  assert.throws(() => validateWhereClause("1=1 INTO OUTFILE '/tmp/x'"), /INTO OUTFILE/i);
});
