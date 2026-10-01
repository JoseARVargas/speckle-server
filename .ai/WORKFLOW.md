# Fluxo de trabalho: speckle-app (fork do Speckle Server + módulo facilities)

## Papéis dos agentes

| Agente          | Papel                                                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | Arquitetura, planejamento e implementação: entende o problema, avalia alternativas, decide a arquitetura, modelos de dados, contratos e requisitos de segurança; escreve o plano quando a mudança justificar; implementa, roda as validações de `TESTING.md` e relata o que fez, o que validou e o que ficou sem validar. |
| **Codex**       | Apoio sob demanda: atua quando o usuário pedir (revisão, tarefas paralelas, execução de um plano existente), seguindo as mesmas regras.                                                                                                                                                                                   |

- O Claude Code planeja **e implementa**. Para mudanças grandes ou arquiteturais, escreve antes o plano em `.ai/plans/` (registro das decisões e contexto para quem vier depois) e o mantém atualizado; mudanças pequenas não precisam de plano.
- Quem executa um plano segue o plano e os padrões do repositório. Se o plano estiver errado ou incompleto, ou se surgir uma decisão arquitetural que ele não cobre (padrão novo, dependência, modelo de dados, fronteira de segurança), o Claude Code registra a decisão e o motivo no plano; o Codex **para** e registra a dúvida no plano ou avisa o usuário.
- Instrução explícita do usuário prevalece sobre essa divisão. Mudança de papéis só vale quando o usuário a comunicar explicitamente.
- Os agentes podem trabalhar ao mesmo tempo. O repositório (código, planos, `git status`) é o canal entre eles; não presumir que o outro sabe o que foi conversado.

## Planos (`.ai/plans/`)

Nome do arquivo: `AAAA-MM-DD-<tarefa-curta>.md`. O plano deve ser executável por quem não participou da conversa.

```markdown
# <Título>

Status: proposto | aprovado | em execução | concluído

## Contexto

Problema, motivação, estado atual relevante (com caminhos de arquivo).

## Decisões

O que foi decidido e por quê; alternativas descartadas.

## Arquivos afetados

## Etapas

1. Cada etapa pequena e verificável.

## Critérios de aceite

## Segurança

Categorias OWASP envolvidas e como cada uma é tratada.

## Validação

Comandos de TESTING.md e testes manuais esperados.

## Fora do escopo

## Notas da execução

(Preenchido por quem implementou: o que foi feito, desvios do plano, o que não foi validado.)
```

## Git (regras comuns)

- Não criar commits, fazer push, reset, rebase, force-push nem apagar branches sem pedido explícito do usuário.
- Antes de mudanças substanciais, rodar `git status`/`git diff`. Arquivos com alterações que não são suas pertencem a outro agente ou ao usuário: não sobrescrever nem descartar.
- Ao terminar, revisar o diff final e apontar arquivos alterados fora do escopo.

## Git e deploy neste repositório

- Este repositório é um **fork** do `specklesystems/speckle-server`. Remotes: `origin` = upstream da Speckle (**nunca fazer push**), `fork` = `JoseARVargas/speckle-server` (destino dos pushes, só com autorização explícita).
- Branch de trabalho atual: `feat/digital-twin-assets-api`.
- Commits em inglês, estilo Conventional Commits (`feat:`, `fix:`, `chore(infra):`), como no upstream. O hook `pre-commit` roda `lint-staged` e, se instalados, `pre-commit`, `hadolint`, `helm` etc. Nunca pular hooks.
- **Deploy:** servidor na AWS (EC2) com `infra-aws/docker-compose.yml` + Caddy. Os segredos ficam em `infra-aws/server.env` (ignorado pelo Git; modelo em `server.env.example`). Deploy é ação do usuário ou exige autorização explícita.
- **Todo boot roda as migrações e carrega todos os resolvers GraphQL.** Uma migração quebrada, ou um import quebrado em arquivo alcançável pelos resolvers, derruba o servidor inteiro em crash-loop, não só a feature. Tratar migrações e novos imports como críticos: validar localmente (build + subir o servidor) antes de qualquer deploy.
- Mudança no contrato GraphQL do módulo `facilities` afeta o frontend no repositório separado `speckle-digitaltwin-console` (NexTwin). O plano deve cobrir os dois lados, ou declarar explicitamente que o outro lado fica para depois.
