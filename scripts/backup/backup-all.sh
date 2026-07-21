#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=== Backing up Postgres ==="
bash "$DIR/backup-postgres.sh"
echo "=== Backing up Redis ==="
bash "$DIR/backup-redis.sh"
echo "=== Backing up Outputs ==="
bash "$DIR/backup-outputs.sh"
echo "=== Backup complete ==="
