# Kubernetes Deployment

## Layout

```text
k8s/
├── argocd/
│   └── ai-arena-app.yaml              # Argo CD Application
├── base/                              # Shared manifests (Kustomize)
│   ├── kustomization.yaml
│   └── (22 manifests)
├── overlays/
│   ├── dev/                           # minikube dev: hostPath PV, imagePullPolicy: IfNotPresent
│   │   ├── kustomization.yaml
│   │   └── dev-pv.yaml
│   └── prod/                          # GHCR images, EFS StorageClass
│       └── kustomization.yaml
└── observability/                     # Separate namespace
```

## Platform Notes

- **Dev:** local minikube (single-node). HA/failover not testable here.
- **gVisor:** only on Linux minikube with `--container-runtime=containerd`. On Windows minikube, runners fall back to seccomp `RuntimeDefault` — remove `runtimeClassName: gvisor` from pod specs.
- **RWX PVC (dev):** uses `hostPath` — works on single-node minikube only. Production overlay uses `efs-sc` StorageClass.
- **Storage:** PVCs use default StorageClass. Adjust for your minikube driver.

## Deploy

### Dev (minikube)

Order matters on a fresh cluster: `deploy.sh` applies the manifests (including
the `ai-arena` namespace), but pods read their Secrets at boot — create the
namespace and the dev Secrets first. The dev overlay ships
`k8s/base/arena-secrets-sealed.yaml`, which is sealed with the **production**
cluster key and cannot be decrypted by a minikube Sealed Secrets controller;
`k8s/overlays/e2e/secrets.yaml` is the plain-Secret template for dev
(throwaway credentials mirroring docker-compose.yml — never reuse them outside
dev).

```bash
# 1. One-time bootstrap: minikube, Sealed Secrets controller, KEDA, image
./scripts/k8s/bootstrap.sh

# 2. Namespace must exist before its Secrets (deploy.sh applies it too, but
#    pods would then boot without Secrets and fail)
kubectl apply -f k8s/base/namespace.yaml

# 3. Plain dev Secrets — apply the template directly, or copy its values into
#    kubectl create secret commands
kubectl apply -f k8s/overlays/e2e/secrets.yaml

# 4. Apply the dev overlay and wait for rollouts (also deploys observability)
./scripts/k8s/deploy.sh
```

Required Secrets (dev values live in `k8s/overlays/e2e/secrets.yaml`):

| Secret | Keys | Used by |
| --- | --- | --- |
| `arena-db-auth` | `DATABASE_URL`, `DB_DRIVER`, `REDIS_URL`, `REDIS_PASSWORD` | dashboard/runner/scheduler `envFrom`, redis, KEDA trigger auth |
| `postgres-auth` | `username`, `password` | postgres StatefulSet |
| `dashboard-auth` | `password`, `jwt-secret`, `metrics-token` | dashboard login/JWT + Prometheus scrape |
| `webhook-secret` | `key` (64 hex chars) | webhook secret encryption (`WEBHOOK_SECRET_KEY`) |
| `provider-keys` | provider key names (`OPENAI_API_KEY`, ...) | runner mounts; created empty by the template |

`provider-keys` may stay empty: its volume is `optional: true` and the
dashboard creates/populates it on first key set. `webhook-secret` and
`dashboard-auth` are required for a fully functional dashboard. After
`deploy.sh` creates the `observability` namespace, mirror the metrics token so
Prometheus bearer-token scrapes authenticate:

```bash
kubectl -n observability create secret generic metrics-token \
  --from-literal=token=$(kubectl -n ai-arena get secret dashboard-auth -o jsonpath='{.data.metrics-token}' | base64 -d) \
  --dry-run=client -o yaml | kubectl apply -f -
```

> **NetworkPolicy:** `deny-all-ingress` in `k8s/base/network-policies.yaml`
> defaults egress to DNS-only. On policy-enforcing CNIs (Calico/Cilium) the
> dashboard additionally needs egress to the kube-apiserver to manage
> `provider-keys` (`create`/`patch` Secret) and scale runners (`patch`
> Deployment / `keda.sh` ScaledObject); add an apiserver egress allowance or
> those actions fail. An opt-in manifest is provided at
> `k8s/overlays/prod/network-policy-apiserver-egress.yaml` (not referenced by
> `kustomization.yaml`). Include it when your CNI enforces policy — add it to
> the prod overlay's `resources:` or `kubectl apply -f` it directly — and
> adjust its CIDR to your cluster's apiserver endpoint. minikube's default
> kindnet does not enforce NetworkPolicy, so dev clusters are unaffected.
>
> Note: `WEBHOOK_SECRET_KEY` is marked `optional: true` so the pod can start
> on a fresh cluster where the `webhook-secret` Secret does not exist yet.
> Without it, the dashboard refuses to encrypt/decrypt webhook secrets in
> production (`NODE_ENV=production`) — create the `webhook-secret` above or
> webhook create/delete will fail in every containerized deployment.
> Likewise, `METRICS_TOKEN` is `optional: true`: if `dashboard-auth` has no
> `metrics-token` key, `/metrics` falls back to requiring an admin JWT and
> the Prometheus bearer-token scrape for the dashboard job is disabled.

## Deploy via kustomize

```bash
kubectl apply -k k8s/overlays/dev
# Observability stack (collector, tempo, prometheus, loki, grafana):
kubectl apply -k k8s/observability
# ...or run scripts/k8s/deploy.sh, which does both (and waits for rollouts).
```

### Production (Argo CD)

