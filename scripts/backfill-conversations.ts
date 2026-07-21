import fs from 'node:fs';
import path from 'node:path';
import { initDb, getDb, closeDb } from '../src/db/client.js';
import { createSessionStore } from '../src/session/store.js';
import { computeTaskId } from '../src/runner/idempotency.js';

function findConversationFiles(root: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'files' && e.name !== 'pm2-logs' && e.name !== 'comparisons') {
        walk(full);
      } else if (e.isFile() && e.name === 'conversation.json') {
        results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

async function main() {
  if (process.env.ARENA_BACKFILL_CONVERSATIONS !== 'true') {
    console.error('Set ARENA_BACKFILL_CONVERSATIONS=true to run the backfill.');
    process.exit(1);
  }

  const root = process.env.OUTPUT_ROOT ?? path.join(process.cwd(), 'outputs');
  const dbPath = process.env.ARENA_DB_PATH ?? path.join(root, 'arena.db');
  initDb(dbPath);
  const store = createSessionStore();
  let count = 0;

  for (const file of findConversationFiles(root)) {
    try {
      const conv = JSON.parse(fs.readFileSync(file, 'utf8'));
      const runId = path.basename(path.dirname(file));
      const model = path.basename(path.dirname(path.dirname(file)));
      const sessionId = computeTaskId({ promptId: conv.promptId ?? 'legacy', promptVersion: conv.promptVersion ?? 0, model, configHash: 'legacy', runId });

      const existing = await store.listMessages(sessionId);
      if (existing.length > 0) continue;

      const entries = conv.entries ?? [];
      for (const entry of entries) {
        if (entry.role) {
          await store.appendMessage(sessionId, {
            id: crypto.randomUUID() as string,
            sessionId,
            turn: entry.turn ?? 0,
            role: entry.role,
            content: entry.content ?? null,
            toolCalls: entry.toolCalls ? JSON.stringify(entry.toolCalls) : null,
            toolCallId: entry.toolCallId ?? null,
            tokenInput: entry.usage?.prompt ?? null,
            tokenOutput: entry.usage?.completion ?? null,
            createdAt: entry.timestamp ?? new Date().toISOString(),
          });
        }
      }
      count++;
    } catch {
      // skip corrupted files
    }
  }
  console.log(`Backfilled ${count} conversations.`);
  closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
