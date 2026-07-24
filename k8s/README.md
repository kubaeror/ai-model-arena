# Kubernetes Deployment

## Layout

```
k8s/
├── argocd/
│   └── ai-arena-app.yaml              # Argo CD Application
├── base/                              # Shared manifests (Kustomize)
│   ├── kustomization.yaml
│   └── (21 manifests)
├── overlays/
│   ├── dev/                           # minikube dev: hostPath PV, imagePullPolicy: Never
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

```bash
# One-time bootstrap
./scripts/k8s/bootstrap.sh

# Create secrets
kubectl -n ai-arena create secret generic dashboard-auth \
  --from-literal=password=change-me \
  --from-literal=jwt-secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
kubectl -n ai-arena create secret generic provider-keys \
  --from-literal=OPENAI_API_KEY=...

# Deploy via kustomize
kubectl apply -k k8s/overlays/dev
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

**Provider API keys** (OpenAI, Anthropic, Google, etc.) are managed via the dashboard
UI under Settings → API Keys, NOT via sealed secrets. See [Secrets Management](#secrets-management) for details.

On first deploy, the `provider-keys` Secret won't exist until keys are set
via the dashboard. Until then, providers requiring API keys will fail.

## Secrets Management

The arena uses a **dual approach** to secrets:

| Category | Secret | Method | Managed By | ArgoCD |
|----------|--------|--------|------------|--------|
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

API keys for LLM providers are set through the dashboard UI. The dashboard pod has RBAC to `get`, `create`, and `patch` **only** the `provider-keys` Secret — no other secrets are accessible.

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
kubectl -n ai-arena logs deploy/runner-openai --tail=50
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
