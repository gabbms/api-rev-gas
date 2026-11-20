# Atendimento IA RevGás v1 — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um chat simulado onde um "cliente" pede gás em linguagem natural, a IA monta o pedido, o
código gera o resumo e, após um "sim", a venda é criada na RevGás (`POST /v1/sales`).

**Architecture:** Monorepo pnpm com `apps/server` (Fastify + WebSocket, Postgres via Drizzle,
agente Claude com loop manual de tool use), `apps/web` (React + Vite, chat simulado) e
`packages/shared` (schemas Zod do protocolo WebSocket). A IA só conversa e pede ferramentas; preço,
validação, resumo, confirmação e criação da venda são código determinístico em `orders/`.

**Tech Stack:** Node 24, TypeScript estrito, pnpm workspaces, Fastify 5 + `@fastify/websocket`,
Zod, Drizzle ORM + `pg`, PostgreSQL 17 (Docker Compose), `@anthropic-ai/sdk`, React + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-atendimento-ia-revgas-design.md` (ler antes de começar).

## Global Constraints

- Todo texto voltado ao cliente/atendente em **português do Brasil**.
- Segredos só em `.env` (nunca commitado, nunca logado, nunca enviado ao front-end). `.env.example` sem valores.
- `REVGAS_WRITE_ENABLED=false` por padrão. **Nenhuma venda real é criada** até a RevGás confirmar (decisão do usuário). Com `false`, o servidor usa `FakeRevgasClient` para escrita.
- Toda chamada à RevGás passa por um único limitador: **no máximo 1 requisição por segundo**, global.
- Base RevGás: `https://api.revgas.com/v1`, header `Authorization: <REVGAS_API_KEY>` (sem "Bearer").
- Venda sempre com `channel: "WHATSAPP"`, `origin: "INTEGRATION"`, `option: "NORMAL"`, `establishment_id = REVGAS_ESTABLISHMENT_ID` (padrão `2580`), `broadcast = REVGAS_BROADCAST` (padrão `"NONE"`), sem `deliverer_id`.
- Formas de pagamento aceitas na v1: `PIX`, `MONEY`, `CARTAO_DE_CREDITO`, `CARTAO_DE_DEBITO`, `VALEGAS`.
- Preço vem de `apps/server/config/prices.json` (`{ "<product_id>": <preço em reais> }`). Produto sem preço não é vendável.
- Dinheiro em **centavos inteiros** dentro do código; converte para reais (`number` com 2 casas) só no payload da RevGás.
- IA: `ANTHROPIC_MODEL` (padrão `claude-opus-5-5`), `ANTHROPIC_EFFORT` (padrão `medium`, enviado explicitamente em `output_config.effort`), sem parâmetro `thinking` (Opus 5.5 roda adaptativo), sem `temperature`. Usar `client.beta.messages.create` com `betas: ["server-side-fallback-2026-07-01"]` e `fallbacks: "default"`. Checar `stop_reason === "refusal"` antes de ler `content`.
- Histórico com a IA é **append-only**: guardar o `content` completo de cada resposta (todos os blocos, inclusive `thinking`) e reenviá-lo sem editar.
- Tool use: `tool_choice` `auto` (Opus 5.5 rejeita `any`/`tool`), ferramentas com `strict: true` e `additionalProperties: false`; ainda assim validar cada `input` com Zod antes de executar.
- TDD em todas as tarefas com lógica; commits pequenos com mensagem em inglês no formato `feat:`/`test:`/`chore:`.

## Review Focus

1. **"Sim" duplicado ou simultâneo** (cliente manda "sim" duas vezes rápido) → exatamente uma venda. Teste em Task 5.
2. **Pedido alterado depois do resumo** ("na verdade são 2") e depois "sim" → não confirma o rascunho antigo; um resumo novo é enviado antes. Teste em Task 5.
3. **Falha incerta no POST** (timeout/5xx) → nenhuma nova tentativa automática, rascunho `incerto`, conversa vai para humano. Teste em Tasks 3 e 5.
4. **Telefone em formatos variados** (`+55 (86) 99999-8888`, `5586999998888`, `86999998888`) → mesma busca na RevGás. Teste em Task 3.
5. **Mensagem do cliente enquanto a conversa está com humano** → bot não responde nem chama a IA. Teste em Task 7.

---

## Estrutura de arquivos

