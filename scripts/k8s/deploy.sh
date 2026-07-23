#!/usr/bin/env bash
set -euo pipefail

echo "=== Building image ==="
eval "$(minikube docker-env)"
docker build -t ghcr.io/kubaeror/ai-model-arena-runner:latest .

echo "=== Applying infra via kustomize (dev overlay) ==="
kubectl apply -k k8s/overlays/dev

echo "=== Waiting for rollout ==="
kubectl -n ai-arena wait --for=condition=ready pod -l app=postgres --timeout=120s
kubectl -n ai-arena wait --for=condition=ready pod -l app=redis --timeout=60s
kubectl -n ai-arena rollout status deploy/runner-openai --timeout=120s
kubectl -n ai-arena rollout status deploy/dashboard --timeout=120s

echo "=== Dashboard URL ==="
minikube service dashboard -n ai-arena --url

echo "=== Deploy complete ==="
