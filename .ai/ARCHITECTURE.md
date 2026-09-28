# Arquitetura: speckle-app

Fork do [Speckle Server](https://github.com/specklesystems/speckle-server) (monorepo Yarn 4 workspaces, Node 22) estendido pela PHD Engenharia com um **módulo de gestão de facilities / gêmeo digital**. O frontend dessas funcionalidades **não** é o `frontend-2` do Speckle, e sim o repositório separado `C:\dev\speckle-digitaltwin-console` (NexTwin), que consome esta API GraphQL.

## O que é upstream e o que é nosso

- **Upstream (Speckle):** quase todo o repositório (`packages/server`, `packages/frontend-2`, `viewer`, serviços de preview/import etc.). Siga as convenções do upstream e **evite modificá-lo**: cada mudança fora do nosso módulo dificulta atualizar o fork.
- **Nosso código:**
  - `packages/server/modules/facilities/`: o módulo inteiro.
  - `packages/server/assets/facilities/typedefs/*.graphql`: schema GraphQL do módulo.
  - Pontos de contato mínimos no core: `modules/core/dbSchema.ts` (definição das tabelas), `modules/core/graph/generated/graphql.ts` (gerado por `yarn gqlgen`, nunca editar à mão), `modules/shared/helpers/envHelper.ts` (env vars novas).
  - `modules/fileuploads`: `DigitalTwinAsset` (arquivos importados expostos como ativos).
  - `infra-aws/`: deploy na AWS.

## Módulo `facilities`

| Pasta                  | Papel                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`             | `init` do módulo: inicia o worker de simulação (só no init inicial) e registra o router REST.                                                                        |
| `graph/resolvers/*.ts` | Resolvers GraphQL (facilities, maintenance, documents, sensors, health), mesclados automaticamente pelo loader.                                                      |
| `repositories/*.ts`    | Acesso a dados com Knex, no padrão **factory** do Speckle: `xxxFactory({ db }) => (params) => query`.                                                                |
| `services/*.ts`        | Regras de negócio: simulação (tick de 15 s), health (z-score/tendência), relatório de manutenção com IA (Anthropic), sensores, identidade de ativo.                  |
| `migrations/`          | Migrações Knex nomeadas `AAAAMMDDhhmmss_descricao.ts`.                                                                                                               |
| `rest/router.ts`       | Ingestão de leituras de sensores físicos: `POST /api/facilities/sensors/:projectId/:sensorId/readings`, autenticada por chave de API do dispositivo com hash bcrypt. |
| `helpers/types.ts`     | Tipos de registro do banco e de domínio.                                                                                                                             |

Domínios: facility (andares, espaços, sistemas, ativos, tipos de ativo com classificação IFC/COBie), código de identidade do ativo (`PHD-NNNNNN-C`), simulação de dispositivos (estado, telemetria, energia), manutenção (ordens), documentos (plantas, manuais, ARTs, com status e revisão), sensores, manutenção preditiva (injeção de falhas, sinais de saúde, relatórios de IA).

## Autorização

- Mutações chamam `assertCanManageFacility(ctx, projectId)` (em `graph/resolvers/facilities.ts`): exige usuário, regras de acesso do token ao projeto e `authPolicies.project.canPublish`. Toda mutação nova deve reutilizar esse gate. Para recursos filhos, resolver o `projectId` a partir do registro no banco, nunca do input do cliente.
- Leituras aninhadas em `Project`/`Facility` herdam o acesso ao projeto dado pelo Speckle. **Queries raiz por ID** (`Query.asset`, `Query.sensor`) precisam checar acesso ao projeto do registro explicitamente.
- A ingestão REST de sensores usa credencial própria do dispositivo, não sessão de usuário.

## Decisões registradas

- **Simulação em vez de MQTT**: o simulador AC foi implementado estendendo o simulador de dispositivos do módulo, não como serviço MQTT separado. O ponto de entrada para hardware real é a ingestão REST de sensores.
- **IA só com sinais estruturados**: o relatório de manutenção envia ao Claude os sinais calculados, nunca a telemetria bruta, e valida o JSON de resposta com `zod` puro.
- **Versões fixadas**: `zod` 3.22.4 é compartilhado com o `frontend-2` (não atualizar isoladamente); `@anthropic-ai/sdk` fixado em versão exata. **Não usar** `@anthropic-ai/sdk/helpers/zod` (importa `zod/v4`, que não existe na 3.22, e derrubou a produção).
- **Boot crítico**: todo start roda `migrateDbToLatest` e carrega todos os resolvers. Import quebrado em arquivo alcançável pelos resolvers, ou migração com erro, causa crash-loop do servidor inteiro.
- **Produção**: EC2 na AWS com `infra-aws/docker-compose.yml` + Caddy; segredos em `infra-aws/server.env` (fora do Git). O relatório de IA exige `ANTHROPIC_API_KEY` no servidor.