```
docker-compose.yml  .env.example  .gitignore  package.json  pnpm-workspace.yaml  tsconfig.base.json
packages/shared/src/protocol.ts        # schemas Zod das mensagens WebSocket
apps/server/
  config/prices.json                   # tabela de preços local (demo)
  drizzle.config.ts
  src/config.ts                        # leitura/validação do .env
  src/db/schema.ts  src/db/client.ts   # tabelas Drizzle + conexão
  src/revgas/phone.ts                  # normalização de telefone
  src/revgas/rateLimiter.ts            # fila 1 req/s
  src/revgas/types.ts                  # schemas Zod RevGás + interface RevgasClient
  src/revgas/httpClient.ts             # implementação real
  src/revgas/fakeClient.ts             # implementação em memória
  src/catalog/catalog.ts               # produtos + preços, com cache
  src/orders/draft.ts                  # validação pura + resumo
  src/orders/orderService.ts           # rascunho persistido, confirmação, criação da venda
  src/agent/tools.ts  src/agent/systemPrompt.ts  src/agent/agent.ts
  src/conversations/conversationService.ts
  src/http/server.ts                   # Fastify, rotas e WebSocket
  src/main.ts
  test/**                              # espelha src/
apps/web/src/{App.tsx, ChatPane.tsx, AttendantPane.tsx, ws.ts}
```

---

### Task 1: Esqueleto do monorepo, config e banco

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `docker-compose.yml`, `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/drizzle.config.ts`, `apps/server/src/config.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts`
- Already exist (do not overwrite): `.gitignore`, `.env`, `.env.example`, `CLAUDE.md` (inclui `DATABASE_URL_TEST`, usado só pelos testes)
- Test: `apps/server/test/config.test.ts`, `apps/server/test/db/schema.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig` com campos `databaseUrl`, `revgasApiKey`, `revgasBaseUrl` (padrão `https://api.revgas.com/v1`), `revgasEstablishmentId: number` (padrão 2580), `revgasWriteEnabled: boolean` (padrão false), `revgasBroadcast: "NONE" | "NEW_SALE"` (padrão `"NONE"`), `anthropicApiKey`, `anthropicModel` (padrão `"claude-opus-5-5"`), `anthropicEffort: "low"|"medium"|"high"` (padrão `"medium"`), `port` (padrão 3333), `maxItemQuantity` (padrão 10).
- Produces: `createDb(url: string)` retornando `{ db, close }` (Drizzle sobre `pg.Pool`).
- Produces tabelas (`schema.ts`):
  - `conversations`: `id uuid pk`, `phone text unique not null` (normalizado), `mode text not null default 'bot'` (`'bot' | 'human'`), `handoffReason text null`, `revgasCustomerId bigint null`, `createdAt`, `updatedAt`.
  - `messages`: `id uuid pk`, `conversationId fk`, `author text` (`'customer' | 'bot' | 'attendant' | 'system'`), `text text not null`, `createdAt timestamptz default now()`.
  - `llm_turns`: `id bigserial pk`, `conversationId fk`, `role text` (`'user' | 'assistant'`), `content jsonb not null` (blocos exatamente como enviados/recebidos), `createdAt`. Append-only.
  - `order_drafts`: `id uuid pk`, `conversationId fk`, `status text` (`'open' | 'sending' | 'created' | 'failed' | 'uncertain'`), `payload jsonb not null` (o `DraftData` da Task 4), `totalCents integer`, `summaryText text`, `presentedAt timestamptz null`, `revgasSaleId bigint null`, `errorMessage text null`, `createdAt`, `updatedAt`. Índice único parcial: no máximo um draft com `status in ('open','sending')` por conversa.

- [ ] **Step 1:** `git init`, criar workspace pnpm (`apps/*`, `packages/*`), scripts na raiz `dev` (server + web em paralelo) e `test` (`pnpm -r test`), scripts no server `dev` (`tsx watch src/main.ts`), `test` (`vitest run`), `db:generate` e `db:migrate` (drizzle-kit), `tsconfig.base.json` com `"strict": true`, `"module": "NodeNext"`, `"target": "ES2023"`. Instalar no server: `fastify @fastify/websocket zod drizzle-orm pg @anthropic-ai/sdk dotenv` e dev `typescript tsx vitest drizzle-kit @types/pg @types/node`.
- [ ] **Step 2:** `docker-compose.yml` com serviço `postgres:17`, porta `5432`, banco `revgas_bot`, usuário/senha `revgas`/`revgas`, volume nomeado; e um segundo banco `revgas_bot_test` criado por script de init.
- [ ] **Step 3: Teste que falha** — `config.test.ts`:
  - `loadConfig({})` lança erro que menciona `REVGAS_API_KEY`.
  - Com só os obrigatórios (`DATABASE_URL`, `REVGAS_API_KEY`, `ANTHROPIC_API_KEY`): `revgasWriteEnabled === false`, `revgasBroadcast === "NONE"`, `revgasEstablishmentId === 2580`, `anthropicModel === "claude-opus-5-5"`.
  - `REVGAS_WRITE_ENABLED="true"` → `true`; qualquer outro valor → `false`.
  - A mensagem de erro **não** contém o valor de nenhuma variável.
