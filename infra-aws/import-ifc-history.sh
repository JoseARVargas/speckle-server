#!/usr/bin/env bash
# Uploads one or more IFC files to a project on the digital twin Speckle
# server and waits for each to finish converting. Usage:
#   SPECKLE_PAT=... ./import-ifc-history.sh file1.ifc [file2.ifc ...]
set -euo pipefail

HOST="https://54-232-221-159.sslip.io"
PAT="${SPECKLE_PAT:?set SPECKLE_PAT to a Personal Access Token with streams:write scope}"
PROJECT_ID="a681fa9261"
MODEL_ID="a389f6e767"

if [ "$#" -eq 0 ]; then
  echo "Usage: SPECKLE_PAT=... $0 file1.ifc [file2.ifc ...]" >&2
  exit 1
fi
FILES=("$@")

gql() {
  curl -s "$HOST/graphql" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $PAT" -d "$1"
}

for FILE in "${FILES[@]}"; do
  NAME=$(basename "$FILE")
  echo "=== Uploading $NAME ==="

  UPLOAD_RESP=$(gql "{\"query\":\"mutation(\$input: GenerateFileUploadUrlInput!) { fileUploadMutations { generateUploadUrl(input: \$input) { url fileId } } }\",\"variables\":{\"input\":{\"projectId\":\"$PROJECT_ID\",\"fileName\":\"$NAME\"}}}")
  echo "$UPLOAD_RESP"
  URL=$(echo "$UPLOAD_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).data.fileUploadMutations.generateUploadUrl.url))")
  FILE_ID=$(echo "$UPLOAD_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).data.fileUploadMutations.generateUploadUrl.fileId))")

  ETAG=$(curl -sD - -o /dev/null "$URL" -X PUT -H "Content-Type: application/octet-stream" --data-binary "@$FILE" | grep -i "^etag:" | sed 's/[Ee][Tt][Aa][Gg]: *//;s/"//g;s/\r//')
  echo "fileId=$FILE_ID etag=$ETAG"

  START_RESP=$(gql "{\"query\":\"mutation(\$input: StartFileImportInput!) { fileUploadMutations { startFileImport(input: \$input) { id convertedStatus } } }\",\"variables\":{\"input\":{\"projectId\":\"$PROJECT_ID\",\"modelId\":\"$MODEL_ID\",\"fileId\":\"$FILE_ID\",\"etag\":\"$ETAG\"}}}")
  echo "$START_RESP"

  echo "Waiting for conversion..."
  for i in $(seq 1 30); do
    sleep 3
    STATUS_RESP=$(gql "{\"query\":\"{ project(id: \\\"$PROJECT_ID\\\") { digitalTwinAssets(input:{limit:20}) { items { fileName status versionId convertedMessage } } } }\"}")
    STATUS=$(echo "$STATUS_RESP" | node -e "
      let d='';process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        const items = JSON.parse(d).data.project.digitalTwinAssets.items;
        const item = items.find(i => i.fileName === '$NAME');
        console.log(item ? item.status : 'unknown');
      })")
    echo "  status: $STATUS"
    if [ "$STATUS" = "completed" ] || [ "$STATUS" = "error" ]; then
      break
    fi
  done
  echo "$STATUS_RESP"
  echo ""
done
