# SDD Progress Ledger

## Baseline
- Task 0.1: complete (commits e182d1a..9f18375). Pre-existing red baseline fixed: duplicate 0009 migration removed; 0010 adds run_models claimed_at/started_at/completed_at/runner_id; custom.ts FK cascade; shell-secrets pattern ordering. Full suite 337 tests green; coverage gate 47.4/31.8/82.7 passes.

## Minor findings (for final review)
- shell-secrets generic_api_key `[A-Za-z0-9-_]{20,64}` is over-broad (redacts ordinary long words/base64).

- Task 1.1: complete (commits 9f18375..507e762, review clean)
- Minor (1.1): artifact-manifest validatedBy/validatedAt now orphaned, quarantined always false — optional slim follow-up.

- Task 1.2: complete (commits 507e762..1c64d6f, review clean)
- Important (1.2→2.5): taskCounter/taskDuration only on happy path; loop-crash & missing-key exits emit no stats (status failed undercounts). Fix in Task 2.5.
- Minor (1.2): no result.json on loop crash (catch nacks silently); missing-key early exit hardcodes maxTurns 0 & skips conv.setEnded; guard checks resolved.envVar but adapter uses descriptor.envVar; computeCost/git init/commitFinal unguarded; report catch{} silent; stale worker.ts comments at db/model-resolver.ts:6, logger/pino-logger.ts:31, cli.ts:50.

- Task 1.3: complete (commits 1c64d6f..01c37e3, review clean after 2 fix rounds: config-hash test dropped, README logs clean, backfill computeTaskId inlined)
- Minor (1.3): pm2-helpers.ts still exports no-op pm2Start/pm2Connect (defer PM2 purge); RunIndexModelEntry logFile residue.

- Task 1.4: complete (commits 01c37e3..42d870f, review clean)

- Task 1.5: complete (commits 42d870f..3b72d27, review clean)
- Harness bug found: `tests/**/*.test.ts` bash glob (no globstar) misses 2-level test dirs (tests/providers/adapters etc.) → fix glob in Task 5.1.
- Minor (1.5): vestigial stream:boolean in openai/anthropic buildBody; SendOpts.reasoning type still allows type:"effort" (dead) — clean in Task 3.4.

- Task 2.1: complete (commits 3b72d27..a4dffde, review clean)

- Task 2.2: complete (see task-2.2-report.md; commit a4dffde..HEAD)
- Note (2.2): at top level `judge` is optional in the schema, so a missing config file parses to `{}` (judge undefined), NOT enabled=true default — test asserts real behavior.

- Task 2.2: complete (commits a4dffde..39af253, review clean)

- Task 2.3: complete (commits 39af253..52d5826, review clean)
- Minor (2.3): per-(model,scenario) notification emit (N per suite) — batching follow-up; regressionSummary duplicated slack/discord; findProjectRoot() vs aiArenaRoot() divergence.

- Task 2.4: complete (commits 52d5826..ecd4bfb, review clean)

- Task 2.5: complete (commits ecd4bfb..0912a7f, review clean after fix: taskCounted guard)
- Minor (2.5): arena_queue_depth meaning differs (in-memory=backlog, redis=xlen incl in-flight); reclaim-op not reflected; no regression test for tail-throw (recommended follow-up).

- Task 2.6: complete (commits 0912a7f..b3018e2, review clean)
- Minor (2.6): yaml hand-edits not mirrored to DB (insert-only sync); DELETE handler no catch; brief schedule-input name inconsistency (impl matches code).

- Task 2.7: complete (commits b3018e2..f9019cc, review clean after fix: single addSpend credit + 3 test hardening asserts). Phase 2 complete.
- Minor (2.7): ledger pricingVersion now null on CLI path (was getLatestPricingVersion) — data-quality note; test 5 depends on 50ms drain of addSpend chain (could flake if addSpend becomes awaited).

- Task 3.1: complete (commits f9019cc..8dea8d9, review clean)
- Minor (3.1): .c8 list has leftover explicit locked-write line 6 (file deleted in 1.1) now overlapping tests/fs/*.test.ts glob — fix in 5.1; list_files non-recursive cap now post-sort slice.

- Task 3.2: complete (commits 8dea8d9..e75e8ce, review clean). Coverage gate fixed via 4cd17f4 (c8 list expanded) BEFORE review.
- Minor (3.2): listSessionsWithCounts 4 queries/page (not 3); PG risk funneled to 4.1 (transitionTaskState needs run_models columns there).

- Task 3.3: complete (commits e75e8ce..5f2a636; direct-execution session)
- Task 3.6: complete (commit 33d31d5). Catalog wiring: client useCatalogModels→/api/catalog/models (+q filter in listCatalogModels/catalog route), detail→/api/catalog/models/:id, pricing→/api/catalog/pricing; models.ts stays {models} config shape; POST/DELETE now return {models} list (were {ok:true}, breaking client upsert/delete).
- Task 3.9: complete (commit e3b8743). Shared ws-auth.ts verifyWsRequest (protocol + optional query-token); live.ts/stream.ts use it; analytics /cost now aggregates cost_ledger+run_models (no result-file reads, PG-safe), shape {leaderboard} preserved; routes/cost.ts deleted (+both mounts). Roles dedupe step SKIPPED: users.ts has per-user /:id/roles; global /api/roles inline is the only handler — no duplicate existed, restructuring risked breaking the client.
- Task 3.4: complete (commit 0c81921). BaseAdapter.post() shared JSON POST (content-type+timeout) in adapters/base.ts; openai-compat/anthropic/google/bedrock gateway rewired; bedrock sigv4 path untouched (separate fetch); SSE dedupe moot (streaming removed in Phase 2).
- Task 3.5: complete (commit 96a0f11, earlier session)
- Task 4.1: complete (commit 41ab1c3). schema-pg parity: run_models claimed_at/started_at/completed_at/runner_id + provider_versions + tool_call_stats; drizzle/pg/0002_low_zuras.sql generated+applied.
- Task 4.2: complete (d61ea0b): cost summary substr(recorded_at,1,10) (SQLite date() was the only PG-breaking raw idiom); postgres.ts dead INSERT OR IGNORE rewrite removed.
- Task 4.3: complete (d61ea0b): tests/db/postgres-smoke.test.ts (migrate+round-trip+raw SQL) gates PG; test:db-pg script = migrate + smoke only (SQLite-written db suite NOT PG-portable — known, don't run whole suite under PG). Smoke test made idempotent (unique run/schedule ids per run; cost_ledger FK requires runs row — both dialects enforce it).
- Task 4.4: complete (d61ea0b): CI job boots postgres:16 + runs test:db-pg before client build.
- Task 5.1: complete (commit ec87515). .c8-test-list.txt: globs→explicit files (63 entries, +8 newly covered incl. silent-failure/finalize-merge/budget-integration); coverage gate green (67.88/75.08/58.5 ≥ 45/75/30); README truth: 4 adapter families, 26 route modules, worker.ts line removed; dead-code grep (sendMessageStream/MCP_TOOLS/spawnRunWorkers/queryTable/lockFile/createFallbackRouter/probeProviderHealth/signArtifacts) → zero hits. Final sweep: typecheck clean, lint 96w/0e, 355/359 tests, coverage gate green, test:db 49+2skipped, test:db-pg 2/2 against live Postgres.
