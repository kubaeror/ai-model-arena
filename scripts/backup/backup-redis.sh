#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
kubectl -n ai-arena exec deploy/redis -- redis-cli BGSAVE
sleep 2
kubectl -n ai-arena cp deploy/redis:/data/dump.rdb "backups/redis-${TS}.rdb"
echo "Backed up to backups/redis-${TS}.rdb"
