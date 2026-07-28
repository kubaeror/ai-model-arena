import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../types.js';

export interface SignedArtifact {
  path: string;
  sha256: string;
  signature: string;
  signer: string;
  signedAt: string;
}

/**
 * Sign all files in a sandbox output directory using an HMAC key.
 * Generates a signature.json manifest with per-file signatures.
 * Used for artifact integrity verification before operator download.
 */
export function signArtifacts(
  sandboxDir: string,
  outputDir: string,
  signer: string,
  signingKey: string,
  logger?: Logger,
): SignedArtifact[] {
  const signed: SignedArtifact[] = [];
  if (!fs.existsSync(sandboxDir)) return signed;

  walkAndSign(sandboxDir, sandboxDir, signed, signer, signingKey);

  const manifest = {
    signer,
    signedAt: new Date().toISOString(),
    artifacts: signed,
  };

  fs.writeFileSync(
    path.join(outputDir, 'signature.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  logger?.info('Artifacts signed', {
    outputDir,
    count: signed.length,
    signer,
  });

  return signed;
}

function walkAndSign(
  baseDir: string,
  currentDir: string,
  results: SignedArtifact[],
  signer: string,
  signingKey: string,
): void {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of dirents) {
    const full = path.join(currentDir, e.name);
    if (e.isDirectory()) continue; // skip dirs
    if (e.isFile() && e.name === 'signature.json') continue;

    const rel = path.relative(baseDir, full);
    const buf = fs.readFileSync(full);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(sha256)
      .digest('hex');

    results.push({
      path: rel,
      sha256,
      signature,
      signer,
      signedAt: new Date().toISOString(),
    });
  }
}

/**
 * Verify artifact signatures against a manifest.
 * Returns {valid: true} if all signatures match, or {valid: false} with mismatches.
 */
export function verifySignatures(
  outputDir: string,
  signingKey: string,
): { valid: boolean; mismatches: string[] } {
  const manifestPath = path.join(outputDir, 'signature.json');
  if (!fs.existsSync(manifestPath)) {
    return { valid: false, mismatches: ['No signature manifest found'] };
  }

  let manifest: { artifacts: SignedArtifact[] };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { valid: false, mismatches: ['Failed to parse signature manifest'] };
  }

  const mismatches: string[] = [];
  for (const entry of manifest.artifacts) {
    const filePath = path.join(outputDir, 'files', entry.path);
    if (!fs.existsSync(filePath)) {
      mismatches.push(`${entry.path}: file missing`);
      continue;
    }

    const buf = fs.readFileSync(filePath);
    const actualSha256 = crypto.createHash('sha256').update(buf).digest('hex');
    if (actualSha256 !== entry.sha256) {
      mismatches.push(`${entry.path}: checksum mismatch`);
      continue;
    }

    const expectedSig = crypto
      .createHmac('sha256', signingKey)
      .update(actualSha256)
      .digest('hex');

    if (expectedSig !== entry.signature) {
      mismatches.push(`${entry.path}: signature mismatch`);
    }
  }

  return { valid: mismatches.length === 0, mismatches };
}
