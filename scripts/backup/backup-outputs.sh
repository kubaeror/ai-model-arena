#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
kubectl -n ai-arena exec deploy/runner-openai -- tar czf - -C /var/arena/outputs . > "backups/outputs-${TS}.tar.gz"
echo "Backed up to backups/outputs-${TS}.tar.gz"
