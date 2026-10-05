#!/usr/bin/env bash
# Backup diário de uma pilha (/opt/<pilha>): dump do Postgres + dados do MinIO + a pasta da pilha
# (config e segredos) → restic (B2). A pilha é a pasta acima de scripts/ (nextwin, officio...).
# O restic criptografa no cliente; a senha do repositório fica só na VPS e no gerenciador de senhas do dono.
# Com /etc/<pilha>-backup/healthcheck.url (scripts/configurar-monitoramento.sh), avisa o
# Healthchecks.io no início, no sucesso e na falha. Se o aviso não chegar, o serviço alerta por e-mail.
set -euo pipefail
umask 077
DIR=$(cd "$(dirname "$0")/.." && pwd)
STACK=$(basename "$DIR")
CONF="/etc/$STACK-backup"
STAGE="/var/backups/$STACK"
# shellcheck disable=SC1091
source "$CONF/restic.env"
export RESTIC_PASSWORD_FILE="$CONF/restic.pw"

# Ping de melhor esforço: nunca derruba nem atrasa o backup (timeout curto, erros ignorados)
HC_URL=$(cat "$CONF/healthcheck.url" 2>/dev/null || true)
ping_hc() {
  [ -n "$HC_URL" ] || return 0
  curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "${2:-}" "$HC_URL$1" || true
}
LOG=$(mktemp)
exec > >(tee -a "$LOG") 2>&1
on_exit() {
  local code=$?
  rm -f "$STAGE/postgres.dump"
  if [ "$code" -eq 0 ]; then
    ping_hc "" "backup $STACK ok"
  else
    ping_hc "/fail" "$(tail -c 2000 "$LOG")"
  fi
  rm -f "$LOG"
}
trap on_exit EXIT
ping_hc "/start"

MINIO_DATA=$(docker volume inspect -f '{{.Mountpoint}}' "$STACK"_minio-data)
mkdir -p "$STAGE"

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
