#!/usr/bin/env bash
# scripts/k8s/deploy-observability.sh — Tempo, Prometheus, Loki, Grafana from static manifests
set -euo pipefail

NS=observability
DIR="$(cd "$(dirname "$0")/../.." && pwd)/k8s/observability"

echo "=== Applying observability manifests (namespace first) ==="
kubectl apply -f "$DIR/namespace.yaml"
kubectl apply \
  -f "$DIR/collector.yaml" \
  -f "$DIR/grafana-auth.yaml" \
  -f "$DIR/grafana-dashboards.yaml" \
  -f "$DIR/grafana-datasources.yaml" \
  -f "$DIR/grafana.yaml" \
  -f "$DIR/loki.yaml" \
  -f "$DIR/prometheus-rbac.yaml" \
  -f "$DIR/prometheus-token-secret.yaml" \
  -f "$DIR/prometheus.yaml" \
  -f "$DIR/promtail.yaml" \
  -f "$DIR/tempo.yaml"

echo "=== Waiting for rollouts ==="
kubectl -n "$NS" rollout status deploy/grafana --timeout=120s

echo "=== Access ==="
echo "  Grafana admin: $(kubectl -n "$NS" get secret grafana-auth -o jsonpath='{.data.username}' | base64 -d) / $(kubectl -n "$NS" get secret grafana-auth -o jsonpath='{.data.password}' | base64 -d)"
echo "  Port-forward:  kubectl -n $NS port-forward deploy/grafana 3000:3000"
echo ""
echo "Done. Datasources (Tempo, Prometheus, Loki) are provisioned via grafana-datasources."
