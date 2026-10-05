#!/usr/bin/env bash
# Liga os avisos ao Healthchecks.io. Rodar como root, no terminal da VPS, na pasta da pilha.
# - Backup desta pilha: /etc/<pilha>-backup/healthcheck.url (lida pelo backup.sh)
# - Saúde da VPS (uma vez só, vale para todas as pilhas): /etc/vps-saude.url + vps-saude.timer
# As URLs de ping funcionam como senha (quem tem pode "dizer que está tudo bem"):
# são digitadas aqui, não aparecem na tela e ficam em arquivos 600.
set -euo pipefail
umask 077
DIR=$(cd "$(dirname "$0")/.." && pwd)
STACK=$(basename "$DIR")
PATTERN='^https://hc-ping\.com/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

read -r -s -p "URL de ping do backup de '$STACK' (https://hc-ping.com/..., não aparece): " BACKUP_URL; echo
[[ "$BACKUP_URL" =~ $PATTERN ]] || { echo "URL inválida (esperado https://hc-ping.com/<uuid>)" >&2; exit 1; }
[ -d "/etc/$STACK-backup" ] || { echo "/etc/$STACK-backup não existe: configure o backup antes" >&2; exit 1; }
printf '%s' "$BACKUP_URL" > "/etc/$STACK-backup/healthcheck.url"
chmod 600 "/etc/$STACK-backup/healthcheck.url"
echo "backup de '$STACK' ligado ao Healthchecks."

read -r -p "Configurar também a saúde da VPS agora? (s/N): " VPS
if [[ "$VPS" =~ ^[sS]$ ]]; then
  read -r -s -p "URL de ping da saúde da VPS (não aparece): " VPS_URL; echo
  [[ "$VPS_URL" =~ $PATTERN ]] || { echo "URL inválida" >&2; exit 1; }
  printf '%s' "$VPS_URL" > /etc/vps-saude.url
  chmod 600 /etc/vps-saude.url
  cp "$DIR/systemd/vps-saude.service" "$DIR/systemd/vps-saude.timer" /etc/systemd/system/
  sed -i "s#/opt/nextwin/scripts/saude.sh#$DIR/scripts/saude.sh#" /etc/systemd/system/vps-saude.service
  systemctl daemon-reload
  systemctl enable --now vps-saude.timer
  systemctl start vps-saude.service
  echo "saúde da VPS ligada (a cada 15 min)."
fi

echo "Testando o ping do backup..."
curl -fsS -m 10 -o /dev/null --data-raw "teste de configuração ($STACK)" "$BACKUP_URL" && echo "ok: confira no Healthchecks.io"
