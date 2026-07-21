#!/usr/bin/env bash
# scripts/k8s/deploy-observability.sh — Tempo, Prometheus, Loki, Grafana for minikube
set -euo pipefail

NS=observability
echo "=== Deploying Grafana ==="
helm repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
helm repo update
helm upgrade --install grafana grafana/grafana \
  -n "$NS" --create-namespace \
  --set adminPassword=admin \
  --set service.type=NodePort

echo "=== Deploying Tempo (single-node) ==="
helm upgrade --install tempo grafana/tempo \
  -n "$NS" \
  --set tempo.storage.trace.backend=local \
  --set tempo.storage.trace.local.path=/var/tempo/traces

echo "=== Deploying Prometheus ==="
helm upgrade --install prometheus prometheus-community/prometheus \
  -n "$NS" \
  --set server.service.type=NodePort

echo "=== Deploying Loki (single-node) ==="
helm upgrade --install loki grafana/loki \
  -n "$NS" \
  --set loki.auth_enabled=false \
  --set loki.storage.type=filesystem

echo "=== Patching OTel collector to export to Tempo/Prometheus/Loki ==="
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-config
  namespace: observability
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          http:
            endpoint: 0.0.0.0:4318
          grpc:
            endpoint: 0.0.0.0:4317
    exporters:
      otlp/tempo:
        endpoint: tempo.observability:4317
        tls:
          insecure: true
      prometheus:
        endpoint: 0.0.0.0:8889
      loki:
        endpoint: http://loki.observability:3100/loki/api/v1/push
    service:
      pipelines:
        traces:
          receivers: [otlp]
          exporters: [otlp/tempo]
        metrics:
          receivers: [otlp]
          exporters: [prometheus]
        logs:
          receivers: [otlp]
          exporters: [loki]
EOF

kubectl -n observability rollout restart deploy/otel-collector
kubectl -n observability wait --for=condition=ready pod -l app=otel-collector --timeout=60s

echo "=== Grafana admin password ==="
kubectl -n observability get secret grafana -o jsonpath="{.data.admin-password}" | base64 -d
echo ""
echo "=== Access ==="
echo "  Grafana:  minikube service grafana -n observability --url"
echo "  Prometheus: minikube service prometheus-server -n observability --url"
echo ""
echo "Done. Add Tempo, Prometheus, and Loki as datasources in Grafana (http://tempo:3200, http://prometheus-server:9090, http://loki:3100)."
