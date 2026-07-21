#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
kubectl -n ai-arena exec statefulset/postgres -- pg_dump -U arena arena > "backups/postgres-${TS}.sql"
echo "Backed up to backups/postgres-${TS}.sql"
