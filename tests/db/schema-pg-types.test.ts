import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../../src/db/schema-pg.js';
import type {
  DbProvider,
  DbProviderVersion,
  DbModel,
  DbModelProvider,
  DbPricing,
  DbPricingSnapshot,
  DbBenchmark,
  DbModelRuntimeStat,
  DbCatalogCacheState,
  DbAnomaly,
  DbWebhook,
  DbRun,
  DbCostLedgerEntry,
  DbRunModel,
  DbSession,
  DbMessage,
  DbModelCall,
  DbUser,
  DbRole,
  DbUserRole,
  DbAuditLogEntry,
  DbFile,
  DbPrompt,
  DbPromptVersion,
  DbOutputMapping,
  DbSchedule,
  DbToolCallStat,
} from '../../src/db/schema-pg.js';

test('schema-pg exports Db* InferSelectModel types (compile-time check)', () => {
  const checks: unknown[] = [
    null as unknown as DbProvider,
    null as unknown as DbProviderVersion,
    null as unknown as DbModel,
    null as unknown as DbModelProvider,
    null as unknown as DbPricing,
    null as unknown as DbPricingSnapshot,
    null as unknown as DbBenchmark,
    null as unknown as DbModelRuntimeStat,
    null as unknown as DbCatalogCacheState,
    null as unknown as DbAnomaly,
    null as unknown as DbWebhook,
    null as unknown as DbRun,
    null as unknown as DbCostLedgerEntry,
    null as unknown as DbRunModel,
    null as unknown as DbSession,
    null as unknown as DbMessage,
    null as unknown as DbModelCall,
    null as unknown as DbUser,
    null as unknown as DbRole,
    null as unknown as DbUserRole,
    null as unknown as DbAuditLogEntry,
    null as unknown as DbFile,
    null as unknown as DbPrompt,
    null as unknown as DbPromptVersion,
    null as unknown as DbOutputMapping,
    null as unknown as DbSchedule,
    null as unknown as DbToolCallStat,
  ];
  assert.equal(checks.length, 27);
  assert.ok(schema.runs);
  assert.equal(typeof schema.runs, 'object');
});
