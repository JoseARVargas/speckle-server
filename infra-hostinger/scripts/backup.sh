#!/usr/bin/env bash
# Backup diário: dump do Postgres + dados do MinIO + /opt/nextwin (config e segredos) → restic (B2).
# O restic criptografa no cliente; a senha do repositório fica só na VPS e no gerenciador de senhas do dono.
set -euo pipefail
umask 077
# shellcheck disable=SC1091
source /etc/nextwin-backup/restic.env
export RESTIC_PASSWORD_FILE=/etc/nextwin-backup/restic.pw

STAGE=/var/backups/nextwin
MINIO_DATA=$(docker volume inspect -f '{{.Mountpoint}}' nextwin_minio-data)
mkdir -p "$STAGE"
trap 'rm -f "$STAGE/postgres.dump"' EXIT

echo "pg_dump..."
docker compose -f /opt/nextwin/docker-compose.yml exec -T postgres \
  pg_dump -U speckle -d speckle -Fc > "$STAGE/postgres.dump"
# um dump vazio ou truncado não pode virar snapshot "bom"
[ -s "$STAGE/postgres.dump" ] || { echo "pg_dump vazio" >&2; exit 1; }

echo "restic backup..."
restic backup --tag nextwin --host nextwin-vps \
  "$STAGE/postgres.dump" "$MINIO_DATA" /opt/nextwin

echo "restic forget/prune..."
restic forget --tag nextwin --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
echo "backup ok"
