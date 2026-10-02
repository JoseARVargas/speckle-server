#!/usr/bin/env bash
# Roda NA VPS depois de ec2-exportar.sh. Substitui banco e MinIO (vazios) pelos dados da EC2.
set -euo pipefail
cd /opt/nextwin
STAGE=/var/backups/nextwin
DC="docker compose"
[ -s $STAGE/ec2.dump ] && [ -d $STAGE/minio-ec2/.minio.sys ] || { echo "dados da EC2 ausentes em $STAGE" >&2; exit 1; }

echo "== 1/4 parando aplicação"
$DC stop speckle-server speckle-frontend-2 ifc-import-service

echo "== 2/4 restaurando Postgres"
$DC exec -T postgres dropdb -U speckle --if-exists speckle
$DC exec -T postgres createdb -U speckle -O speckle speckle
$DC exec -T postgres pg_restore -U speckle -d speckle --no-owner --no-acl --exit-on-error < $STAGE/ec2.dump

echo "== 3/4 substituindo dados do MinIO"
MV=$(docker volume inspect -f '{{.Mountpoint}}' nextwin_minio-data)
[ -n "$MV" ] && [ "$MV" != "/" ] || exit 1
$DC stop minio
find "$MV" -mindepth 1 -delete
cp -a $STAGE/minio-ec2/. "$MV"/
$DC start minio

echo "== 4/4 subindo aplicação"
$DC up -d
sleep 30
$DC exec -T postgres psql -U speckle -d speckle -tAc \
  "select 'streams='||(select count(*) from streams)||' commits='||(select count(*) from commits)||' objects='||(select count(*) from objects)||' users='||(select count(*) from users)||' coord_runs='||(select count(*) from coord_check_runs)"
$DC ps --format '{{.Service}} {{.Status}}'