- [ ] **Step 4:** Rodar `pnpm --filter server test` → FAIL.
- [ ] **Step 5:** Implementar `loadConfig` com Zod.
- [ ] **Step 6:** Implementar `schema.ts`, `client.ts`, gerar migração (`pnpm --filter server drizzle-kit generate`). Teste `schema.test.ts` (usa `DATABASE_URL_TEST`): aplica migrações, insere conversa, e **inserir dois drafts `open` na mesma conversa falha** com violação de unicidade.
- [ ] **Step 7:** `docker compose up -d` e `pnpm --filter server test` → PASS.
- [ ] **Step 8:** Commit `chore: scaffold monorepo, config and database schema`.

---

### Task 2: Limitador de 1 req/s e normalização de telefone

**Files:**
- Create: `apps/server/src/revgas/rateLimiter.ts`, `apps/server/src/revgas/phone.ts`
- Test: `apps/server/test/revgas/rateLimiter.test.ts`, `apps/server/test/revgas/phone.test.ts`

**Interfaces:**
- Produces: `class RateLimiter { constructor(minIntervalMs: number, now?: () => number, sleep?: (ms: number) => Promise<void>); schedule<T>(fn: () => Promise<T>): Promise<T> }` — executa em série, garantindo `minIntervalMs` entre o **início** de chamadas consecutivas.
- Produces: `normalizePhone(raw: string): string | null` → só dígitos, sem `55` de país, 10 ou 11 dígitos; `null` se inválido.

- [ ] **Step 1: Testes que falham**
  - `rateLimiter`: com relógio falso, 3 chamadas agendadas ao mesmo tempo iniciam em t=0, 1000, 2000; uma chamada que rejeita não trava as seguintes; resultados voltam na ordem certa.
  - `phone`: `"+55 (86) 99999-8888"`, `"5586999998888"`, `"86999998888"` → `"86999998888"`; `"8633334444"` → `"8633334444"`; `"123"` → `null`; `""` → `null`.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar. **Step 4:** Rodar → PASS.
- [ ] **Step 5:** Commit `feat: add RevGás rate limiter and phone normalization`.

---

### Task 3: Cliente RevGás (real e falso)

**Files:**
- Create: `apps/server/src/revgas/types.ts`, `apps/server/src/revgas/httpClient.ts`, `apps/server/src/revgas/fakeClient.ts`
- Test: `apps/server/test/revgas/httpClient.test.ts`, `apps/server/test/revgas/fakeClient.test.ts`

**Interfaces:**
- Consumes: `RateLimiter`, `normalizePhone` (Task 2), `AppConfig` (Task 1).
- Produces (`types.ts`):
  ```ts
  type RevgasCustomer = { id: number; name: string; location: string | null; number: string | null;
    neighborhood: string | null; city: string | null; state_federation: string | null;
    complement: string | null; landmark: string | null };
  type RevgasProduct = { id: number; description: string; inactive: boolean; establishment_id: number };
  type SalePayload = { location: string; number: string; neighborhood: string; city: string;
    state_federation: string; complement?: string; landmark?: string; observation?: string;
    customer_id?: number; establishment_id: number;
    products: { product_id: number; quantity: number; value: number }[];
    payments: { payment_type: PaymentType; value: number }[];
    channel: "WHATSAPP"; origin: "INTEGRATION"; option: "NORMAL"; broadcast: "NONE" | "NEW_SALE" };
  type RevgasSale = { id: number; status: "CANCEL"|"OPEN"|"ACTIVE"|"WARNING"|"CONFIRM"|"CHECK"; total: number };
  type PaymentType = "PIX" | "MONEY" | "CARTAO_DE_CREDITO" | "CARTAO_DE_DEBITO" | "VALEGAS";
  type RevgasErrorKind = "invalid" | "auth" | "rate_limited" | "conflict_lock" | "duplicate" | "server" | "network";
  class RevgasError extends Error { constructor(kind: RevgasErrorKind, message?: string, status?: number); kind: RevgasErrorKind; status?: number }
  interface RevgasClient {
    findCustomersByPhone(phone: string): Promise<RevgasCustomer[]>;
    listProducts(establishmentId: number): Promise<RevgasProduct[]>;   // percorre todas as páginas
    createSale(payload: SalePayload): Promise<RevgasSale>;
    getSale(id: number): Promise<RevgasSale>;
  }
  ```
  Schemas Zod usam `.passthrough()`/campos opcionais para não quebrar com campos extras da API.
