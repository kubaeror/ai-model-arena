import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, authedGet, postJson } from './route-test-harness.js';

// S6: scenario starterFiles path-traversal prevention.
//
// Before the fix, POST/PUT accepted body.starterFiles unvalidated, so an
// editor could set starterFiles: "../../../configs" and:
//   - any viewer could GET /api/scenarios/:name and read arbitrary file
//     contents via listStarterFiles();
//   - DELETE would fs.rmSync() that directory tree recursively.

test('POST /api/scenarios rejects a traversal starterFiles value', async (t) => {
  const h = await boot(t);
  const res = await postJson(h.base, h.adminToken, '/api/scenarios', {
    name: 'evil',
    systemPrompt: 'x',
    task: 'y',
    starterFiles: '../../../configs',
  });
  assert.equal(res.status, 400, 'traversal starterFiles must be rejected');
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /starterFiles/i);
});

test('PUT /api/scenarios/:name rejects a traversal starterFiles value', async (t) => {
  const h = await boot(t);
  const created = await postJson(h.base, h.adminToken, '/api/scenarios', {
    name: 'roundtrip',
    systemPrompt: 'x',
    task: 'y',
  });
  assert.equal(created.status, 201);
  const res = await fetch(`${h.base}/api/scenarios/roundtrip`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'roundtrip', starterFiles: '../../etc' }),
  });
  assert.equal(res.status, 400, 'traversal starterFiles on PUT must be rejected');
});

test('POST /api/scenarios accepts a well-formed templates/<name> starterFiles', async (t) => {
  const h = await boot(t);
  const res = await postJson(h.base, h.adminToken, '/api/scenarios', {
    name: 'good-tpl',
    systemPrompt: 'x',
    task: 'y',
    starterFiles: 'templates/my-tpl',
  });
  assert.equal(res.status, 201, 'templates/<name> starterFiles must be accepted');
});

test('GET /api/scenarios/:name refuses to serve files for a traversal starterFiles on disk', async (t) => {
  // Defense in depth: a YAML written before this fix (or by another writer)
  // may already carry a traversal starterFiles. The read path must refuse.
  const h = await boot(t);
  const evilYaml = path.join(h.tmpDir, 'configs', 'scenarios', 'evil.yaml');
  fs.mkdirSync(path.dirname(evilYaml), { recursive: true });
  // `..` resolves to <tmpDir>/configs — the harness's own configs dir, one
  // level above scenariosDir(). With the guard absent this dir is walked and
  // served; with it present listStarterFiles() returns [].
  fs.writeFileSync(
    evilYaml,
    'name: evil\nsystemPrompt: x\ntask: y\nstarterFiles: ..\n',
  );
  const res = await authedGet(h.base, h.adminToken, '/api/scenarios/evil');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { scenario: { name: string }; starterFiles: unknown[] };
  assert.equal(body.scenario.name, 'evil');
  assert.deepEqual(body.starterFiles, [], 'must not walk directories outside scenariosDir()');
});

test('DELETE /api/scenarios/:name must not remove directories outside scenariosDir()', async (t) => {
  const h = await boot(t);
  const configsDir = path.join(h.tmpDir, 'configs');
  const sentinel = path.join(configsDir, 'keep-me.txt');
  fs.mkdirSync(path.join(h.tmpDir, 'configs', 'scenarios'), { recursive: true });
  fs.writeFileSync(sentinel, 'still here');
  // `..` resolves to <tmpDir>/configs. Without the guard, DELETE would
  // fs.rmSync() that dir recursively, destroying keep-me.txt.
  fs.writeFileSync(
    path.join(h.tmpDir, 'configs', 'scenarios', 'evil.yaml'),
    'name: evil\nsystemPrompt: x\ntask: y\nstarterFiles: ..\n',
  );
  const res = await fetch(`${h.base}/api/scenarios/evil`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${h.adminToken}` },
  });
  assert.equal(res.status, 200, 'scenario file itself is deleted');
  assert.ok(!fs.existsSync(path.join(h.tmpDir, 'configs', 'scenarios', 'evil.yaml')));
  assert.ok(fs.existsSync(sentinel), 'configs/ contents must survive');
});

test('GET /api/scenarios/:name must not serve the scenarios dir itself (starterFiles: ".")', async (t) => {
  const h = await boot(t);
  const scenariosDir = path.join(h.tmpDir, 'configs', 'scenarios');
  fs.mkdirSync(scenariosDir, { recursive: true });
  const yaml = path.join(scenariosDir, 'dot.yaml');
  fs.writeFileSync(yaml, 'name: dot\nsystemPrompt: x\ntask: y\nstarterFiles: .\n');
  const res = await authedGet(h.base, h.adminToken, '/api/scenarios/dot');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { starterFiles: unknown[] };
  assert.deepEqual(body.starterFiles, [], 'must not walk scenariosDir() itself');
});

test('DELETE /api/scenarios/:name must not remove the scenarios dir (starterFiles: ".")', async (t) => {
  const h = await boot(t);
  const scenariosDir = path.join(h.tmpDir, 'configs', 'scenarios');
  fs.mkdirSync(scenariosDir, { recursive: true });
  const keep = path.join(scenariosDir, 'keep-me.yaml');
  fs.writeFileSync(keep, 'name: keep\nsystemPrompt: x\ntask: y\n');
  const evil = path.join(scenariosDir, 'dot.yaml');
  fs.writeFileSync(evil, 'name: dot\nsystemPrompt: x\ntask: y\nstarterFiles: .\n');
  const res = await fetch(`${h.base}/api/scenarios/dot`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${h.adminToken}` },
  });
  assert.equal(res.status, 200);
  assert.ok(!fs.existsSync(evil), 'deleted scenario file is gone');
  assert.ok(fs.existsSync(keep), 'other scenario files must survive');
});
