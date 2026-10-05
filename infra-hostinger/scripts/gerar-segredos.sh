#!/usr/bin/env bash
# Gera os segredos da pilha em ./secrets/ (rodar na VPS, na pasta da pilha: /opt/nextwin, /opt/officio...).
# Não sobrescreve nada que já exista: trocar um segredo é uma decisão manual.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p secrets
chmod 700 secrets

if [ -e secrets/postgres.env ] || [ -e secrets/minio.env ] || [ -e secrets/server.env ] || [ -e secrets/ifc-import.env ]; then
  echo "secrets/ já tem arquivos; nada foi alterado." >&2
  exit 1
fi

# hex: sem caracteres que precisem de escape em URL de conexão
rand() { openssl rand -hex "$1"; }
PG_PASS=$(rand 24)
MINIO_USER="$(basename "$(pwd)")-$(rand 6)"
MINIO_PASS=$(rand 24)
SESSION_SECRET=$(rand 32)

printf 'POSTGRES_PASSWORD=%s\n' "$PG_PASS" > secrets/postgres.env
printf 'MINIO_ROOT_USER=%s\nMINIO_ROOT_PASSWORD=%s\n' "$MINIO_USER" "$MINIO_PASS" > secrets/minio.env
printf 'POSTGRES_PASSWORD=%s\nSESSION_SECRET=%s\nS3_ACCESS_KEY=%s\nS3_SECRET_KEY=%s\nFILEIMPORT_QUEUE_POSTGRES_URL=postgresql://speckle:%s@postgres:5432/speckle\n' \
  "$PG_PASS" "$SESSION_SECRET" "$MINIO_USER" "$MINIO_PASS" "$PG_PASS" > secrets/server.env
printf 'FILEIMPORT_QUEUE_POSTGRES_URL=postgresql://speckle:%s@postgres:5432/speckle\n' "$PG_PASS" > secrets/ifc-import.env
chmod 600 secrets/*.env
echo "Segredos gerados em $(pwd)/secrets (permissão 600). Não imprimir nem copiar para fora da VPS."