- Produces: `class HttpRevgasClient implements RevgasClient { constructor(cfg: AppConfig, limiter: RateLimiter, fetchFn?: typeof fetch) }` — rotas `GET /customers?phone=`, `GET /products?establishment_id=&page=&page_size=100` (segue `pagination.has_next`), `POST /sales`, `GET /sales/{id}`.
- Produces: `class FakeRevgasClient implements RevgasClient { customers: RevgasCustomer[]; products: RevgasProduct[]; sales: (SalePayload & { id: number })[]; failNextCreateWith?: RevgasError }`.
- Produces: `createRevgasClient(cfg: AppConfig): RevgasClient` — leituras sempre reais; se `!cfg.revgasWriteEnabled`, `createSale` é delegado a um `FakeRevgasClient` e loga `"[revgas] escrita desligada: venda simulada"`.

- [ ] **Step 1: Testes que falham** (`httpClient.test.ts`, com `fetchFn` falso e `RateLimiter(0)`):
  - Envia header `Authorization` igual à chave e nunca a inclui em mensagens de erro.
  - `findCustomersByPhone("+55 86 99999-8888")` chama `.../customers?phone=86999998888`.
  - `listProducts(2580)` junta duas páginas quando a primeira tem `has_next: true`.
  - Mapeia status → `kind`: 400/422 `invalid`, 401/402/403 `auth`, 429 `rate_limited`, 409 com `"lock"` na mensagem `conflict_lock`, 409 com `data[].value_id` `duplicate`, 5xx `server`, exceção de rede/timeout `network`.
  - 429 e `conflict_lock` são repetidos até 3 vezes (com espera); `server` e `network` em `createSale` **não** são repetidos.
  - `createRevgasClient` com `revgasWriteEnabled=false`: `createSale` não chama `fetchFn`.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar. **Step 4:** Rodar → PASS.
- [ ] **Step 5:** Teste manual de leitura real (sem escrita): script `apps/server/scripts/smoke-read.ts` que lista 3 produtos e busca um telefone passado por argumento; imprime só ids e descrições. Rodar `pnpm --filter server tsx scripts/smoke-read.ts 86999998888`. Esperado: lista de produtos do estabelecimento 2580, sem erro 401.
- [ ] **Step 6:** Commit `feat: add RevGás HTTP and fake clients`.

---

### Task 4: Catálogo, preços e rascunho puro

**Files:**
- Create: `apps/server/config/prices.json`, `apps/server/src/catalog/catalog.ts`, `apps/server/src/orders/draft.ts`
- Test: `apps/server/test/catalog/catalog.test.ts`, `apps/server/test/orders/draft.test.ts`

**Interfaces:**
- Consumes: `RevgasClient`, `RevgasProduct`, `PaymentType` (Task 3).
- Produces: `type SellableProduct = { productId: number; description: string; priceCents: number }`.
- Produces: `class Catalog { constructor(client: RevgasClient, establishmentId: number, prices: Record<string, number>, ttlMs = 10 * 60_000, now?: () => number); list(): Promise<SellableProduct[]>; get(productId: number): Promise<SellableProduct | null> }` — só produtos ativos, do estabelecimento, **com preço** na tabela; cache por `ttlMs`.
- Produces (`draft.ts`):
  ```ts
  type DraftInput = { items: { productId: number; quantity: number }[];
    address: { location: string; number: string; neighborhood: string; city: string; state: string;
               complement?: string; landmark?: string };
    payments: { type: PaymentType; amountCents?: number }[]; observation?: string };
  type DraftData = DraftInput & { lines: { productId: number; description: string; quantity: number;
    unitCents: number; totalCents: number }[]; totalCents: number; customerId: number | null };
  type DraftResult = { ok: true; data: DraftData; summaryText: string } | { ok: false; errors: string[] };
  function buildDraft(input: DraftInput, products: SellableProduct[], customerId: number | null, maxQty: number): DraftResult;
  function toSalePayload(d: DraftData, establishmentId: number, broadcast: "NONE" | "NEW_SALE"): SalePayload;
  ```
  Regras: produto inexistente/sem preço → erro `"Produto <id> não disponível"`; quantidade inteira entre 1 e `maxQty`; endereço com `location`, `number`, `neighborhood`, `city`, `state` não vazios; um pagamento sem `amountCents` recebe o total; soma dos pagamentos ≠ total → erro `"Pagamentos não somam o total"`. Itens repetidos do mesmo produto são somados.
