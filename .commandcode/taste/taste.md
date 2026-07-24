# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# Workflow
See [workflow/taste.md](workflow/taste.md)
# Communication
- When presenting diagnostic results, structure findings as numbered issues with descriptive headings, supporting sub-bullets, and an ordered "What needs fixing" action list. Confidence: 0.75

# Git
- Use conventional commit format with `feat:` prefix, a descriptive summary line, and a bulleted summary of changes in the body. Include `Co-authored-by: CommandCodeBot <noreply@commandcode.ai>` trailer. Confidence: 0.80
- Before committing, always run `git status` and stage only files directly related to the current change — leave unrelated pre-existing modifications unstaged. Confidence: 0.75
- When a `git push` is rejected because the remote has advanced, use `git pull --rebase origin main` to replay local commits on top of upstream rather than creating a merge commit. Confidence: 0.70

# Kubernetes
See [kubernetes/taste.md](kubernetes/taste.md)
# Verification
- Before committing, run `npx tsc --noEmit` for typecheck and `kubectl kustomize` for manifest validation as final verification steps. Confidence: 0.75
- After completing each phase of a multi-phase implementation, run verification checks (typecheck + tests) before moving to the next phase, rather than deferring all verification to the end. Confidence: 0.80

# Refactoring
- When a broad migration (e.g., sync→async, raw SQL→ORM) encounters low-priority files that are manually invoked and infrequently used (not on the hot path), it is acceptable to leave them as-is and document them as known remaining work rather than blocking deployment on their completion. Confidence: 0.65
- When applying the same mechanical transformation across many files (e.g., adding `await` to a newly-async function's call sites), use `sed -i` for bulk edits first, then run typecheck to surface missed cases, and fix the remaining ones individually — rather than editing each file one-by-one. Confidence: 0.70
- When mid-way through a refactoring branch and discovering the blast radius is too large (e.g., async contagion across 80+ call sites in 15 files), immediately abort by reverting with `git checkout` and redirect effort to lower-risk, higher-value files instead of pushing through. Confidence: 0.70
- When changing a function's signature or calling convention (e.g., sync→async, adding/removing parameters), immediately grep all callers across the codebase and tests, update every call site in the same batch of edits, and run typecheck before moving on. Confidence: 0.90
- When migrating a module to a new API or pattern (e.g., synchronous→async, raw SQL→ORM), retain backward-compatible wrapper functions with the original signatures so that downstream consumers can be migrated incrementally rather than requiring a single big-bang change. Confidence: 0.70

# Database
- When a schema mismatch (missing column, missing table) is discovered in a running deployment, fix it immediately via direct DDL (`ALTER TABLE`, `CREATE TABLE`) to unblock the service, AND simultaneously create a proper migration file so the change is reproducible in future deployments rather than living only as an ad-hoc patch. Confidence: 0.75

# Project Structure
- Store implementation plan documents in `docs/plans/{feature-name}.md`. Confidence: 0.60

# Architecture
- Prefers a centralized data-access layer (`db/query.ts`) for shared database queries rather than inlining SQL in route handlers or service files. Uses Drizzle's `sql.raw` for complex dynamic queries (e.g., paginated filtering with variable WHERE clauses) while leveraging Drizzle's cross-driver compatibility, rather than trying to force every query through the typed query builder. Confidence: 0.75

