# Atendimento IA RevGás

Bot de atendimento com IA para revendas de GLP, integrado ao ERP RevGás. Projeto acadêmico
(iCEV — Escola de Tecnologia Aplicada) em parceria com a RevGás. Foco da v1: **criar venda** a partir
de uma conversa. Começa com chat simulado; WhatsApp entra depois atrás da mesma interface de canal.

## Leia antes de qualquer trabalho

- Design aprovado: `docs/superpowers/specs/2026-11-20-atendimento-ia-revgas-design.md`
- Plano de implementação (tarefas 1–10, TDD): `docs/superpowers/plans/2026-11-20-atendimento-ia-revgas-v1.md`
- Executar o plano tarefa a tarefa, marcando os checkboxes. Não pular a etapa de teste que falha.

## Stack

Node 24 · TypeScript estrito · pnpm workspaces (`apps/server`, `apps/web`, `packages/shared`) ·
Fastify 5 + WebSocket · Zod · Drizzle + PostgreSQL 17 (Docker Compose) · `@anthropic-ai/sdk` ·
React + Vite · Vitest.

## Comandos (depois da Task 1)

- `docker compose up -d` — sobe o Postgres
- `pnpm install`
- `pnpm --filter server db:migrate`
- `pnpm dev` — servidor (porta 3333) + chat web
- `pnpm -r test` · `pnpm -r exec tsc --noEmit`

## Regras invioláveis

1. **Nenhuma venda real na RevGás** até a RevGás confirmar que é seguro. `REVGAS_WRITE_ENABLED`
   fica `false`; não mude isso, não rode `POST /v1/sales` com curl, nem "só para testar".
   Leituras (`GET` clientes, produtos, vendas) são permitidas.
2. **Segredos:** `REVGAS_API_KEY` e `ANTHROPIC_API_KEY` só no `.env` (gitignored). Nunca escrever o
   valor em código, testes, logs, mensagens de commit, README ou respostas no chat.
3. **A IA não decide dinheiro:** preço vem de `apps/server/config/prices.json`; o resumo do pedido é
   gerado pelo código; a venda só é criada por `OrderService.confirm`, que exige resumo apresentado +
   resposta posterior do cliente. Nunca mover essas regras para o prompt.
4. **Limite RevGás: 1 requisição/segundo global.** Tudo passa pelo `RateLimiter`.
5. **Sem retry automático de `POST /sales`** em timeout/5xx/rede: marca `uncertain` e passa para humano.
6. Histórico com a IA é **append-only** (`llm_turns`): guardar e reenviar os blocos de `content`
   exatamente como vieram (inclusive `thinking`).
7. Textos para cliente/atendente em português do Brasil. Código, nomes e commits em inglês.

## API RevGás — o essencial

- Docs: https://revgas.stoplight.io/docs/revgas-api (renderiza com JS; use navegador se precisar)
- Base `https://api.revgas.com/v1`, header `Authorization: <API_KEY>` (sem "Bearer").
- Estabelecimento do token: **2580 "RevGás - Técnico"** (conta técnica). A conta também vê 2601 "Filial 2".
- `GET /customers?phone=86999998888` (padrão `^(\+?55)?\d{10,11}$`), `GET /products?establishment_id=&page=&page_size=`
  (sem preço!), `POST /sales`, `GET /sales/{id}`. Paginação: `{ pagination: { has_next }, data: [...] }`.
- Venda: endereço (`location`, `number`, `neighborhood`, `city`, `state_federation`, `complement`,
  `landmark`), `customer_id?`, `establishment_id`, `products[{product_id, quantity, value}]`,
  `payments[{payment_type, value}]`, `channel: "WHATSAPP"`, `origin: "INTEGRATION"`,
  `option: "NORMAL"`, `broadcast: "NONE"` (padrão; `NEW_SALE` pode notificar entregador real).
- Status da venda: `OPEN`, `ACTIVE`, `WARNING`, `CONFIRM`, `CHECK`, `CANCEL`.
- Erros: 400/422 inválido · 401/402/403 auth · 409 lock (repetir) ou duplicado · 429 limite · 500.
- Datas de listagem: intervalo máximo 366 dias; sem filtro = mês atual.

## IA (Claude)

- `client.beta.messages.create` com `model: ANTHROPIC_MODEL` (padrão `claude-opus-5-5`),
  `max_tokens: 16000`, `output_config: { effort: ANTHROPIC_EFFORT }` (padrão `medium`),
  `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`.
- Não enviar `thinking`, `temperature`, nem `tool_choice` `any`/`tool` (400 no Opus 5.5).
- Ferramentas com `strict: true` + validação Zod do `input`. Checar `stop_reason === "refusal"`.
- Em dúvida sobre o SDK, use a skill `claude-api` em vez de adivinhar.

## Perguntas em aberto com a RevGás

1. Fonte real do preço dos produtos. 2. Liberação para criar/cancelar vendas no 2580.
3. Se `broadcast: NEW_SALE` notifica entregadores reais. 4. Se venda sem `customer_id` é aceita.
