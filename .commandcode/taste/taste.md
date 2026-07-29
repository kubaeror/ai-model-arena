# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# Workflow
See [workflow/taste.md](workflow/taste.md)
# Communication
- When presenting diagnostic results, structure findings as numbered issues with descriptive headings, supporting sub-bullets, and an ordered "What needs fixing" action list. Confidence: 0.75

# Git
- Use conventional commit format with `feat:` (or `fix:`) prefix, a descriptive summary line, and a bulleted summary of changes in the body. Include `Co-authored-by: CommandCodeBot <noreply@commandcode.ai>` trailer. Confidence: 0.90
- Each commit should address a single logical change ("1 fix 1 commit"). When multiple changes touch the same file and are tightly related, they may be grouped into one commit, but unrelated changes must be committed separately. Confidence: 0.80
- Before committing, always run `git status` and stage only files directly related to the current change — leave unrelated pre-existing modifications unstaged. Confidence: 0.80
- When a `git push` is rejected because the remote has advanced, use `git pull --rebase origin main` to replay local commits on top of upstream rather than creating a merge commit. Confidence: 0.70

# Kubernetes
See [kubernetes/taste.md](kubernetes/taste.md)
# Verification
- Before committing, run `npx tsc --noEmit` for typecheck and `kubectl kustomize` for manifest validation as final verification steps. Confidence: 0.85
- After completing each phase of a multi-phase implementation, run verification checks (typecheck + tests) before moving to the next phase, rather than deferring all verification to the end. Confidence: 0.80

# Refactoring
See [refactoring/taste.md](refactoring/taste.md)
# Database
- When a schema mismatch (missing column, missing table) is discovered in a running deployment, fix it immediately via direct DDL (`ALTER TABLE`, `CREATE TABLE`) to unblock the service, AND simultaneously create a proper migration file so the change is reproducible in future deployments rather than living only as an ad-hoc patch. Confidence: 0.75
- When adding new tracking columns for an existing entity, extend the existing table rather than creating a separate table — column additions are cheaper than join overhead and keep related state co-located. Confidence: 0.70
- Observability/diagnostic state writes (e.g., status transitions, timestamps) should be best-effort: fire-and-forget with `.catch()` logging rather than blocking the primary operation. The DB being temporarily unavailable should never prevent task execution. Confidence: 0.75

# Project Structure
- Store implementation plan documents in `~/.commandcode/plans/{descriptive-name}.md`, not `docs/plans/`. Confidence: 0.80

# Architecture
- Prefers a centralized data-access layer (`db/query.ts`) for shared database queries rather than inlining SQL in route handlers or service files. Uses Drizzle's `sql.raw` for complex dynamic queries (e.g., paginated filtering with variable WHERE clauses) while leveraging Drizzle's cross-driver compatibility, rather than trying to force every query through the typed query builder. Confidence: 0.75

 When adding a new domain capability (admission control, approval workflows, cost forecasting), create a focused single-purpose module in the appropriate package rather than adding to an existing file — each capability gets its own file with a clear name reflecting its responsibility. Confidence: 0.85

