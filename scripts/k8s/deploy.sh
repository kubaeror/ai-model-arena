#!/usr/bin/env bash
set -euo pipefail

echo "=== Building image ==="
eval "$(minikube docker-env)"
docker build -t ai-arena/runner:latest .

echo "=== Applying infra ==="
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/output-pvc.yaml
kubectl -n ai-arena wait --for=condition=ready pod -l app=postgres --timeout=120s
kubectl -n ai-arena wait --for=condition=ready pod -l app=redis --timeout=60s

echo "=== Applying apps ==="
kubectl apply -f k8s/runner-configmap.yaml
kubectl apply -f k8s/runner-deployment.yaml
kubectl apply -f k8s/keda-scaledobject.yaml
kubectl apply -f k8s/dashboard-deployment.yaml
kubectl apply -f k8s/dashboard-service.yaml

echo "=== Waiting for rollout ==="
kubectl -n ai-arena rollout status deploy/runner-openai --timeout=120s
kubectl -n ai-arena rollout status deploy/dashboard --timeout=120s

echo "=== Dashboard URL ==="
minikube service dashboard -n ai-arena --url

echo "=== Deploy complete ==="
