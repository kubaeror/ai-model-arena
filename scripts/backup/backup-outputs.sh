#!/usr/bin/env bash
set -euo pipefail

DEFAULT_RUNNERS="runner-openai-compat runner-anthropic runner-google"

if [ $# -gt 0 ]; then
  RUNNERS=("$@")
else
  read -r -a RUNNERS <<< "$DEFAULT_RUNNERS"
fi

mkdir -p backups
TS=$(date +%Y%m%d-%H%M%S)
for runner in "${RUNNERS[@]}"; do
  file="backups/outputs-${runner}-${TS}.tar.gz"
  kubectl -n ai-arena exec "deploy/${runner}" -- tar czf - -C /var/arena/outputs . > "$file"
  echo "Backed up ${runner} outputs to ${file}"
done
