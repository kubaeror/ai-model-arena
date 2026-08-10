#!/usr/bin/env bash
set -euo pipefail

echo "=== Building image ==="
eval "$(minikube docker-env)"
docker build -t ghcr.io/kubaeror/ai-model-arena:latest .

echo "=== Applying infra via kustomize (dev overlay) ==="
kubectl apply -k k8s/overlays/dev

echo "=== Deploying observability stack (collector, tempo, prometheus, loki, grafana) ==="
if [ -d "$(dirname "$0")/../../k8s/observability" ]; then
  kubectl apply -k "$(dirname "$0")/../../k8s/observability"
  kubectl -n observability rollout status deploy/otel-collector --timeout=120s || true
  kubectl -n observability rollout status deploy/grafana --timeout=120s || true
else
  echo "k8s/observability not found — skipping observability deploy"
fi

echo "=== Waiting for rollout ==="
kubectl -n ai-arena wait --for=condition=ready pod -l app=postgres --timeout=120s
kubectl -n ai-arena wait --for=condition=ready pod -l app=redis --timeout=60s
kubectl -n ai-arena rollout status deploy/runner-openai-compat --timeout=120s
kubectl -n ai-arena rollout status deploy/dashboard --timeout=120s

echo "=== Dashboard URL ==="
minikube service dashboard -n ai-arena --url

echo "=== Deploy complete ==="
