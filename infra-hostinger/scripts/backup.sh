#!/usr/bin/env bash
# Backup diário de uma pilha (/opt/<pilha>): dump do Postgres + dados do MinIO + a pasta da pilha
# (config e segredos) → restic (B2). A pilha é a pasta acima de scripts/ (nextwin, officio...).
# O restic criptografa no cliente; a senha do repositório fica só na VPS e no gerenciador de senhas do dono.
set -euo pipefail
umask 077
DIR=$(cd "$(dirname "$0")/.." && pwd)
STACK=$(basename "$DIR")
# shellcheck disable=SC1091
source "/etc/$STACK-backup/restic.env"
export RESTIC_PASSWORD_FILE="/etc/$STACK-backup/restic.pw"

STAGE="/var/backups/$STACK"
MINIO_DATA=$(docker volume inspect -f '{{.Mountpoint}}' "$STACK"_minio-data)
mkdir -p "$STAGE"
trap 'rm -f "$STAGE/postgres.dump"' EXIT

echo "pg_dump..."
docker compose -f "$DIR/docker-compose.yml" exec -T postgres \
  pg_dump -U speckle -d speckle -Fc > "$STAGE/postgres.dump"
# um dump vazio ou truncado não pode virar snapshot "bom"
[ -s "$STAGE/postgres.dump" ] || { echo "pg_dump vazio" >&2; exit 1; }

echo "restic backup..."
# .minio.sys/tmp: temporários do MinIO, que somem durante a leitura e não servem para restaurar
restic backup --tag "$STACK" --host nextwin-vps \
  --exclude "$MINIO_DATA/.minio.sys/tmp" \
  "$STAGE/postgres.dump" "$MINIO_DATA" "$DIR"

echo "restic forget/prune..."
restic forget --tag "$STACK" --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
echo "backup ok"
