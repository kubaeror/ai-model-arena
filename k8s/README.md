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
# Create sealed secrets for database credentials (one-time)
# Edit the plain secrets file first with real DB passwords, then seal it:
#   kubeseal --namespace ai-arena < plain.yaml > k8s/base/arena-secrets-sealed.yaml
kubectl apply -f k8s/base/arena-secrets-sealed.yaml

# Apply Argo CD Application
kubectl apply -f k8s/argocd/ai-arena-app.yaml

# Argo CD syncs from k8s/overlays/prod.
# CI commits the image SHA tag to the prod kustomization.yaml on each push.
```

**Provider API keys** (OpenAI, Anthropic, Google, etc.) are managed via the dashboard
UI under Settings → API Keys, NOT via sealed secrets. The dashboard creates and
manages the `provider-keys` Secret directly through the k8s API. ArgoCD does not
revert dashboard-set keys because the Secret is excluded from GitOps management.

On first deploy, the `provider-keys` Secret won't exist until keys are set
via the dashboard. Until then, providers requiring API keys will fail.

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
