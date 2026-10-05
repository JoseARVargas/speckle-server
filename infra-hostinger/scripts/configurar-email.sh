#!/usr/bin/env bash
# Liga o envio de e-mail (convites, verificação de conta) da pilha pelo SMTP do Resend.
# Rodar UMA vez, como root, no terminal da VPS, na pasta da pilha (ex.: /opt/officio).
# A API key do Resend é digitada aqui, não aparece na tela e só fica em secrets/ (600).
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
ENV_FILE=secrets/server.env
[ -f "$ENV_FILE" ] || { echo "rode depois de scripts/gerar-segredos.sh" >&2; exit 1; }
if grep -q '^EMAIL_PASSWORD=' "$ENV_FILE"; then
  echo "O e-mail já está configurado em $ENV_FILE; nada foi alterado." >&2
  exit 1
fi

read -r -p "Remetente [coordenacao@mail.officio.net.br]: " FROM
FROM=${FROM:-coordenacao@mail.officio.net.br}
read -r -s -p "API key do Resend (só envio, restrita ao domínio; não aparece ao digitar): " KEY; echo
[[ "$FROM" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "remetente inválido" >&2; exit 1; }
[[ "$KEY" =~ ^re_[A-Za-z0-9_]{10,}$ ]] || { echo "a key do Resend começa com re_" >&2; exit 1; }

# secrets/ vem depois de config/ no env_file do compose, então estes valores prevalecem
printf 'EMAIL=true\nEMAIL_HOST=smtp.resend.com\nEMAIL_PORT=587\nEMAIL_SECURE=false\nEMAIL_REQUIRE_TLS=true\nEMAIL_USERNAME=resend\nEMAIL_FROM=%s\nEMAIL_PASSWORD=%s\n' \
  "$FROM" "$KEY" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"
docker compose up -d speckle-server >/dev/null
echo "E-mail configurado (remetente $FROM). Servidor reiniciado."
