#!/usr/bin/env bash
set -euo pipefail

echo "=== Starting minikube ==="
minikube start --memory=4096 --cpus=2

echo "=== Installing KEDA ==="
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm upgrade --install keda kedacore/keda -n keda --create-namespace

echo "=== Checking gVisor availability ==="
if minikube ssh "which runsc" 2>/dev/null; then
  echo "gVisor available, creating RuntimeClass"
  kubectl apply -f k8s/runtimeclass-gvisor.yaml
else
  echo "gVisor not available — runners will use seccomp RuntimeDefault"
fi

echo "=== Building container image ==="
eval "$(minikube docker-env)"
docker build -t ai-arena/runner:latest .

echo "=== Bootstrap complete ==="
echo "Next: run scripts/k8s/deploy.sh to apply manifests"
