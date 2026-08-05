# CI/CD Pipeline

This repository ships everything through GitHub Actions and deploys production
exclusively via Argo CD GitOps. CI never touches a production cluster: PRs and
main builds validate and publish to GHCR, and production is promoted by
committing an image tag bump that Argo CD picks up from `main`.

## Pipeline diagram

```
pull request ──▶ pr-checks ────────────────────────────────────────────┐
   (branch)      typecheck · lint · audit · test-backend (coverage)    │
                 test-frontend · k8s-validate (kubeconform)            │
                 k8s-policy (conftest/OPA) · compose-validate          │
                 dockerfile-lint (hadolint) · workflow-lint (actionlint)│
                 CodeQL (PR + main + weekly)                           │
                                                                       ▼
main ──▶ build-deploy ────────────────────────────────────────────┐  must pass
   (push)  typecheck · lint · test:coverage                        │
           PG parity gate (migrations vs postgres:16.8)             │
           client typecheck/test · build                            │
           multi-arch build+push (amd64+arm64, provenance+SBOM)     │
           CycloneDX SBOM artifact · Trivy (HIGH/CRITICAL gate)     │
           compose smoke · cosign keyless sign · SLSA attestation  ┘
                                                                       ▼
tag v* ──▶ release ───────────────────────────────────────────────────┐
   (push)  same checks · build+push :vX.Y.Z + :latest                 │
           GitHub release + notes (gh release create --generate-notes)│
           SBOM + SLSA attestation attached to release                │
           promote: bump newTag in k8s/overlays/prod ────────────────┤
                                                                       ▼
                                                    push to main ──▶ Argo CD
                                              (k8s/argocd/ai-arena-app.yaml,
                                               selfHeal, prune:false)
                                                     syncs k8s/overlays/prod
                                                     into the ai-arena ns
```

Workflow files: `.github/workflows/` — `pr-checks.yaml`, `build-deploy.yaml`,
`release.yaml`, `nightly.yaml`, `codeql.yml`.

## Release runbook

```bash
git tag v1.2.3
git push origin v1.2.3
```

What happens next:

1. `release.yaml` triggers on `push` of tags matching `v*` (concurrency group
   `release-<tag>`, no cancellation). It runs typecheck, lint, and
   `test:coverage`, then builds and pushes the multi-arch image as
   `ghcr.io/<owner>/ai-model-arena:v1.2.3` and `:latest`.
2. A CycloneDX SBOM is generated (`anchore/sbom-action`) and uploaded as a
   workflow artifact; Trivy gates on HIGH/CRITICAL findings (`exit-code: 1`,
   `ignore-unfixed: true`).
3. The image is signed keyless with Cosign via GitHub OIDC
   (`COSIGN_EXPERIMENTAL=1`), and the SLSA generator
   (`slsa-framework/slsa-github-generator`, `generator_container_slsa3.yml`)
   publishes a provenance attestation to the registry.
4. A GitHub release is created with `gh release create --generate-notes`;
   the SBOM and the SLSA attestation (`attestation.jsonl`, pulled back from
   the registry) are uploaded as release assets.
5. Promotion: the workflow checks the tag commit is an ancestor of
   `origin/main` (otherwise it refuses and fails), rewrites
   `images[].newTag` in `k8s/overlays/prod/kustomization.yaml` to the release
   SHA, commits `ci: promote v1.2.3 image to prod`, and pushes to `main`.
6. Argo CD's automated sync (below) rolls the new image out to the
   `ai-arena` namespace.

Verification:

```bash
# Release exists with assets
gh release view v1.2.3

# Image + signature/attestation in the registry
cosign verify --certificate-identity-regexp 'https://github.com/.*/.github/workflows/release.yaml' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/<owner>/ai-model-arena:v1.2.3

# Prod overlay now points at the release commit
kubectl kustomize k8s/overlays/prod | grep newTag   # or read k8s/overlays/prod/kustomization.yaml

# Argo CD app synced (if argocd CLI is configured)
argocd app get ai-arena            # Sync status = Synced, Healthy
argocd app sync ai-arena           # manual sync if auto-sync is ever disabled
```

## How Argo CD syncs production

`k8s/argocd/ai-arena-app.yaml` defines the app:

- **source**: `https://github.com/kubaeror/ai-model-arena`, `targetRevision:
  main`, `path: k8s/overlays/prod`
- **destination**: the in-cluster server (`https://kubernetes.default.svc`),
  namespace `ai-arena`
- **syncPolicy.automated**: `prune: false`, `selfHeal: true`, with
  `CreateNamespace=true` as a sync option

