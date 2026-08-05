#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

if [ "${1:-}" != "--yes" ]; then
  echo "Refusing to restore: pass --yes to overwrite cluster data with backups."
  exit 1
fi

NS="${NS:-ai-arena}"
BACKUP_DIR="${BACKUP_DIR:-backups}"

# SC2012: backup filenames are machine-generated (postgres-<TS>.sql etc. from
# backup-*.sh) with a strict alphanumeric pattern, so ls -t is safe and the
# find -printf alternative is not portable (BSD find).
# shellcheck disable=SC2012
PG_DUMP="$(ls -t "$BACKUP_DIR"/postgres-*.sql 2>/dev/null | head -1 || true)"
# shellcheck disable=SC2012
REDIS_RDB="$(ls -t "$BACKUP_DIR"/redis-*.rdb 2>/dev/null | head -1 || true)"
# shellcheck disable=SC2012
OUTPUTS_TAR="$(ls -t "$BACKUP_DIR"/outputs-*.tar.gz 2>/dev/null | head -1 || true)"

echo "=== Restore drill (namespace $NS, from $BACKUP_DIR) ==="
echo "  Postgres: ${PG_DUMP:-none}"
echo "  Redis:    ${REDIS_RDB:-none}"
echo "  Outputs:  ${OUTPUTS_TAR:-none}"

if [ -z "$PG_DUMP" ] && [ -z "$REDIS_RDB" ] && [ -z "$OUTPUTS_TAR" ]; then
  echo "No backups found in $BACKUP_DIR — nothing to restore."
  exit 1
fi

if [ -n "$PG_DUMP" ]; then
  echo "=== Restoring Postgres from $PG_DUMP ==="
  kubectl -n "$NS" exec -i statefulset/postgres -- \
    psql -U arena -d arena -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
  kubectl -n "$NS" exec -i statefulset/postgres -- \
    psql -U arena -d arena -v ON_ERROR_STOP=1 -q -f - < "$PG_DUMP"
  echo "  Postgres restored."
fi

if [ -n "$REDIS_RDB" ]; then
  echo "=== Restoring Redis from $REDIS_RDB ==="
  kubectl -n "$NS" cp "$REDIS_RDB" "deploy/redis:/data/dump.rdb"
  kubectl -n "$NS" exec deploy/redis -- redis-cli SHUTDOWN NOSAVE >/dev/null 2>&1 || true
  kubectl -n "$NS" rollout status deploy/redis --timeout=120s
  echo "  Redis restored (pod restarted, RDB reloaded)."
fi

if [ -n "$OUTPUTS_TAR" ]; then
  echo "=== Restoring outputs from $OUTPUTS_TAR ==="
  kubectl -n "$NS" exec -i deploy/runner-openai-compat -- \
    tar xzf - -C /var/arena/outputs < "$OUTPUTS_TAR"
  echo "  Outputs restored."
fi

echo "=== Restore drill complete ==="
