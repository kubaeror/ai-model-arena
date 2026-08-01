/**
 * I4 — Webhook secrets re-encryption migration.
 *
 * One-shot backfill that scans every row in the `webhooks` table and, for any
 * secret stored as legacy plaintext (no `v1:` prefix), re-encrypts it in place
 * with AES-256-GCM. Rows that are already encrypted (have the `v1:` prefix)
 * or that are NULL/empty are skipped.
 *
 * Background: the `encryptWebhookSecret` / `decryptWebhookSecret` helpers
 * (H5) encrypt NEW and UPDATED secrets, but rows written before that change
 * are still plaintext on disk. `decryptWebhookSecret` has a backward-compat
 * fallback that returns legacy plaintext as-is, so webhooks keep working —
 * but the plaintext remains in the DB indefinitely. This script shrinks
 * that legacy surface to zero so the fallback path is only a safety net,
 * not the common case.
 *
 * Idempotent: safe to run repeatedly. A second run finds only already-
 * encrypted rows and reports zero migrations.
 *
 * Usage:
 *   WEBHOOK_SECRET_KEY=<32-byte hex> node --import tsx scripts/migrate-webhook-secrets.ts
 *   # or, in dev (derives a dev key — NOT for production):
 *   node --import tsx scripts/migrate-webhook-secrets.ts
 *
 * Safety gate: set ARENA_MIGRATE_WEBHOOK_SECRETS=true to actually write;
 * without it the script runs in dry-run mode and only reports what it
 * would change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { initDb, getDb, closeDb } from '../src/db/client.js';
import { encryptWebhookSecret, decryptWebhookSecret } from '../src/security/webhook-secret-crypto.js';

interface WebhookRow {
  id: number;
  url: string;
  secret: string | null;
}

const VERSION_PREFIX = 'v1:';
const DRY_RUN = process.env.ARENA_MIGRATE_WEBHOOK_SECRETS !== 'true';

function findProjectRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

async function main(): Promise<void> {
  const root = findProjectRoot();
  const dbPath = process.env.ARENA_DB_PATH ?? path.join(root, 'outputs', 'arena.db');
  initDb(dbPath);
  const sqlite = getDb();

  const rows = sqlite.prepare('SELECT id, url, secret FROM webhooks').all() as WebhookRow[];
  if (rows.length === 0) {
    console.log('No webhooks rows found; nothing to migrate.');
    closeDb();
    return;
  }

  console.log(`Scanning ${rows.length} webhook(s). Mode: ${DRY_RUN ? 'DRY-RUN (set ARENA_MIGRATE_WEBHOOK_SECRETS=true to write)' : 'WRITE'}.`);

  let encrypted = 0;
  let alreadyEncrypted = 0;
  let empty = 0;
  const update = sqlite.prepare('UPDATE webhooks SET secret = ? WHERE id = ?');

  // Wrap writes + reads in a transaction for atomicity. better-sqlite3 runs
  // transactions synchronously on the event loop — no partial state on crash.
  const migrate = sqlite.transaction((row: WebhookRow): 'encrypted' | 'already' | 'empty' => {
    const stored = row.secret;
    if (stored == null || stored === '') {
      empty++;
      return 'empty';
    }
    if (stored.startsWith(VERSION_PREFIX)) {
      alreadyEncrypted++;
      return 'already';
    }
    // Legacy plaintext — round-trip through decrypt to confirm the value
    // reads back cleanly (it returns plaintext as-is), then re-encrypt.
    // This guards against accidentally double-encrypting a value that the
    // decrypt fallback already handles as ciphertext.
    const plaintext = decryptWebhookSecret(stored); // returns plaintext as-is
    const encryptedSecret = encryptWebhookSecret(plaintext);
    if (DRY_RUN) {
      console.log(`  [dry-run] webhook id=${row.id} url=${row.url} would be re-encrypted (plaintext len=${stored.length}).`);
      return 'encrypted';
    }
    update.run(encryptedSecret, row.id);
    console.log(`  [write]    webhook id=${row.id} url=${row.url} re-encrypted.`);
    return 'encrypted';
  });

  for (const row of rows) {
    const r = migrate(row);
    if (r === 'encrypted') encrypted++;
  }

  console.log(
    `\nDone. encrypted=${encrypted} alreadyEncrypted=${alreadyEncrypted} empty=${empty} total=${rows.length}` +
    (DRY_RUN ? ' (DRY-RUN — no rows were written)' : '.'),
  );
  closeDb();
}

main().catch((err) => {
  console.error('Webhook secret migration failed:', err);
  try { closeDb(); } catch { /* already closed */ }
  process.exit(1);
});
