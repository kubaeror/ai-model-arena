# Kubernetes Deployment (minikube)

## Platform Notes

- **Target:** local minikube (single-node). HA/failover not testable here.
- **gVisor:** only on Linux minikube with `--container-runtime=containerd`. On Windows minikube, runners fall back to seccomp `RuntimeDefault` — remove `runtimeClassName: gvisor` from pod specs.
- **RWX PVC:** uses `hostPath` — works on single-node minikube only. Production needs NFS/CephFS.
- **Storage:** PVCs use default `gp2`/`standard` StorageClass. Adjust for your minikube driver.

## Prerequisites

```bash
minikube start --memory=4096 --cpus=2
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm upgrade --install keda kedacore/keda -n keda --create-namespace
```

## Deploy

```bash
# Apply infra
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres.yaml -f k8s/redis.yaml -f k8s/output-pvc.yaml
kubectl -n ai-arena wait --for=condition=ready pod -l app=postgres --timeout=120s
kubectl -n ai-arena wait --for=condition=ready pod -l app=redis --timeout=60s

# Create secrets
kubectl -n ai-arena create secret generic dashboard-auth \
  --from-literal=password=change-me \
  --from-literal=jwt-secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
# kubectl -n ai-arena create secret generic provider-keys --from-literal=OPENAI_API_KEY=...

# Build image
eval "$(minikube docker-env)"
docker build -t ai-arena/runner:latest .

# Apply apps
kubectl apply -f k8s/runner-configmap.yaml
kubectl apply -f k8s/runner-deployment.yaml
kubectl apply -f k8s/keda-scaledobject.yaml
kubectl apply -f k8s/dashboard-deployment.yaml
kubectl apply -f k8s/dashboard-service.yaml
```

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
kubectl -n ai-arena exec deploy/redis -- redis-cli PING
```

## Teardown

```bash
kubectl delete namespace ai-arena
```
