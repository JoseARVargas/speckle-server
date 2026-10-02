# coord-worker

Worker Python do módulo de Coordenação BIM do NexTwin. Hoje executa a **validação IDS** (buildingSMART IDS 1.0) com o IfcTester sobre o IFC original de cada versão. Depois vai receber o clash (`.ai/plans/2026-10-01-coordenacao-bim-clash.md` no repositório do console).

## Como funciona

1. O servidor (`modules/facilities`, motor `ids`) enfileira o run em `coord_check_runs` com `status = 'queued'`, `engine = 'ids'` e `ifcObjectKey` (o IFC original no MinIO).
2. O worker reivindica o run (`SKIP LOCKED`) → `ids_running`. Baixa o IFC e valida o IDS guardado em `coord_rule_set_versions.idsXml`. Grava um resultado por (especificação, GlobalId) em `coord_check_results` e marca `ids_done`.
3. O servidor reivindica `ids_done`, liga os GlobalIds aos elementos do Speckle (`applicationId`), calcula status e score e marca `succeeded`.

O worker não tem porta HTTP, não tem regra de negócio e roda com um usuário Postgres restrito.

## Configuração (variáveis de ambiente)

| Variável                                                                  | Uso                                                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `COORD_WORKER_DATABASE_URL`                                               | `postgresql://coord_worker:<senha>@postgres:5432/speckle` (usuário restrito; ver abaixo) |
| `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION` | Leitura do IFC original. Em produção, use uma chave **somente leitura** do bucket        |
| `COORD_WORKER_POLL_SECONDS`                                               | Intervalo de consulta da fila (padrão 5)                                                 |
| `COORD_WORKER_MAX_IFC_MB`                                                 | Tamanho máximo de IFC (padrão 200)                                                       |
| `COORD_WORKER_MAX_VALIDATION_SECONDS`                                     | Tempo máximo de uma validação (padrão 900)                                               |

## Usuário Postgres com privilégio mínimo

`sql/coord_worker_role.sql` cria o usuário `coord_worker` com acesso só ao necessário. Ele lê e atualiza o status de `coord_check_runs`, lê `coord_rule_set_versions` e `coord_rules`, e grava `coord_check_results`. Rode como dono do banco, com a senha em variável (nunca num arquivo):

```bash
psql -v worker_password="$COORD_WORKER_DB_PASSWORD" -d speckle -f sql/coord_worker_role.sql
```

O script pode ser rodado de novo sem problema. Rode de novo depois de migrações que criem colunas usadas pelo worker.

## Desenvolvimento

Sem Python local; tudo em container:

```bash
# testes e lint
docker run --rm -v "$PWD:/src" -w /src -e UV_PROJECT_ENVIRONMENT=/tmp/venv \
  ghcr.io/astral-sh/uv:python3.12-bookworm-slim \
  sh -c "uv sync --frozen && uv run pytest -q && uv run ruff check . && uv run ruff format --check ."

# imagem (a partir da raiz do monorepo)
docker build -f packages/coord-worker/Dockerfile -t ghcr.io/josearvargas/coord-worker:<sha> .
```

Dependências fixadas em `pyproject.toml` e travadas com hash em `uv.lock`. A imagem base é fixada por digest.

## Serviço no compose (produção)

Depende da VPS nova (`.ai/plans/2026-10-01-migracao-hostinger.md`); a EC2 atual não tem memória para isto.

```yaml
coord-worker:
  image: ghcr.io/josearvargas/coord-worker:<sha>
  restart: unless-stopped
  depends_on: [postgres, minio]
  env_file: coord-worker.env # COORD_WORKER_DATABASE_URL, S3_* (fora do Git)
  mem_limit: 2g
  cpus: 1.0
  read_only: true
  tmpfs: [/tmp]
  # sem "ports": o worker não recebe conexões
```

## Licenças

IfcOpenShell e IfcTester são LGPL-3.0. Usá-los como biblioteca num serviço interno, sem distribuir o binário a terceiros, é compatível com a licença. Se o NexTwin for distribuído como produto, revise com o jurídico.
