# Regras de código: speckle-app

Valem junto com as regras globais dos agentes (escopo mínimo, seguir padrões existentes, OWASP Top 10:2025) e com as regras do upstream (`CONTRIBUTING.md`, ESLint e Prettier do repositório).

## Limites do fork

- Código novo vai para `packages/server/modules/facilities/` e `packages/server/assets/facilities/typedefs/`. Tocar no core só nos pontos de contato já usados (`dbSchema.ts`, `envHelper.ts`) e só quando necessário.
- Não refatorar, formatar nem "corrigir" código do upstream fora da tarefa. Isso gera conflitos ao atualizar o fork.
- Não mexer nas alterações locais de `infra-aws/`, `packages/server/bin/`, `esmLoader.js`, `Dockerfile` e `utils/` sem pedido: são ajustes de ambiente do usuário.

## Convenções (seguir o módulo existente)

- TypeScript; imports com alias `@/` a partir de `packages/server`. Código, comentários e mensagens de commit em **inglês**, como no restante do fork.
- Repositórios Knex no padrão factory (`getXFactory({ db })(params)`), tabelas declaradas em `modules/core/dbSchema.ts`.
- Paginação por cursor (`limit` + `cursor` + `totalCount`), como nos resolvers existentes.
- Erros com as classes do Speckle (`ForbiddenError`, `BadRequestError`), nunca `Error` genérico em resolver.
- Logs pelo logger do Speckle (`moduleLogger` e afins), não `console.log`.
- Schema GraphQL: editar o `.graphql` e rodar `yarn gqlgen` para regenerar `generated/graphql.ts`. Não editar o arquivo gerado à mão.
- Migrações: arquivo novo em `modules/facilities/migrations/` com timestamp posterior ao último; nunca editar migração já aplicada em produção. Toda migração tem `down`.
- Dependência nova ou atualização em `packages/server`: justificar no plano, fixar versão exata e checar compatibilidade com `zod` 3.22.4. Import novo em arquivo alcançável pelos resolvers é crítico para o boot.

## Segurança (OWASP, específicas deste repo)

- **A01:** toda mutação chama `assertCanManageFacility` com o `projectId` **do registro no banco**. Toda query raiz por ID verifica acesso ao projeto do registro. Controles de dispositivo respeitam `assertAssetIsControllable` no servidor.
- **A04/A07:** chaves de sensores só armazenadas com hash (bcrypt) e mostradas uma única vez. Segredos só via `envHelper` e `server.env`, nunca commitados.
- **A05:** queries só pelo Knex com parâmetros; nada de `knex.raw` com interpolação de input.
- **A05 (LLM):** o prompt do relatório de manutenção usa só dados estruturados; a resposta do modelo é validada com `zod` antes de ser persistida.
- **A06:** ingestão REST de sensores com limite de tamanho e taxa. A geração de relatório por IA (custo) precisa de limite por projeto.
- **A10:** falhas do worker de simulação e da API da Anthropic não podem derrubar o processo; mensagem clara ao cliente, detalhe no log.
