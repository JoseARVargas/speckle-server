# Arquitetura: speckle-app

Fork do [Speckle Server](https://github.com/specklesystems/speckle-server) (monorepo Yarn 4 workspaces, Node 22) estendido pela OFFICIO com um **módulo de gestão de facilities / gêmeo digital**. O frontend dessas funcionalidades **não** é o `frontend-2` do Speckle, e sim o repositório separado `C:\dev\speckle-digitaltwin-console` (NexTwin), que consome esta API GraphQL.

## O que é upstream e o que é nosso

- **Upstream (Speckle):** quase todo o repositório (`packages/server`, `packages/frontend-2`, `viewer`, serviços de preview/import etc.). Siga as convenções do upstream e **evite modificá-lo**: cada mudança fora do nosso módulo dificulta atualizar o fork.
- **Nosso código:**
  - `packages/server/modules/facilities/`: o módulo do digital twin (NexTwin). Fica atrás de `FF_FACILITIES_MODULE_ENABLED` (padrão `true`).
  - `packages/server/modules/coordination/` e `assets/coordination/`: a Coordenação BIM (Model Check + IDS), sempre ligada e independente de `facilities`.
  - `packages/server/assets/facilities/typedefs/*.graphql`: schema GraphQL do módulo.
  - Pontos de contato mínimos no core: `modules/core/dbSchema.ts` (definição das tabelas), `modules/core/graph/generated/graphql.ts` (gerado por `yarn gqlgen`, nunca editar à mão), `modules/shared/helpers/envHelper.ts` (env vars novas).
  - `modules/fileuploads`: `DigitalTwinAsset` (arquivos importados expostos como ativos).
  - `infra-aws/`: deploy na AWS.

## Módulo `facilities`

| Pasta                  | Papel                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`             | `init` do módulo: registra o router REST. Não há worker em segundo plano (a simulação é calculada na leitura).                                                                                      |
| `graph/resolvers/*.ts` | Resolvers GraphQL (facilities, maintenance, documents, sensors, health), mesclados automaticamente pelo loader.                                                                                     |
| `repositories/*.ts`    | Acesso a dados com Knex, no padrão **factory** do Speckle: `xxxFactory({ db }) => (params) => query`.                                                                                               |
| `services/*.ts`        | Regras de negócio: simulação sob demanda (`simulationModel.ts`, puro), health (z-score/tendência, calculado na leitura), relatório de manutenção com IA (Anthropic), sensores, identidade de ativo. |
| `migrations/`          | Migrações Knex nomeadas `AAAAMMDDhhmmss_descricao.ts`.                                                                                                                                              |
| `rest/router.ts`       | Ingestão de leituras de sensores físicos: `POST /api/facilities/sensors/:projectId/:sensorId/readings`, autenticada por chave de API do dispositivo com hash bcrypt.                                |
| `helpers/types.ts`     | Tipos de registro do banco e de domínio.                                                                                                                                                            |

Domínios: coordenação BIM (model check ISO 19650: requisitos OIR/AIR/PIR/EIR, marcos, conjuntos de regras WHERE/CHECK versionados, runs sobre versões de modelo; arquivos `*/coordination*.ts`, tabelas `coord_*`), facility (andares, espaços, sistemas, ativos, tipos de ativo com classificação IFC/COBie), código de identidade do ativo (`NXT-NNNNNN-C`), simulação de dispositivos (estado, telemetria, energia), manutenção (ordens), documentos (plantas, manuais, ARTs, com status e revisão), sensores, manutenção preditiva (injeção de falhas, sinais de saúde, relatórios de IA).

## Autorização

- Mutações chamam `assertCanManageFacility(ctx, projectId)` (em `graph/resolvers/facilities.ts`): exige usuário, regras de acesso do token ao projeto e `authPolicies.project.canPublish`. Toda mutação nova deve reutilizar esse gate. Para recursos filhos, resolver o `projectId` a partir do registro no banco, nunca do input do cliente.
- Leituras aninhadas em `Project`/`Facility` herdam o acesso ao projeto dado pelo Speckle. **Queries raiz por ID** (`Query.asset`, `Query.sensor`) precisam checar acesso ao projeto do registro explicitamente.
- A ingestão REST de sensores usa credencial própria do dispositivo, não sessão de usuário.

## Decisões registradas

- **Simulação em vez de MQTT**: o simulador AC foi implementado estendendo o simulador de dispositivos do módulo, não como serviço MQTT separado. O ponto de entrada para hardware real é a ingestão REST de sensores.
- **Simulação sob demanda, sem tick** (plano `speckle-digitaltwin-console/.ai/plans/2026-10-07-simulacao-sob-demanda.md`): só eventos gravam (ligar/desligar, setpoint, perfil de falha, tarifa), cada um como uma linha append-only em `device_state_segments`. Estado, históricos, dashboard e sinais de saúde são calculados na leitura pela função pura `services/simulationModel.ts` (forma fechada da convergência de temperatura, ruído determinístico por tick da grade global de 15 s, energia contábil com duty médio na ciclagem). `device_states` é só um espelho atualizado nos eventos (e a trava por ativo, `FOR UPDATE`) para permitir rollback de imagem; `telemetry_readings`, `energy_readings` e `device_health_signals` não são mais escritas nem lidas e serão removidas numa migração posterior. `limit` de históricos e séries tem teto de 1000.
- **IA só com sinais estruturados**: o relatório de manutenção envia ao Claude os sinais calculados, nunca a telemetria bruta, e valida o JSON de resposta com `zod` puro.
- **Versões fixadas**: `zod` 3.22.4 é compartilhado com o `frontend-2` (não atualizar isoladamente); `@anthropic-ai/sdk` fixado em versão exata. **Não usar** `@anthropic-ai/sdk/helpers/zod` (importa `zod/v4`, que não existe na 3.22, e derrubou a produção).
- **Coordenação BIM em módulo próprio `coordination`** (separada de `facilities` em 2026-10-04; plano `speckle-digitaltwin-console/.ai/plans/2026-10-04-officio-coordenacao-produto.md`; a mesma imagem serve o NexTwin e o servidor só de coordenação da OFFICIO, com `FF_FACILITIES_MODULE_ENABLED=false`). Origem (plano `speckle-digitaltwin-console/.ai/plans/2026-10-01-coordenacao-bim-model-check.md`): gatilho pelo event bus interno (`VersionEvents.Created`), não webhook; a tabela `coord_check_runs` é a fila (worker em processo com `SKIP LOCKED`, polling desligado em teste); tabelas `coord_*` sempre no `db` principal, objetos do Speckle lidos via `getProjectDbClient`; resultados por `applicationId`, nunca pelo hash do objeto. Clash e IDS (fases 2–3) entram num worker Python separado.
- **IDS e worker Python** (plano `speckle-digitaltwin-console/.ai/plans/2026-10-01-coordenacao-bim-ids.md`): conjuntos `format = 'ids'` guardam o XML na versão; runs `engine = 'ids'` são validados pelo `packages/coord-worker` (IfcTester, container próprio, sem porta, usuário Postgres `coord_worker` com privilégio mínimo via `sql/coord_worker_role.sql`) e agregados pelo Node. Fila: `queued` → `ids_running` (Python) → `ids_done` → `processing` (Node) → `succeeded`.
- **Requisito → verificação** (Fase 2c, plano `officio-bim-coordination/.ai/plans/2026-10-06-fase2-search-sets-bsdd-ids.md`): o requisito pode ter `spec` (classes IFC + WHERE/CHECK). `generateRequirementRules` reescreve o **rascunho** do conjunto gerenciado (`coord_rule_sets.generatedFrom = 'requirements'`, um por projeto) e a publicação continua manual. `requirementsIds` exporta IDS 1.0, validado pelo próprio `parseIdsDocument` antes de sair. `CoordDeliverable.compliance` compara os últimos runs do modelo do entregável com a meta de cada requisito (cache por requisição). Tudo em `services/coordinationRequirementSpec.ts`.
- **Boot crítico**: todo start roda `migrateDbToLatest` e carrega todos os resolvers. Import quebrado em arquivo alcançável pelos resolvers, ou migração com erro, causa crash-loop do servidor inteiro.
- **Produção**: EC2 na AWS com `infra-aws/docker-compose.yml` + Caddy; segredos em `infra-aws/server.env` (fora do Git). O relatório de IA exige `ANTHROPIC_API_KEY` no servidor.