```bash
# One-time: install Sealed Secrets controller if not already present
# k8s/base/arena-secrets-sealed.yaml requires the controller to decrypt
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/latest/download/controller.yaml

# Create sealed secrets for database credentials (one-time)
# 1. Create a plain secrets file with real values (do NOT commit):
#    kubectl create secret generic arena-db-auth -n ai-arena \
#      --from-literal=DATABASE_URL=postgresql://... \
#      --from-literal=REDIS_URL=redis://... \
#      --dry-run=client -o yaml > arena-db-auth-plain.yaml
#    kubectl create secret generic postgres-auth -n ai-arena \
#      --from-literal=username=arena --from-literal=password=... \
#      --dry-run=client -o yaml > postgres-auth-plain.yaml
# 2. Seal them:
#    kubeseal < arena-db-auth-plain.yaml > arena-db-auth-sealed.yaml
#    kubeseal < postgres-auth-plain.yaml > postgres-auth-sealed.yaml
# 3. Replace the PLACEHOLDER values in k8s/base/arena-secrets-sealed.yaml
#    with the sealed output, then commit.

# Apply the sealed infra secrets
kubectl apply -f k8s/base/arena-secrets-sealed.yaml

# Apply Argo CD Application
kubectl apply -f k8s/argocd/ai-arena-app.yaml

# Argo CD syncs from k8s/overlays/prod.
# CI commits the image SHA tag to the prod kustomization.yaml on each push.
```

> **Required re-seal (metrics-token) and webhook-secret.** The committed
> `dashboard-auth` SealedSecret does not contain a `metrics-token` key
> (see the NOTE in `k8s/base/arena-secrets-sealed.yaml`). Its dashboard
> `secretKeyRef` is `optional: true` purely so the pod can boot; until the
> secret is re-sealed, the Prometheus `arena-dashboard` scrape job still
> runs but fails auth — the dashboard falls back to requiring an admin JWT:
>
> ```bash
> kubectl create secret generic dashboard-auth -n ai-arena \
>   --from-literal=password=... --from-literal=jwt-secret=... \
>   --from-literal=metrics-token=$(openssl rand -hex 32) \
>   --dry-run=client -o yaml | kubeseal --format yaml > sealed.yaml
> # replace the dashboard-auth resource in k8s/base/arena-secrets-sealed.yaml
>
> # Mirror the new metrics token into the observability namespace so the
> # Prometheus bearer-token scrape can authenticate (same as the dev block):
> kubectl -n observability create secret generic metrics-token \
>   --from-literal=token=$(kubectl -n ai-arena get secret dashboard-auth -o jsonpath='{.data.metrics-token}' | base64 -d) \
>   --dry-run=client -o yaml | kubectl apply -f -
> ```
>
> A `webhook-secret` (key: `key`) must also be provisioned (sealed or created
> out-of-band). Its `secretKeyRef` is `optional: true` so the pod starts, but
> without it webhook create/delete fails in production.

**Provider API keys** (OpenAI, Anthropic, Google, etc.) are managed via the dashboard
UI under Settings → API Keys, NOT via sealed secrets. See [Secrets Management](#secrets-management) for details.

On first deploy, the `provider-keys` Secret won't exist until keys are set
via the dashboard. The `provider-keys` volume is marked `optional: true` in
the dashboard and all runner Deployments, so pods boot on a fresh cluster
(the dashboard itself would otherwise deadlock waiting for a Secret only it
can create). Until a key is set, providers requiring API keys will fail.

## Secrets Management

The arena uses a **dual approach** to secrets:

| Category | Secret | Method | Managed By | ArgoCD |
| ---------- | -------- | -------- | ------------ | -------- |
| **Infrastructure** | `arena-db-auth` (DB/Redis URLs, JWT secret), `postgres-auth` (username, password) | [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) | `kubeseal` CLI → git commit | Yes |
| **Provider API keys** | `provider-keys` (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) | Dashboard → k8s API directly | Dashboard UI (Settings → API Keys) | No |

### Infra secrets (Sealed Secrets)

Encrypted at rest in git, decrypted at deploy time by the Sealed Secrets controller running in `kube-system`. The controller watches for `SealedSecret` resources and creates plain `Secret` objects.

These are consumed via `envFrom.secretRef` in all workloads (dashboard, runners, scheduler).

**Rotating infra secrets**:

1. Update the plain secret values on the cluster
2. Re-seal with `kubeseal`
3. Commit the updated `arena-secrets-sealed.yaml`
4. ArgoCD syncs — pods restart to pick up new env vars

### Provider API keys (Dashboard-managed)

API keys for LLM providers are set through the dashboard UI. The dashboard pod has RBAC to `create` and `patch` **only** the `provider-keys` Secret — it cannot read any Secret, so listing falls back to the env-based store (`SecretStore`) on a 403. No other secrets are accessible.

Runners mount the Secret as files at `/etc/arena/secrets/` (not `envFrom`), so kubelet auto-refreshes them within ~60s of a dashboard update — no pod restart needed. The application's `SecretStore` reads individual key files from this mount point.

This approach keeps API keys out of ArgoCD's GitOps scope, preventing:

- Accidental overwrites from stale git state after a UI edit
- API keys in git history (even encrypted)
- Requiring kubeseal for routine key rotations

## Access

```bash
minikube service dashboard -n ai-arena --url
# or
kubectl -n ai-arena port-forward svc/dashboard 4000:4000
```

## Verify

```bash
kubectl -n ai-arena get pods -w
kubectl -n ai-arena logs deploy/runner-openai-compat --tail=50
kubectl -n ai-arena logs deploy/dashboard -c db-migrate   # check migration init container
kubectl -n ai-arena exec deploy/redis -- redis-cli PING
```

## Render Manifests Locally

```bash
kubectl kustomize k8s/overlays/dev
kubectl kustomize k8s/overlays/prod
```

## Teardown

```bash
kubectl delete namespace ai-arena
```