- `summaryText` (texto exato, uma linha por item, valores em `R$ 0,00`):
  ```
  Resumo do pedido:
  • 1x GLP 13KG — R$ 110,00
  Total: R$ 110,00
  Pagamento: Pix
  Entrega: Rua das Flores, 120 – Centro, Teresina/PI
  Posso registrar o pedido? Responda *sim* para confirmar ou me diga o que mudar.
  ```
  Nomes de pagamento: `PIX`→`Pix`, `MONEY`→`Dinheiro`, `CARTAO_DE_CREDITO`→`Cartão de crédito`, `CARTAO_DE_DEBITO`→`Cartão de débito`, `VALEGAS`→`Vale Gás`. Complemento/ponto de referência entram entre parênteses quando existirem; observação em linha própria `Obs.: ...`.

- [ ] **Step 1:** `prices.json` com preços de demonstração para os ids `23740` (GLP 13KG) e outros produtos ativos de 2580 encontrados no smoke test da Task 3 (valores fictícios, ex.: `110.00`).
- [ ] **Step 2: Testes que falham**
  - Catalog: produto sem preço na tabela não aparece em `list()`; produto `inactive` não aparece; segunda chamada dentro do TTL não chama `listProducts` de novo; após o TTL chama.
  - buildDraft: caso feliz gera `totalCents` 22000 para 2× de 11000 e o `summaryText` exato acima (para 1×); produto desconhecido → erro; quantidade 0 e `maxQty+1` → erro; endereço sem número → erro; `MONEY` 5000 + `PIX` 6000 com total 11000 → ok; soma errada → erro; mesmo produto duas vezes → uma linha com quantidade somada.
  - toSalePayload: valores em reais (`110` para 11000 centavos), campos fixos (`WHATSAPP`, `INTEGRATION`, `NORMAL`), `customer_id` ausente quando `customerId` é `null`, sem `deliverer_id`.
- [ ] **Step 3:** Rodar → FAIL. **Step 4:** Implementar. **Step 5:** Rodar → PASS.
- [ ] **Step 6:** Commit `feat: add catalog with local prices and pure order draft`.

---

### Task 5: Serviço de pedidos (confirmação e venda sem duplicidade)

**Files:**
- Create: `apps/server/src/orders/orderService.ts`
- Test: `apps/server/test/orders/orderService.test.ts` (banco de teste real + `FakeRevgasClient`)

**Interfaces:**
- Consumes: `db` (Task 1), `Catalog`, `buildDraft`, `toSalePayload`, `DraftInput` (Task 4), `RevgasClient` (Task 3).
- Produces:
  ```ts
  class OrderService {
    constructor(db, catalog: Catalog, revgas: RevgasClient, cfg: AppConfig);
    upsertDraft(conversationId: string, input: DraftInput, customerId: number | null): Promise<DraftResult & { draftId?: string }>;
      // substitui o draft 'open' da conversa (ou cria); SEMPRE zera presentedAt
    markPresented(draftId: string, at: Date): Promise<void>;
    confirm(conversationId: string): Promise<ConfirmResult>;
    getLatestSale(conversationId: string): Promise<RevgasSale | null>;   // usa revgas.getSale
  }
  type ConfirmResult =
    | { kind: "created"; saleId: number }
    | { kind: "already_created"; saleId: number }
    | { kind: "not_ready"; reason: "no_draft" | "not_presented" | "no_reply_after_summary" | "in_progress" }
    | { kind: "rejected"; message: string }        // RevgasError invalid/duplicate → draft 'failed'
    | { kind: "uncertain" };                       // server/network → draft 'uncertain'
  ```
  `confirm` regras, nesta ordem:
  1. Draft `open` da conversa não existe → se o último draft é `created`, `already_created`; senão `not_ready/no_draft`.
  2. `presentedAt` nulo → `not_presented`.
  3. Não existe mensagem `author='customer'` com `createdAt > presentedAt` → `no_reply_after_summary`.
  4. `UPDATE order_drafts SET status='sending' WHERE id=$1 AND status='open'` — se 0 linhas afetadas → `in_progress`.
  5. `createSale(toSalePayload(...))` → `created` (grava `revgasSaleId`) | `rejected` | `uncertain`.

