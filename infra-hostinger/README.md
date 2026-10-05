# infra-hostinger

Produção do NexTwin na VPS Hostinger KVM 1 (`nextwin.officio.net.br`). Substitui `infra-aws/`.
Plano completo: `speckle-digitaltwin-console/.ai/plans/2026-10-01-migracao-hostinger.md`.

## Layout na VPS (`/opt/nextwin`)

| Arquivo              | Versionado | Conteúdo                                                          |
| -------------------- | ---------- | ----------------------------------------------------------------- |
| `docker-compose.yml` | sim        | pilha; só o Caddy publica portas (80/443)                         |
| `Caddyfile`          | sim        | HTTPS automático + headers; `files.` expõe só `/speckle-server/*` |
| `config/server.env`  | sim        | configuração não secreta do speckle-server                        |
| `secrets/*.env`      | **não**    | gerados na VPS por `scripts/gerar-segredos.sh` (permissão 600)    |

## Primeira subida

```sh
cd /opt/nextwin
bash scripts/gerar-segredos.sh      # uma vez; recusa se secrets/ já existir
docker compose up -d
docker compose ps
```

## Observações

- O MinIO roda de uma imagem copiada da EC2 (`pull_policy: never`); não rodar `docker image prune -a`.
- O speckle-server usa o usuário root do MinIO como chave S3 (como na EC2). A troca pelo Garage é tarefa separada.
- Atualizar o servidor: trocar a tag em `speckle-server.image`, fazer `pg_dump` antes e `docker compose up -d speckle-server`.
  Rollback depois de uma migração exige desfazer a migração, não só voltar a tag.

## Backup (restic → Backblaze B2)

- Configuração única, no terminal da VPS: `bash /opt/nextwin/scripts/configurar-backup.sh`. O script pede bucket, endpoint S3, keyID e applicationKey (a key fica restrita ao bucket) e mostra a senha do repositório **uma vez**. Essa senha precisa ficar num gerenciador de senhas, fora da VPS.
- Timer `nextwin-backup.timer` diário às 03:30 de Brasília: dump do Postgres, dados do MinIO e `/opt/nextwin`. Retenção 7 diários, 4 semanais e 6 mensais.
- Rodar na hora: `systemctl start nextwin-backup && journalctl -u nextwin-backup -n 50`.
- Restaurar: `source /etc/nextwin-backup/restic.env; RESTIC_PASSWORD_FILE=/etc/nextwin-backup/restic.pw restic restore latest --target /tmp/restore`.
- Ao copiar arquivos para a VPS com tar, extrair como root com `--no-same-owner` (ou `chown -R root:root /opt/nextwin`): os scripts rodam como root.

## coord-worker (validação IDS)

Serviço sem portas, com usuário Postgres `coord_worker` (privilégio mínimo, `sql/coord_worker_role.sql`) e usuário MinIO `coord-worker` com política só de `s3:GetObject` em `speckle-server/*`. Configuração única, **depois** de o speckle-server aplicar a migração do IDS:

```sh
bash scripts/configurar-coord-worker.sh   # gera secrets/coord-worker.env
docker compose up -d coord-worker
```

Rode `sql/coord_worker_role.sql` de novo após migrações que criem colunas usadas pelo worker.

## Segunda pilha: OFFICIO Coordenação BIM (`/opt/officio`)

A mesma VPS roda a pilha da OFFICIO (`officio/docker-compose.yml`, projeto compose `officio`). Ela tem banco, MinIO, segredos e backup próprios, e o servidor sobe com `FF_FACILITIES_MODULE_ENABLED=false` (só coordenação). Domínios: `speckle.officio.net.br` (servidor), `files.speckle.officio.net.br` (bucket) e `bim.officio.net.br` (app na Vercel).

- **Rede `edge`:** só o Caddy do nextwin publica 80/443. Ele chega à pilha officio pela rede externa `edge` (`docker network create edge`), pelos aliases `officio-*`. Os sites do nextwin usam os nomes de container (`nextwin-*-1`), porque na `edge` o nome de serviço `speckle-server` também resolveria para a officio.
- **Scripts compartilhados:** `scripts/` vale para as duas pilhas; o nome da pilha vem da pasta (`/opt/<pilha>`). Backup em `/etc/<pilha>-backup`, timer `<pilha>-backup.timer` (officio às 04:15 de Brasília).
- **E-mail:** `scripts/configurar-email.sh` liga o SMTP do Resend (convites e verificação). A key é digitada no terminal e só fica em `secrets/server.env`.
- **Só por convite:** depois que o dono cria a conta de admin (a primeira conta do servidor vira admin), ligar `inviteOnly` nas configurações do servidor.

## Monitoramento (Better Stack + Healthchecks.io)

**Better Stack Uptime** (quedas vistas de fora, a cada 3 min; plano grátis, sem cartão). Crie uma conta em betterstack.com e adicione quatro monitores do tipo "URL becomes unavailable", com alerta por e-mail:

| Monitor          | Tipo                                                                                                                         | URL                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| OFFICIO app      | HTTP(s)                                                                                                                      | `https://bim.officio.net.br`             |
| NexTwin app      | HTTP(s)                                                                                                                      | `https://app.nextwin.officio.net.br`     |
| OFFICIO servidor | HTTP(s); em Advanced settings: método POST, request body `{"query":"{__typename}"}`, header `Content-Type: application/json` | `https://speckle.officio.net.br/graphql` |
| NexTwin servidor | idem                                                                                                                         | `https://nextwin.officio.net.br/graphql` |

**Healthchecks.io** (o que só a VPS sabe; alerta pela **falta** de sinal). Crie uma conta grátis em healthchecks.io e três checks:

| Check            | Period     | Grace      | Usado por                                                                   |
| ---------------- | ---------- | ---------- | --------------------------------------------------------------------------- |
| `backup-nextwin` | 1 day      | 2 hours    | `backup.sh` da pilha nextwin                                                |
| `backup-officio` | 1 day      | 2 hours    | `backup.sh` da pilha officio                                                |
| `vps-saude`      | 15 minutes | 15 minutes | `saude.sh` (disco ≥ 85%, memória < 300 MB, container parado ou reiniciando) |

Copie a "ping URL" de cada um (`https://hc-ping.com/<uuid>`) e cole no terminal da VPS. Ela não aparece ao digitar, porque funciona como senha:

```sh
bash /opt/nextwin/scripts/configurar-monitoramento.sh   # backup-nextwin + (s) vps-saude
bash /opt/officio/scripts/configurar-monitoramento.sh   # backup-officio (responda N à saúde)
```
