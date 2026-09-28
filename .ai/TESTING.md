# Testes e validação: speckle-app

## Situação atual

- O upstream tem uma suíte Mocha em `packages/server` (`*.spec.ts`, helpers em `packages/server/test/`), que precisa das dependências Docker (Postgres, Redis, MinIO).
- Testes do módulo `facilities` ficam em `packages/server/modules/facilities/tests/`. Por enquanto só existe `rootQueryAccess.spec.ts` (acesso às queries raiz por ID). Ao planejar feature ou correção no módulo, incluir testes Mocha seguindo os padrões do upstream e desse arquivo (`testApolloServer`, `createTestUsers`, `createTestStreams`, inserção direta pelos repositórios), priorizando autorização (usuário sem acesso recebe erro) e regras de negócio.
- Pré-requisitos: Docker Desktop rodando e `packages/server/.env.test` (fora do Git; criar com `cp .env.test-example .env.test`). Sem o `.env.test`, o Mocha sai com código 0 e **sem rodar nenhum teste**: sempre conferir a contagem de "passing" na saída.

## Comandos

```bash
yarn dev:docker:up                          # sobe Postgres/Redis/MinIO locais
yarn workspace @speckle/server gqlgen       # após mudar .graphql
yarn workspace @speckle/server lint:tsc     # typecheck (obrigatório)
yarn workspace @speckle/server lint:eslint  # ESLint
yarn workspace @speckle/server build        # build

# um arquivo de teste (dentro de packages/server), sem rodar a suíte inteira:
npx cross-env TSX=true NODE_ENV=test LOG_FILTER=test yarn ts-mocha --reporter spec \
  modules/facilities/tests/<arquivo>.spec.ts -g "<describe>"
```

## Validação obrigatória antes de concluir

1. `gqlgen` sem diferença pendente, se o schema mudou.
2. `lint:tsc` e `lint:eslint` sem erros novos.
3. Se houver migração ou import novo: **subir o servidor localmente** (`yarn dev:server`) e confirmar que o boot termina, com migrações aplicadas e resolvers carregados. É o que evita crash-loop em produção.
4. Testes do módulo, se existirem para a área alterada.

Informe quais passos rodaram e o resultado. Se o ambiente Docker não estiver disponível, diga explicitamente que os testes e o boot não foram verificados.