- [ ] **Step 1: Testes que falham**
  - Fluxo feliz: upsert → markPresented(t0) → mensagem do cliente em t0+1s → confirm → `created`; `FakeRevgasClient.sales.length === 1`.
  - Confirm sem markPresented → `not_presented`; markPresented sem mensagem posterior → `no_reply_after_summary`.
  - **Review Focus 1:** dois `confirm` em paralelo (`Promise.all`) → um `created` e um `in_progress` ou `already_created`; `sales.length === 1`. Um terceiro `confirm` depois → `already_created`.
  - **Review Focus 2:** upsert → markPresented → mensagem do cliente → upsert de novo (quantidade 2) → confirm → `not_presented`; nenhuma venda criada.
  - **Review Focus 3:** `failNextCreateWith = new RevgasError("network")` → `uncertain`, draft `uncertain`, e um novo `confirm` **não** chama `createSale` de novo (`no_draft`).
  - `failNextCreateWith` `invalid` → `rejected` com a mensagem da API, draft `failed`.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar. **Step 4:** Rodar → PASS.
- [ ] **Step 5:** Commit `feat: add order service with confirmation gate and idempotent sale creation`.

---

### Task 6: Agente (ferramentas + loop com Claude)

**Files:**
- Create: `apps/server/src/agent/tools.ts`, `apps/server/src/agent/systemPrompt.ts`, `apps/server/src/agent/agent.ts`
- Test: `apps/server/test/agent/agent.test.ts` (cliente Anthropic falso com respostas roteirizadas)

**Interfaces:**
- Consumes: `OrderService` (Task 5), `Catalog` (Task 4), `RevgasClient` (Task 3), tabela `llm_turns` (Task 1).
- Produces:
  ```ts
  type ToolContext = { conversationId: string; phone: string; customerId: number | null;
    events: { draftPresentable?: { draftId: string; summaryText: string }; handoff?: { reason: string } } };
  const toolDefinitions: Anthropic.Beta.BetaTool[];   // nomes abaixo, strict: true
  function runTool(name: string, input: unknown, ctx: ToolContext, deps: AgentDeps): Promise<{ content: string; isError: boolean }>;
  type AgentDeps = { anthropic: Pick<Anthropic, "beta">; orders: OrderService; catalog: Catalog; revgas: RevgasClient; db; cfg: AppConfig };
  function runAgentTurn(ctx: ToolContext, customerText: string, deps: AgentDeps): Promise<{ replyText: string | null; events: ToolContext["events"] }>;
  ```
  Ferramentas (descrições em português, entrada validada com Zod):
  - `buscar_cliente` `{}` → usa `ctx.phone` (a IA nunca escolhe o telefone). Mais de um cliente → devolve a lista de nomes e instrução para perguntar qual é. Grava `revgasCustomerId` na conversa quando houver exatamente um.
  - `listar_produtos` `{}` → `[{ productId, description, preco: "R$ 110,00" }]`.
  - `montar_pedido` `DraftInput` → `upsertDraft`; se ok, coloca `events.draftPresentable` e devolve `"Resumo gerado; o sistema vai enviá-lo ao cliente. Não repita preços."`; se erro, devolve os erros (`isError: true`).
  - `confirmar_pedido` `{}` → `confirm`; devolve texto para cada `ConfirmResult` (`created` → `"Venda <id> criada"`; `not_ready` → explicação; `uncertain` → coloca `events.handoff` com motivo `"Falha incerta ao registrar venda"`; `rejected` → coloca `events.handoff` com motivo `"RevGás recusou a venda: <mensagem>"`).
  - `consultar_pedido` `{}` → `getLatestSale`, status traduzido (`OPEN` Aberto, `ACTIVE` Em andamento, `WARNING` Avisado, `CONFIRM` Confirmado/entregue, `CHECK` Conferido, `CANCEL` Cancelado).
  - `chamar_atendente` `{ motivo: string }` → `events.handoff`.
  Loop: carrega `llm_turns` da conversa, acrescenta `{ role: "user", content: customerText }`, chama `anthropic.beta.messages.create({ model, max_tokens: 16000, system, tools, messages, output_config: { effort }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })`; grava cada resposta e cada lote de `tool_result` em `llm_turns` (append-only); para em `end_turn`; teto de 8 iterações (se estourar → `events.handoff` motivo `"Limite de passos da IA"`); `refusal` → `events.handoff` motivo `"IA recusou"`. `replyText` = texto final da IA (pode ser `null`).
  System prompt (`systemPrompt.ts`): atendente virtual de revenda de gás, português do Brasil, mensagens curtas como WhatsApp; sempre `buscar_cliente` no início da conversa; nunca informar preço que não veio de `listar_produtos`; nunca dizer que o pedido foi registrado sem `confirmar_pedido` retornar `created`; só chamar `confirmar_pedido` quando o cliente aprovar o último resumo; usar `chamar_atendente` para reclamação, cancelamento, pedido de humano ou após duas tentativas sem entender; não inventar prazos de entrega.

