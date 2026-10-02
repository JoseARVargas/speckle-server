#!/usr/bin/env bash
# Configura o backup restic → Backblaze B2 (API S3). Rodar UMA vez, como root, no terminal da VPS.
# As credenciais do B2 são digitadas aqui e não aparecem na tela nem saem da VPS.
set -euo pipefail
umask 077
CONF=/etc/nextwin-backup
if [ -e "$CONF/restic.env" ]; then
  echo "$CONF/restic.env já existe; nada foi alterado." >&2
  exit 1
fi

command -v restic >/dev/null || { apt-get update -q && apt-get install -y -q restic; }

echo "Dados do Backblaze B2 (página do bucket):"
read -r -p "  Nome do bucket: " BUCKET
read -r -p "  Endpoint S3 (ex.: s3.us-east-005.backblazeb2.com): " ENDPOINT
read -r -s -p "  keyID (não aparece ao digitar): " KEY_ID; echo
read -r -s -p "  applicationKey (não aparece ao digitar): " APP_KEY; echo
ENDPOINT=${ENDPOINT#https://}
[[ "$BUCKET" =~ ^[A-Za-z0-9-]{6,63}$ ]] || { echo "nome de bucket inválido" >&2; exit 1; }
[[ "$ENDPOINT" =~ ^s3\.[a-z0-9-]+\.backblazeb2\.com$ ]] || { echo "endpoint inválido" >&2; exit 1; }
[ -n "$KEY_ID" ] && [ -n "$APP_KEY" ] || { echo "credenciais vazias" >&2; exit 1; }

mkdir -p "$CONF" && chmod 700 "$CONF"
printf 'export RESTIC_REPOSITORY=%q\nexport AWS_ACCESS_KEY_ID=%q\nexport AWS_SECRET_ACCESS_KEY=%q\n' \
  "s3:https://$ENDPOINT/$BUCKET/nextwin" "$KEY_ID" "$APP_KEY" > "$CONF/restic.env"
openssl rand -base64 33 | tr -d '\n' > "$CONF/restic.pw"
chmod 600 "$CONF"/*

# shellcheck disable=SC1091
source "$CONF/restic.env"
export RESTIC_PASSWORD_FILE="$CONF/restic.pw"
restic init

cp /opt/nextwin/systemd/nextwin-backup.service /opt/nextwin/systemd/nextwin-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nextwin-backup.timer

echo
echo "================= SENHA DO BACKUP (aparece só agora) ================="
cat "$CONF/restic.pw"; echo
echo "======================================================================"
echo "Guarde essa senha no seu gerenciador de senhas. Sem ela, os backups"
echo "NÃO podem ser restaurados se a VPS for perdida. Depois, limpe a tela (clear)."
