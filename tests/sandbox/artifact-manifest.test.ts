import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateManifest,
  writeManifest,
  type ArtifactManifest,
} from '../../src/sandbox/artifact-manifest.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arena-manifest-'));
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

test('generateManifest returns empty entries when directory is missing', () => {
  const manifest = generateManifest('/nonexistent/arena-dir', 'r1', 'gpt-4o');
  assert.equal(manifest.entries.length, 0);
  assert.equal(manifest.quarantined, false);
  assert.equal(manifest.runId, 'r1');
  assert.equal(manifest.model, 'gpt-4o');
  assert.ok(manifest.generatedAt);
});

test('generateManifest hashes all files with relative paths', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'beta');
  try {
    const manifest = generateManifest(dir, 'r2', 'claude-3.5');
    assert.equal(manifest.entries.length, 2);
    const a = manifest.entries.find((e) => e.path === 'a.txt')!;
    assert.equal(a.size, 5);
    assert.equal(a.sha256, sha256('alpha'));
    const b = manifest.entries.find((e) => e.path === path.join('sub', 'b.txt'))!;
    assert.equal(b.sha256, sha256('beta'));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('generateManifest records producedByTool when present', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha');
  try {
    const produced = new Map<string, string>([['a.txt', 'write_file']]);
    const manifest = generateManifest(dir, 'r3', 'gpt-4o', produced);
    assert.equal(manifest.entries[0]!.producedByTool, 'write_file');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('generateManifest leaves producedByTool undefined for unknown files', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha');
  try {
    const manifest = generateManifest(dir, 'r4', 'gpt-4o', new Map());
    assert.equal(manifest.entries[0]!.producedByTool, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeManifest writes JSON file and returns path', () => {
  const dir = tmpDir();
  try {
    const manifest: ArtifactManifest = {
      runId: 'r5',
      model: 'gpt-4o',
      generatedAt: '2026-01-01T00:00:00.000Z',
      quarantined: true,
      entries: [],
    };
    const out = writeManifest(manifest, dir);
    assert.equal(out, path.join(dir, 'artifact-manifest.json'));
    assert.ok(fs.existsSync(out));
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(parsed.runId, 'r5');
    assert.equal(parsed.quarantined, true);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