- [ ] **Step 1: Testes que falham** (Anthropic falso devolve `tool_use` roteirizados):
  - Roteiro "quero um botijão": `buscar_cliente` → `listar_produtos` → `montar_pedido` → texto final. Esperado: `events.draftPresentable` preenchido; `llm_turns` cresce só por append (os blocos da 1ª resposta continuam idênticos no banco após o turno).
  - Input inválido em `montar_pedido` (quantidade `"dois"`) → `tool_result` com `is_error: true`, sem chamar `upsertDraft`.
  - `stop_reason: "refusal"` → `events.handoff`.
  - 9 respostas seguidas com `tool_use` → para em 8 e `events.handoff`.
  - Requisição enviada contém `output_config.effort`, `fallbacks: "default"`, `tool_choice` ausente ou `auto`, e não contém `temperature` nem `thinking`.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar. **Step 4:** Rodar → PASS.
- [ ] **Step 5:** Commit `feat: add Claude agent with order tools`.

---

### Task 7: Serviço de conversas e passagem para humano

**Files:**
- Create: `apps/server/src/conversations/conversationService.ts`
- Test: `apps/server/test/conversations/conversationService.test.ts`

**Interfaces:**
- Consumes: `runAgentTurn`, `ToolContext` (Task 6), `OrderService.markPresented` (Task 5), `normalizePhone` (Task 2).
- Produces:
  ```ts
  type Outgoing = { conversationId: string; phone: string; author: "bot" | "attendant" | "system"; text: string };
  class ConversationService {
    constructor(deps: AgentDeps, send: (msg: Outgoing) => Promise<void>, onChange?: (conversationId: string) => void);
    handleCustomerMessage(rawPhone: string, text: string): Promise<void>;
    attendantReply(conversationId: string, text: string): Promise<void>;
    returnToBot(conversationId: string): Promise<void>;
    list(): Promise<{ id: string; phone: string; mode: "bot" | "human"; handoffReason: string | null; lastMessageAt: Date }[]>;
    history(conversationId: string): Promise<{ author: string; text: string; createdAt: Date }[]>;
  }
  ```
  `handleCustomerMessage`: normaliza telefone (inválido → ignora e loga); busca/cria conversa; grava mensagem `customer`; se `mode === 'human'` → só `onChange`, **sem IA**; senão `runAgentTurn`; envia `replyText` (se houver) como `bot`; se `events.draftPresentable` → envia `summaryText` como `bot` e chama `markPresented(draftId, now)` **depois** do envio; se `events.handoff` → `mode='human'`, grava motivo, envia `"Vou chamar um atendente para te ajudar. Só um instante!"`. Erro inesperado na IA → mesma passagem para humano com motivo `"Erro interno"`. Mensagens da mesma conversa são processadas em série (fila por `conversationId`).

- [ ] **Step 1: Testes que falham** (agente falso injetado):
  - **Review Focus 5:** conversa em `human` → nova mensagem do cliente é gravada, `runAgentTurn` não é chamado, nada é enviado.
  - `draftPresentable` → `send` recebe primeiro `replyText`, depois `summaryText`; `markPresented` chamado após o segundo `send`.
  - `handoff` → `mode` vira `human`, mensagem de passagem enviada; `returnToBot` volta para `bot`.
  - Duas mensagens da mesma conversa chegando juntas → `runAgentTurn` não roda em paralelo para a mesma conversa.
  - Telefone `"+55 (86) 99999-8888"` e `"86999998888"` caem na mesma conversa.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar. **Step 4:** Rodar → PASS.