`selfHeal: true` means Argo CD continuously diffs the live cluster against
`k8s/overlays/prod` rendered from `main` and reverts any drift. `prune: false`
means resources that disappear from the overlay are never deleted — safer for
the postgres StatefulSet and the outputs PVC, whose data must survive overlay
edits. Because `prune` is off, leftover resources require manual cleanup.

When the release workflow pushes the `newTag` bump to `main`, Argo CD detects
the new manifest set, syncs it (pods roll with `imagePullPolicy:
IfNotPresent` + pinned tags, and the db-migrate init containers run
migrations), and reports the app as Synced/Healthy. Nothing in CI has cluster
credentials — deployment is purely GitOps.

## Nightly runs

`nightly.yaml` runs on schedule (`0 2 * * *`) and via `workflow_dispatch`.
Two jobs:

1. **full-e2e** — the full suite: `npm run typecheck`, `npm run lint`,
   `npm run test:coverage`, the Postgres migration parity gate (`npm run
   test:db-pg` against a `postgres:16.8-alpine` container), client
   typecheck + tests, `npm run build`, stub agent-loop smoke
   (`scripts/smoke-stub.mjs`), trace smoke (`scripts/trace-smoke-test.mjs`),
   `docker build`, and a docker-compose smoke against `/health`.
2. **cluster-e2e** — boots a real kind cluster (`kindest/node:v1.30.0`),
   installs KEDA from the helm chart (required for the
   `ScaledObject`/`TriggerAuthentication` CRs), applies the `k8s/overlays/e2e`
   overlay, waits for all rollouts (postgres, redis, the three runner
   deployments, dashboard), then smokes: dashboard `/health` via
   port-forward, runner readiness file, redis consumer-group state, and
   scaledobject presence. On failure it exports kind logs as a 7-day
   artifact.

Note: nightly has no flake-retry / double-run step — a flaky job fails the
nightly run (last commit `ci: nightly kind cluster e2e`).

## Local validation commands

Everything below is verified to run from a clean checkout (Node >= 22, docker,
kubectl/kustomize). None of it needs a cluster.

```bash
# TypeScript: typecheck, lint, tests with coverage gate
npm ci
npm run typecheck
npm run lint
npm run test:coverage

# GitHub Actions workflows (actionlint)
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest

# Kustomize: render all five roots (base, dev, e2e, prod, observability)
for d in k8s/base k8s/overlays/dev k8s/overlays/e2e k8s/overlays/prod k8s/observability; do
  kubectl kustomize "$d" >/dev/null || exit 1
done

# Schema validation (kubeconform) — needs the CRDs catalog for KEDA resources
mkdir -p /tmp/k8s-render && kubectl kustomize k8s/overlays/prod > /tmp/k8s-render/prod.yaml
docker run --rm -v /tmp/k8s-render:/render ghcr.io/yannh/kubeconform:latest \
  -summary -schema-location default \
  -schema-location https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json \
  /render/prod.yaml

# OPA policy checks (conftest) — .conftest.yaml pins policy/k8s + kubernetes input
docker run --rm -v "$PWD:/workspace" -w /workspace -v /tmp/k8s-render:/render \
  openpolicyagent/conftest:latest test -p policy/k8s /render/prod.yaml

# Dockerfile lint (hadolint)
docker run --rm -v "$PWD:/repo" -w /repo hadolint/hadolint:latest hadolint Dockerfile

# Docker compose config
docker compose config -q
```

`shellcheck`, `yamllint`, and `markdownlint` are **not** configured in this
repo (no config files, no CI jobs), so no commands for them are provided here.

## Required repository settings

These are manual, org/repo-level settings that the pipeline depends on:

1. **Branch protection on `main`**: require status checks to pass — at least
   `pr-checks` (the workflow-level check covering all its jobs). This is what
   forces every PR through the gate in the diagram. Require linear history or
   squash merges if preferred.
2. **Tag protection for `v*`**: a ruleset (Settings → Rules → Rulesets)
   protecting `v*` tags — only the release workflow (via `GITHUB_TOKEN`) and
   maintainers can create them; protected tags cannot be deleted or
   force-pushed.
3. **Argo CD repo access**: Argo CD must be able to read
   `github.com/kubaeror/ai-model-arena`. Wire the repo in the Argo CD
   settings with `contents: read`-scoped credentials (a GitHub App or PAT;
   if Argo CD is already app-of-apps, register this repo alongside the
   existing ones). Write access is never needed — Argo CD only reads; the
   release workflow does the promotion push with its own `GITHUB_TOKEN`.
