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

## Plan: complete-the-arena (branch complete-the-arena, base cf51be6)
- Task 1: baseline gate green (typecheck 0, lint 0, tests 0 fail/4 skip)
- Task 2: complete (commit 339fe5d, review clean)
- Minor (2): queues.ts:36 returns {retried:true} even when deadLetterRetry returns false — fix in T44 queues rework.
- Task 3: complete (commit 37d0974, review clean)
- Task 4: complete (controller-executed comment fix, commit 12e0352, router tests pass)
- Task 5: complete (commit ef43112, review clean/approved)
- Important (5): redis DLQ retry matches stream-entry id while dashboard passes taskId → retry never works on redis DLQ; routes/queues.ts:35 always replies retried:true. FIX IN T44 (also T2 minor: same retried:true lie).
- Minor (5): nack eval-path arg marshaling untested (fake falls back to non-Lua path masking regression); suggested eval-count tripwire assert; deadLetterRetry tripwire test `assert.equal(await q.deadLetterRetry('t1'), false)`.
- Task 6: complete (commit 09ef948, review clean/approved)
- Minor (6): no mid-run budget-failure or onBudgetCheck-throws test; pre-existing double endSpan on api_error path.
- Task 7: complete (commit 5972447, review clean/approved)
- Minor (7): resume marker surfaces in report.md transcript (spec'd behavior); test casts consistent with file pattern.
- Task 8: complete (commits 2e64b9f + fix d1eee01, review approved after fix round)
- Minor (8): backoff tests emit warn-log noise; schedulesPath() dead export.
- Bonus fix in 8: no-arg initDb() defaulted to in-memory DB (silent) — now defaults via dbPath().
- Task 9: complete (controller-executed, commit pending-check, docker compose config -q OK)
- Task 10: complete (commit dfd92e9, review approved)
- Minor (10): ProcStatus/live.ts/Ops.tsx CPU-Mem residual = T43 scope; journal hygiene (dup idx 10, missing snapshots 0008/idx10b-12, pg 0003-0005) = T29 scope.
- Task 11: complete (commit b0deb54, review approved)
- Task 12: complete (commit b9dac07 + guard commit 354a0a6, review approved)
- Minor (12): sibling isRunCompleteByRunId same bug class (live.ts:221 watcher poll) — fold into T43; RunIndexModelEntry union missing claimed/failed/dead states (pre-existing stale).
- Cross-cutting: t.mock.module tests now skip gracefully without --experimental-test-module-mocks (5 sites).
- Task 13: complete (commit 7f610e9, review approved)
- Minor (13): toCsvRow duplicates export.ts escapeCSV — shared src/csv.ts follow-up candidate (record for final review triage).
- Task 14: complete (commit 61ed7b5, controller-verified trivial diff: desc text + dead import removal only)
- Task 15: complete (commits 8159efc metrics-label fix + f328774 happy-path test, review approved)
- Bug fixed in 15: taskDuration.observe lacked model/scenario labels at 4 runner.ts sites.
- Task 16: complete (commit 19ae233, review approved). PHASE 1 COMPLETE.
- Minor (16): e2e tests race on DB-status assert (use waitFor); breaker left open after tests (ordering-dependent); dup setup; helper parse semantics better than brief.
- Follow-up candidate: loop.ts:169-184 swallows adapter errors → breaker never opens on provider failures (fallback only fires on infra errors).
- Task 17: complete (commit 6011881, review approved)
- Note (17): SendOpts.reasoning is union {type,value} NOT plan's {effort,toggle,budget_tokens}; adapters honor it; scenario-config conversion happens in T18.
- Task 18: complete (commit ee6067f, review approved)
- Note (18): instrument-loop.ts wrapper needed opts forwarding (verified necessary); reasoning schema lenient on unknown keys (consistent with existing schemas).
- Task 19: complete (commit b4702da, controller-verified small diff: guarded parse matching openai-compat convention + test)
- Task 20: complete (commit b97c68a, controller-verified)
- Task 21: complete (commit 60e9150, review approved)
- Minor (21): url-validator isBlockedProviderHost duplicates inline loops (drift risk, defensible); allowlist must-contain-{ assertion stricter than brief.
- Task 22: complete (commit 74a2119, review approved)
- Minor (22): no-key providers now show unreachable (honest but unexplained in UI); success-path socket not released (resp.body?.cancel); error embeds full body.
- Task 23: complete (commit ff827d6, controller-verified: clean dead-code removal + 4 tests)
- Task 24: complete (commit 20ec984, review approved)
- Minor (24): path keys not normalized (./ or ../ variants miss); padded keys.
- Task 25: complete (commit c2f5f4a, controller-verified: 39 prefixes added incl. AWS_ collapse; 52-test drift guard)
- Task 26: complete (commit 14aa074, controller-verified)
- Open Minor (pre-existing): aws_secret_key pattern over-redacts git SHAs/digests; tail-leak on 42+ runs — final-review triage candidate.
- Task 27: complete (commit ff4d885, review approved). PHASE 2 COMPLETE.
- Minor (27): un-awaited store.set/delete in tests; platform frozen at construction; stale-line cleanup pre-existing.
- Task 28: complete (commit 023901a, review approved)
- Infra note (28): tests aren't typechecked (tsconfig includes src/** only) — consider tsconfig.test.json in T62.
- Task 29: complete (commit 579b844, review approved)
- Minor (29): pg journal contiguity not guarded by test; 0013_ file-prefix collision noted.
- Task 30: complete (commit 06666fa, controller-verified)
- Task 31: complete (commit a2342ad, review approved). (First dispatch of T31 returned empty — re-dispatched successfully.)
- Task 32: complete (commit 5e88ec8, controller-verified)
- Task 33: complete (commit 7bdc28c, review approved)
- Task 34: complete (commit f811a4d, controller-verified)
- Task 35: complete (commit 0f6e1f8, review approved)
- Note (35): env rename CATALOG_REFRESH_INTERVAL_DAYS→CATALOG_REFRESH_DAYS (plan-mandated); no back-compat fallback (old deployments silently get 30d) — final-review triage.
- Task 36: complete (commit 9dd6895, fixes 2 Important findings on 68b5090; report in task-36-report.md)
- Note (36): insertJudgeScore now upserts on uq_judge_scores_run_model (fresh verdict replaces stale on re-finalize); persistence deduped to single site (run-lifecycle finalize judge step) — runJudgeScoring no longer touches DB; tests: upsert unit test + run-lifecycle integration + runJudgeScoring no-persist assert.
- Task 36: complete (commits 68b5090 + fix 9dd6895; review approved after fix round). Ledger commit 51eb33a reverted + .superpowers/ gitignored (06147ae).
- Minor (36): balanced-brace scan is first-{ → last-} slicing not nesting-aware; dynamic import outside try/catch (mitigated by outer catch).
- Task 37: complete (commits 6f34f7c + fix fa641b0, review approved after fix round)
- Minor (37): stale-day entries linger in file until next save; empty arrays linger; fetchSync resetPricingCache wiring beyond brief (justified).
- Task 38: complete (commit TBD): scenario-scoped buildRunHistory (filter before window), anomaly dedup (uq_anomalies_run_model_type unique index in both schemas + migrations 0015/0008, pre-insert check + onConflictDoNothing), named detector exports, warn logs on insufficient baseline; new tests detectors.test.ts (6σ/1σ latency, 5-repeat loop, 5× cost) + analyze.test.ts (dedup idempotency, scenario filtering). Full suite 589 pass / 0 fail.
- Minor (38): unique (run_id, model, type) dedups multiple latency anomalies for different tools in the same run+model (keeps first) — brief-mandated key; warn logs fire per detector per analyze when history empty (noise at cold start).
