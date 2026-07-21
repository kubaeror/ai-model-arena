#!/usr/bin/env bash
set -euo pipefail
echo "=== Restore drill ==="
echo "Target: local minikube scratch namespace"
echo "Drill not fully automated — validate backups/ directory has recent dumps."
BACKUPS=$(ls backups/postgres-*.sql 2>/dev/null | wc -l)
echo "Found ${BACKUPS} Postgres backup(s)."
echo "Drill requires manual verification in a scratch namespace."
