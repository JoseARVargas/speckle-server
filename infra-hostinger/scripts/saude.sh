#!/usr/bin/env bash
# Saúde da VPS (todas as pilhas em /opt/*/docker-compose.yml), a cada 15 min (vps-saude.timer).
# Pinga o Healthchecks.io: sucesso quando está tudo bem, /fail com o motivo quando não está.
# Se a VPS cair, os pings param e o Healthchecks alerta por falta de sinal.
# URL em /etc/vps-saude.url (scripts/configurar-monitoramento.sh).
set -uo pipefail
URL=$(cat /etc/vps-saude.url 2>/dev/null || true)
[ -n "$URL" ] || { echo "sem /etc/vps-saude.url; nada a fazer" >&2; exit 0; }

DISK_MAX_PCT=85
MEM_MIN_MB=300
problems=()

disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$disk" -ge "$DISK_MAX_PCT" ] && problems+=("disco em ${disk}% (limite ${DISK_MAX_PCT}%)")

mem=$(free -m | awk '/^Mem:/ {print $7}')
[ "$mem" -lt "$MEM_MIN_MB" ] && problems+=("memória disponível ${mem} MB (mínimo ${MEM_MIN_MB} MB)")

for compose in /opt/*/docker-compose.yml; do
  project=$(docker compose -f "$compose" config --format json 2>/dev/null | sed -n 's/^ *"name": "\([^"]*\)".*/\1/p' | head -1)
  [ -n "$project" ] || project=$(basename "$(dirname "$compose")")
  expected=$(docker compose -f "$compose" config --services 2>/dev/null | wc -l)
  running=$(docker ps --filter "label=com.docker.compose.project=$project" --filter status=running --format '{{.Names}}' | wc -l)
  [ "$running" -lt "$expected" ] && problems+=("$project: $running de $expected containers rodando")
  bad=$(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.Names}} {{.Status}}' | grep -Ei 'restarting|unhealthy' || true)
  [ -n "$bad" ] && problems+=("$project: $bad")
done

if [ ${#problems[@]} -eq 0 ]; then
  curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "ok: disco ${disk}%, memória livre ${mem} MB" "$URL" || true
else
  msg=$(printf '%s\n' "${problems[@]}")
  echo "$msg" >&2
  curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "$msg" "$URL/fail" || true
fi
