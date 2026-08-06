import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../types.js';
import type { ConversationEntry } from '../logger/conversation-logger.js';
import { walkFiles } from '../fs/walk.js';

const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/**
 * Walk conversation entries for `tool_call` messages and map each file path
 * written by a file-writing tool to the tool name (last write wins).
 * Handles both the `path` argument key used by the tool schemas and the
 * `file_path` alias. Entries with missing/malformed arguments are skipped.
 */
export function buildProducedByTool(
  conversation: readonly ConversationEntry[],
): Record<string, string> {
  const produced: Record<string, string> = {};
  for (const entry of conversation) {
    if (entry.type !== 'tool_call') continue;
    if (!entry.toolName || !FILE_WRITE_TOOLS.has(entry.toolName)) continue;
    const args = entry.meta?.args;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) continue;
    const raw = (args as Record<string, unknown>).file_path ?? (args as Record<string, unknown>).path;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    produced[raw] = entry.toolName;
  }
  return produced;
}

interface ArtifactEntry {
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

/** Path → tool name that produced it. Accepts a Map or a plain record. */
type ProducedByTool = Map<string, string> | Record<string, string>;

function lookupTool(producedByTool: ProducedByTool | undefined, rel: string): string | undefined {
  if (!producedByTool) return undefined;
  return producedByTool instanceof Map
    ? producedByTool.get(rel)
    : (producedByTool as Record<string, string>)[rel];
}

/** Generate a manifest for all files in a sandbox directory. */
export function generateManifest(
  sandboxDir: string,
  runId: string,
  model: string,
  producedByTool?: ProducedByTool,
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
  producedByTool?: ProducedByTool,
): ArtifactEntry[] {
  return walkFiles(baseDir).map((full) => {
    const rel = path.relative(baseDir, full);
    const stat = fs.statSync(full);
    return {
      path: rel,
      size: stat.size,
      sha256: hashFile(full),
      producedByTool: lookupTool(producedByTool, rel),
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