- [ ] **Step 5:** Commit `feat: add conversation service with human handoff`.

---

### Task 8: Servidor HTTP/WebSocket e protocolo compartilhado

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/src/protocol.ts`, `apps/server/src/http/server.ts`, `apps/server/src/main.ts`
- Test: `apps/server/test/http/server.test.ts` (Fastify `inject` + cliente WS de teste)

**Interfaces:**
- Consumes: `ConversationService` (Task 7), `loadConfig`, `createDb`, `createRevgasClient`, `Catalog`, `OrderService`.
- Produces (`protocol.ts`, Zod discriminated unions):
  - Cliente→servidor: `{ type: "customer_message"; phone: string; text: string }`, `{ type: "attendant_reply"; conversationId: string; text: string }`, `{ type: "return_to_bot"; conversationId: string }`.
  - Servidor→cliente: `{ type: "message"; conversationId: string; phone: string; author: "customer"|"bot"|"attendant"|"system"; text: string; createdAt: string }`, `{ type: "conversations"; items: ConversationSummary[] }`.
- Produces: `buildServer(deps): FastifyInstance` com `GET /health` → `{ ok: true, revgasWriteEnabled: boolean }`, `GET /conversations`, `GET /conversations/:id/messages`, `WS /ws`. `main.ts` monta tudo a partir do `.env` e sobe em `cfg.port`.

- [ ] **Step 1: Testes que falham:** `/health` mostra `revgasWriteEnabled: false` por padrão; mensagem WS inválida recebe `{ type: "error" }` sem derrubar a conexão; `customer_message` gera ao menos um `message` de volta (agente falso); nenhuma resposta HTTP/WS contém a chave RevGás ou Anthropic.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar. **Step 4:** Rodar → PASS.
- [ ] **Step 5:** `pnpm --filter server dev` e `curl http://localhost:3333/health` → `{"ok":true,"revgasWriteEnabled":false}`.
- [ ] **Step 6:** Commit `feat: add HTTP and WebSocket server`.

---

### Task 9: Chat simulado (web)

**Files:**
- Create: `apps/web/` (Vite React TS), `apps/web/src/ws.ts`, `apps/web/src/App.tsx`, `apps/web/src/ChatPane.tsx`, `apps/web/src/AttendantPane.tsx`

**Interfaces:**
- Consumes: protocolo de `packages/shared` (Task 8); proxy do Vite `/ws` e `/conversations` → `http://localhost:3333`.

Tela em duas colunas:
- **Esquerda — "Cliente (WhatsApp simulado)":** campo de telefone (padrão `86999998888`), balões estilo WhatsApp (cliente à direita, bot à esquerda), campo de texto + Enter para enviar.
- **Direita — "Atendimento":** lista de conversas com selo `Bot`/`Humano` e motivo da passagem; ao abrir uma conversa `Humano`, campo para o atendente responder e botão **Devolver ao bot**.
- Faixa no topo: `Modo de teste — vendas NÃO são enviadas à RevGás` quando `/health` retorna `revgasWriteEnabled: false`.

- [ ] **Step 1:** Implementar as telas.
- [ ] **Step 2:** Verificação manual com `pnpm dev` (server + web): enviar "quero um botijão, pago no pix" → aparece resposta do bot e depois o resumo exato da Task 4; responder "sim" → `Pedido nº <id> registrado` (venda simulada); mandar "quero falar com uma pessoa" → conversa aparece como `Humano` à direita, bot para de responder; responder como atendente e devolver ao bot.
- [ ] **Step 3:** Commit `feat: add simulated WhatsApp chat UI`.

---

### Task 10: README e roteiro de demonstração

**Files:**
- Create: `README.md`

- [ ] **Step 1:** README em português: o que é, pré-requisitos (Node 24, pnpm, Docker), `cp .env.example .env`, `docker compose up -d`, `pnpm install`, `pnpm --filter server db:migrate`, `pnpm dev`, como rodar testes, o que `REVGAS_WRITE_ENABLED` faz e por que está `false`, roteiro de demo (os 4 cenários da Task 9) e as perguntas em aberto para a RevGás (seção 8 do spec).
- [ ] **Step 2:** Rodar `pnpm -r test` → tudo PASS; `pnpm -r exec tsc --noEmit` → sem erros.
- [ ] **Step 3:** Commit `docs: add README and demo script`.
