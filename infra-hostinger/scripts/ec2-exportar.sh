#!/usr/bin/env bash
# Roda NA EC2 (usuário ubuntu), dentro da pasta do docker-compose de produção.
# Congela a escrita (para servidor, frontend e importador; banco e MinIO seguem de pé),
# envia dump do Postgres, dados do MinIO e server.env para a VPS pela chave de transferência.
# Rollback: docker compose start speckle-server speckle-frontend-2 ifc-import-service
set -euo pipefail
KEY=~/.ssh/to_nextwin_vps
VPS=root@179.197.79.150
STAGE=/var/backups/nextwin
vps() { ssh -i "$KEY" -o BatchMode=yes "$VPS" "$@"; }

[ -f docker-compose.yml ] && [ -f server.env ] || { echo "rode dentro da pasta do compose (com server.env)" >&2; exit 1; }
MINIO_PATH=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$(docker compose ps -q minio)")
[ -n "$MINIO_PATH" ] || { echo "volume do MinIO não encontrado" >&2; exit 1; }
vps "mkdir -p $STAGE && rm -rf $STAGE/minio-ec2 $STAGE/ec2.dump $STAGE/ec2-server.env && mkdir -m 700 $STAGE/minio-ec2"

echo "== 1/4 congelando escrita (início da indisponibilidade)"
docker compose stop speckle-server speckle-frontend-2 ifc-import-service

echo "== 2/4 contagens de referência"
docker compose exec -T postgres psql -U speckle -d speckle -tAc \
  "select 'streams='||(select count(*) from streams)||' commits='||(select count(*) from commits)||' objects='||(select count(*) from objects)||' users='||(select count(*) from users)||' coord_runs='||(select count(*) from coord_check_runs)"

echo "== 3/4 pg_dump -> VPS"
docker compose exec -T postgres pg_dump -U speckle -d speckle -Fc | vps "umask 077; cat > $STAGE/ec2.dump"
vps "ls -l $STAGE/ec2.dump | awk '{print \$5\" bytes\"}'"
vps "umask 077; cat > $STAGE/ec2-server.env" < server.env

echo "== 4/4 dados do MinIO -> VPS"
sudo du -sh "$MINIO_PATH"
sudo tar -C "$MINIO_PATH" -cf - . | gzip -1 | vps "tar -xzf - -C $STAGE/minio-ec2 && du -sh $STAGE/minio-ec2"

echo "== exportação concluída. A EC2 segue com escrita parada até a confirmação da virada."
