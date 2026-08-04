import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../types.js';
import { walkFiles } from '../fs/walk.js';

export interface ArtifactEntry {
  path: string;
  size: number;
  sha256: string;
  producedByTool?: string;
}

export interface ArtifactManifest {
  runId: string;
  model: string;
  generatedAt: string;
  quarantined: boolean;
  validatedBy?: string;
  validatedAt?: string;
  entries: ArtifactEntry[];
}

function hashFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Generate a manifest for all files in a sandbox directory. */
export function generateManifest(
  sandboxDir: string,
  runId: string,
  model: string,
  producedByTool?: Map<string, string>,
): ArtifactManifest {
  const entries = fs.existsSync(sandboxDir) ? walkAndHash(sandboxDir, producedByTool) : [];
  return {
    runId,
    model,
    generatedAt: new Date().toISOString(),
    quarantined: false,
    entries,
  };
}

function walkAndHash(
  baseDir: string,
  producedByTool?: Map<string, string>,
): ArtifactEntry[] {
  return walkFiles(baseDir).map((full) => {
    const rel = path.relative(baseDir, full);
    const stat = fs.statSync(full);
    return {
      path: rel,
      size: stat.size,
      sha256: hashFile(full),
      producedByTool: producedByTool?.get(rel),
    };
  });
}

/** Write manifest to disk and return the file path. */
export function writeManifest(
  manifest: ArtifactManifest,
  outputDir: string,
  logger?: Logger,
): string {
  const manifestPath = path.join(outputDir, 'artifact-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  logger?.info('Artifact manifest written', {
    path: manifestPath,
    entries: manifest.entries.length,
    quarantined: manifest.quarantined,
  });
  return manifestPath;
}
