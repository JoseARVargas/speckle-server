#!/usr/bin/env bash
# Credenciais do coord-worker (rodar na VPS, em /opt/nextwin, DEPOIS da migração do IDS):
# usuário Postgres coord_worker (privilégio mínimo) e usuário MinIO só leitura do bucket.
# Senhas passam por stdin, nunca por argumentos de comando.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
[ -e secrets/coord-worker.env ] && { echo "secrets/coord-worker.env já existe; nada foi alterado." >&2; exit 1; }
DC="docker compose"
PG_PW=$(openssl rand -hex 24)
S3_USER="coord-worker"
S3_PW=$(openssl rand -hex 24)
# shellcheck disable=SC1091
source secrets/minio.env

echo "== Postgres: role coord_worker"
{ printf "\\set worker_password '%s'\n" "$PG_PW"; cat sql/coord_worker_role.sql; } \
  | $DC exec -T postgres psql -q -v ON_ERROR_STOP=1 -U speckle -d speckle

echo "== MinIO: usuário só leitura em speckle-server/*"
$DC exec -T minio sh -s <<SH
set -e
export MC_HOST_local='http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@localhost:9000'
cat > /tmp/coord-worker-policy.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::speckle-server/*"]}]}
JSON
mc -q admin policy create local coord-worker-read /tmp/coord-worker-policy.json >/dev/null
mc -q admin user add local '${S3_USER}' '${S3_PW}' >/dev/null
mc -q admin policy attach local coord-worker-read --user '${S3_USER}' >/dev/null
rm -f /tmp/coord-worker-policy.json
echo "usuário ${S3_USER} criado com a política coord-worker-read"
SH

printf 'COORD_WORKER_DATABASE_URL=postgresql://coord_worker:%s@postgres:5432/speckle\nS3_ACCESS_KEY=%s\nS3_SECRET_KEY=%s\n' \
  "$PG_PW" "$S3_USER" "$S3_PW" > secrets/coord-worker.env
chmod 600 secrets/coord-worker.env
echo "secrets/coord-worker.env gerado (600)."
