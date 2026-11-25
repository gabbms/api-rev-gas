# WhatsApp para a apresentação — Plano de implementação

> **Substituído para a apresentação** por `2026-11-25-whatsapp-waha` (a Cloud API da Meta foi bloqueada com o erro 130497 no projeto Rev-Gás). Mantido como referência para produção.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receber e responder mensagens pelo WhatsApp (Cloud API oficial da Meta, número de teste) com o
mesmo atendente virtual, resumo com botões e painel mostrando as conversas, para a demonstração.

**Architecture:** Um segundo servidor Fastify em `127.0.0.1:3334`, só com o webhook, é o único exposto pelo
túnel. Ele confere a assinatura, responde 200 na hora, descarta repetidas e entrega a mensagem ao
`ConversationService` com canal e endereço. As respostas passam por um roteador de canal que sempre avisa
o painel e, nas conversas do WhatsApp, envia pela Graph API. IA, pedidos e RevGás não mudam.

**Tech Stack:** o do projeto (Node 24, TypeScript, Fastify 5, Zod, Drizzle/PostgreSQL, Vitest), `fetch`
nativo para a Graph API e `node:crypto` para a assinatura. Nenhuma biblioteca nova.

**Spec:** `docs/superpowers/specs/2026-11-22-whatsapp-apresentacao-design.md` (ler antes).

## Global Constraints

- Tudo atrás de `WHATSAPP_ENABLED=false`. Desligado, o comportamento atual não muda (o servidor :3334 nem sobe).
- O servidor :3333 (tela, painel, WebSocket) **nunca** é exposto pelo túnel. O :3334 tem **só** as rotas `/webhooks/whatsapp`.
- Os dois servidores escutam em `127.0.0.1`.
- Segredos (`WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`) só no `.env`; nunca em logs, respostas HTTP, painel ou commits.
- Assinatura `X-Hub-Signature-256` conferida com `crypto.timingSafeEqual` sobre o **corpo bruto** antes de qualquer parse.
- Respostas vão para o `wa_id` exatamente como recebido (`conversations.channelAddress`), nunca para o telefone normalizado.
- `REVGAS_WRITE_ENABLED` continua `false`. Nenhuma venda real.
- O formato das chamadas à Graph API (`POST /{phone-number-id}/messages`, mensagem interativa com botões, marcar como lida) deve ser conferido na documentação oficial da Meta antes de escrever o cliente; a versão vem de `WHATSAPP_GRAPH_VERSION`.
- Textos para o cliente em português do Brasil. Código e commits em inglês. TDD em cada tarefa com lógica.

## Review Focus

1. **Webhook reenviado pela Meta** (mesmo id de mensagem duas vezes) → a IA roda uma vez só. Teste na Task 4.
2. **Webhook com assinatura errada, ausente ou corpo alterado** → 401 e nada processado. Teste na Task 3.
3. **Número brasileiro sem o nono dígito** (`558699998888`) → a resposta vai para `558699998888`, não para outro formato. Teste na Task 5.
4. **Mensagem de número fora da lista de permitidos** → ignorada sem chamar a IA nem responder. Teste na Task 4.
5. **"Confirmar" tocado num resumo antigo** depois de uma mudança no pedido → não cria venda (a trava atual continua valendo). Teste na Task 6.

---

### Task 1: Configuração e banco

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/db/schema.ts`, `.env.example`
- Create: migração Drizzle nova
- Test: `apps/server/test/config.test.ts`, `apps/server/test/db/schema.test.ts`

**Interfaces:**
- Produces em `AppConfig`: `whatsappEnabled: boolean` (padrão false), `whatsappToken`, `whatsappPhoneNumberId`, `whatsappAppSecret`, `whatsappVerifyToken` (strings; obrigatórias só quando `whatsappEnabled`), `whatsappGraphVersion` (string, obrigatória quando ligado), `whatsappWebhookPort` (padrão 3334), `whatsappAllowedNumbers: string[] | null` (lista de `wa_id`/telefones; vazia = null).
- Produces em `conversations`: `channel text not null default 'simulated'` (`'simulated' | 'whatsapp'`), `channelAddress text null`, `lastLat text null`, `lastLon text null`, `lastLocationAt timestamptz null`.
- Produces tabela `inbound_events`: `id text pk` (id da mensagem da Meta), `receivedAt timestamptz default now()`.
- Produces em `messages`: `deliveryStatus text null` (`'sent' | 'failed'`).

- [ ] **Step 1: Testes que falham** — `loadConfig` com `WHATSAPP_ENABLED=true` e sem `WHATSAPP_APP_SECRET` lança erro que nomeia a variável e não contém nenhum valor; desligado, as variáveis do WhatsApp não são exigidas; `WHATSAPP_ALLOWED_NUMBERS="5586911112222, 86933334444"` vira array normalizado (só dígitos); schema: inserir o mesmo id em `inbound_events` duas vezes falha por unicidade.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar e gerar a migração. **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat: add WhatsApp configuration and channel columns`.

---

### Task 2: Cliente da Graph API (real e falso)

**Files:**
- Create: `apps/server/src/channels/whatsapp/client.ts`, `apps/server/src/channels/whatsapp/fakeClient.ts`
- Test: `apps/server/test/channels/whatsapp/client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface WhatsAppClient {
    sendText(to: string, body: string): Promise<{ id: string }>;
    sendButtons(to: string, body: string, buttons: { id: string; title: string }[]): Promise<{ id: string }>;
    markRead(messageId: string): Promise<void>;
    checkPhoneNumber(): Promise<{ displayPhoneNumber: string }>; // leitura, para o preflight
  }
  class WhatsAppError extends Error { kind: "invalid" | "auth" | "rate_limited" | "server" | "network"; status?: number }
  class HttpWhatsAppClient implements WhatsAppClient { constructor(cfg: AppConfig, fetchFn?: typeof fetch) }
  class FakeWhatsAppClient implements WhatsAppClient { sent: { to: string; body: string; buttons?: { id: string; title: string }[] }[]; read: string[]; failNextWith?: WhatsAppError }
  ```
  Base `https://graph.facebook.com/${whatsappGraphVersion}`; header `Authorization: Bearer <token>`; `messaging_product: "whatsapp"`. `sendButtons` aceita no máximo 3 botões com título de até 20 caracteres (erro antes de chamar a API se passar).

- [ ] **Step 1: Testes que falham** (fetch falso): `sendText` faz `POST .../{phoneNumberId}/messages` com `to` exatamente como passado e `type: "text"`; `sendButtons` monta `type: "interactive"` com 2 botões de resposta; 401/403 → `auth`, 429 → `rate_limited`, 5xx → `server`, exceção → `network`; o token nunca aparece na mensagem de erro; `sendButtons` com título de 21 caracteres lança antes do fetch.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: add WhatsApp Graph API client`.

---

### Task 3: Assinatura e leitura do webhook (funções puras)

**Files:**
- Create: `apps/server/src/channels/whatsapp/webhook.ts`
- Test: `apps/server/test/channels/whatsapp/webhook.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean;
  function verifyChallenge(query: Record<string, unknown>, verifyToken: string): string | null; // devolve hub.challenge ou null
  type InboundMessage = {
    id: string; waId: string; profileName: string | null; at: Date;
    kind: "text" | "button" | "location" | "unsupported";
    text: string;            // texto, título do botão, ou "" para unsupported
    location?: { lat: string; lon: string; label: string | null };
  };
  function parseWebhook(body: unknown): InboundMessage[]; // ignora statuses; tolera campos extras
  ```
  `kind: "button"` cobre `interactive.button_reply`; `location` usa `latitude`, `longitude`, `name`/`address`; áudio, imagem, vídeo, figurinha e documento viram `unsupported`.

- [ ] **Step 1: Testes que falham** — **Review Focus 2:** assinatura correta → true; header ausente, prefixo diferente de `sha256=`, hash de outro segredo ou corpo com 1 byte alterado → false; `verifyChallenge` com token certo devolve o challenge, com token errado ou `hub.mode` diferente de `subscribe` → null; `parseWebhook` de um payload de texto, um de botão, um de localização, um de áudio e um só com `statuses` → respectivamente 1 text, 1 button, 1 location, 1 unsupported, 0 mensagens; payload malformado → `[]` sem lançar.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar (`crypto.createHmac("sha256", secret)`, `timingSafeEqual` com buffers do mesmo tamanho). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: verify and parse WhatsApp webhooks`.

---

### Task 4: Servidor do webhook (:3334)

**Files:**
- Create: `apps/server/src/channels/whatsapp/server.ts`
- Test: `apps/server/test/channels/whatsapp/server.test.ts` (Fastify `inject`)

**Interfaces:**
- Consumes: `verifySignature`, `verifyChallenge`, `parseWebhook` (Task 3), `WhatsAppClient.markRead` (Task 2), tabela `inbound_events` (Task 1). O destino das mensagens é o callback `onInbound`; a ligação com o `ConversationService` é feita no `main.ts` na Task 5.
- Produces: `buildWhatsAppWebhookServer(deps: { cfg; db; whatsapp: WhatsAppClient; onInbound: (m: InboundMessage) => Promise<void> }): FastifyInstance` com **apenas** `GET /webhooks/whatsapp` e `POST /webhooks/whatsapp`. O POST lê o corpo bruto (content-type parser que guarda o `Buffer`), confere a assinatura, responde 200 e, depois da resposta, para cada mensagem: `INSERT ... ON CONFLICT DO NOTHING` em `inbound_events` (se não inseriu, ignora), filtra `whatsappAllowedNumbers` (comparando dígitos normalizados), chama `markRead` (falha só gera log) e `onInbound`.

- [ ] **Step 1: Testes que falham** — GET com token certo → 200 e corpo = challenge; token errado → 403; POST sem assinatura → 401 e `onInbound` não chamado; POST válido → 200 e `onInbound` chamado 1 vez; **Review Focus 1:** o mesmo POST duas vezes → `onInbound` chamado 1 vez; **Review Focus 4:** mensagem de número fora da lista → `onInbound` não chamado e nada enviado; qualquer outra rota (`/conversations`, `/ws`, `/health`) → 404; nenhuma resposta contém o token ou o segredo.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: add WhatsApp webhook server on its own port`.

---

### Task 5: Canal nas conversas e roteador de saída

**Files:**
- Modify: `apps/server/src/conversations/conversationService.ts`, `apps/server/src/main.ts`, `packages/shared/src/protocol.ts`, `apps/server/src/http/server.ts`
- Create: `apps/server/src/channels/router.ts`
- Test: `apps/server/test/conversations/conversationService.test.ts`, `apps/server/test/channels/router.test.ts`

**Interfaces:**
- Produces em `ConversationService`:
  ```ts
  handleInbound(m: { channel: "simulated" | "whatsapp"; address: string | null; rawPhone: string; text: string;
                     profileName?: string | null; location?: { lat: string; lon: string; label: string | null } }): Promise<void>;
  ```
  `handleCustomerMessage(rawPhone, text)` passa a chamar `handleInbound({ channel: "simulated", address: null, rawPhone, text })`. Na primeira mensagem do WhatsApp, a conversa grava `channel = "whatsapp"` e `channelAddress = waId`; nas seguintes, atualiza `channelAddress` se mudar. A mensagem do cliente também é avisada ao painel (hoje o painel só recebe as de saída).
- `Outgoing` ganha `kind?: "summary"` (marcado no envio do resumo oficial).
- Produces (`router.ts`): `createOutgoingRouter(deps: { db; hub: Hub; whatsapp: WhatsAppClient | null }): (msg: Outgoing) => Promise<void>` — sempre avisa o painel; se a conversa é `whatsapp`, envia para `channelAddress`: resumo com `sendButtons(address, text, [{ id: "confirm", title: "Confirmar" }, { id: "change", title: "Mudar algo" }])` (texto acima do limite interativo: `sendText` + `sendButtons` curto "Posso registrar?"), o resto com `sendText`. Erro `network`/`server`: uma nova tentativa; depois grava `deliveryStatus = "failed"` e loga sem conteúdo; sucesso grava `"sent"`.
- `ConversationSummary` (protocolo) ganha `channel`.
- `main.ts`: o `send` do `ConversationService` passa a ser `createOutgoingRouter(...)`; com `whatsappEnabled`, cria o `HttpWhatsAppClient`, sobe `buildWhatsAppWebhookServer` (Task 4) em `127.0.0.1:whatsappWebhookPort` com `onInbound` chamando `conversations.handleInbound({ channel: "whatsapp", address: m.waId, rawPhone: m.waId, ... })`, e loga "[whatsapp] webhook em http://127.0.0.1:3334/webhooks/whatsapp (aponte o túnel para esta porta)".

- [ ] **Step 1: Testes que falham** — **Review Focus 3:** inbound de `waId = "558699998888"` e resposta do bot → `FakeWhatsAppClient.sent[0].to === "558699998888"`; conversa simulada → nada enviado ao WhatsApp, painel avisado; resposta do atendente numa conversa WhatsApp → sai pelo WhatsApp; resumo → `sendButtons` com os 2 botões; falha `network` duas vezes → `deliveryStatus = "failed"` e o turno não quebra; mensagem do cliente aparece no painel.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: route replies to WhatsApp and show WhatsApp conversations in the panel`.

---

### Task 6: Botões, localização e mensagens sem suporte

**Files:**
- Modify: `apps/server/src/conversations/conversationService.ts`, `apps/server/src/orders/draft.ts`, `apps/server/src/orders/orderService.ts`, `apps/server/src/agent/systemPrompt.ts`
- Test: `apps/server/test/conversations/conversationService.test.ts`, `apps/server/test/orders/orderService.test.ts`, `apps/server/test/orders/draft.test.ts`

**Interfaces:**
- `kind: "button"`: o texto entregue à IA é o título do botão ("Confirmar" ou "Mudar algo"). A trava do `OrderService.confirm` não muda.
- `kind: "location"`: grava `lastLat`, `lastLon`, `lastLocationAt` na conversa; o texto para a IA é `[Localização recebida: <label>]` (ou sem label). `toSalePayload` passa a incluir `lat`/`lon` quando a conversa tem localização recebida há menos de 2 horas (o `OrderService` lê da conversa ao montar o payload).
- `kind: "unsupported"`: não chama a IA; responde `"Por enquanto eu entendo só mensagens de texto. Pode escrever o seu pedido?"`.
- Prompt: uma linha dizendo que "Confirmar" é a aprovação do último resumo, que "Mudar algo" pede o que mudar, e que uma localização recebida pode ser usada como referência de entrega, mas o endereço por escrito continua obrigatório.

- [ ] **Step 1: Testes que falham** — botão "Confirmar" após resumo apresentado → venda simulada criada; **Review Focus 5:** resumo → mudança de pedido → "Confirmar" do resumo antigo → `not_presented`, nenhuma venda; localização → próxima venda simulada tem `lat`/`lon`; localização de 3 h atrás → venda sem `lat`/`lon`; áudio → resposta fixa e `runAgentTurn` não chamado.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: handle WhatsApp buttons, location and unsupported messages`.

---

### Task 7: Painel e preflight

**Files:**
- Modify: `apps/web/src/AttendantPane.tsx`, `apps/web/src/ChatPane.tsx`, `apps/server/src/preflight/preflight.ts`
- Test: `apps/server/test/preflight/preflight.test.ts`

**Interfaces:**
- Painel: selo **WhatsApp** ou **Simulado** em cada conversa; mensagens com `deliveryStatus = "failed"` mostram "não entregue". O chat simulado (esquerda) mostra um aviso quando o número escolhido é de uma conversa do WhatsApp: "Esta conversa é do WhatsApp; responda pelo painel".
- Preflight: linhas `WHATSAPP_ENABLED`, `WHATSAPP_ALLOWED_NUMBERS` (aviso se vazio com WhatsApp ligado: "qualquer pessoa que achar o número usa o bot"), `WHATSAPP_GRAPH_VERSION`, porta do webhook; leitura `checkPhoneNumber()` mostrando o número exibido ou o erro (sem enviar mensagem).

- [ ] **Step 1: Testes que falham** (preflight): WhatsApp ligado sem lista de permitidos → aviso; token inválido (fake `auth`) → linha "token inválido ou expirado"; desligado → "WhatsApp desligado" e nenhuma chamada.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS e `pnpm -r exec tsc --noEmit` sem erros.
- [ ] **Step 5:** Commit `feat: show channel in the panel and check WhatsApp in preflight`.

---

### Task 8: README, guia da Meta e teste ponta a ponta

**Files:**
- Modify: `README.md`
- Create: `docs/whatsapp-setup.md`

- [ ] **Step 1:** `docs/whatsapp-setup.md` em português, passo a passo para quem não conhece a Meta: criar o app, pegar o número de teste e o id, cadastrar os 4 celulares, gerar token permanente de usuário do sistema, pegar o segredo do app, inventar o token de verificação, instalar o ngrok e criar o domínio estático, rodar `ngrok http --url=<dominio> 3334`, configurar o webhook (`https://<dominio>/webhooks/whatsapp`) e assinar `messages`, preencher o `.env`, rodar o `preflight`.
- [ ] **Step 2:** README: seção "WhatsApp na apresentação" com o roteiro da demo pelo celular e o plano B (chat simulado).
- [ ] **Step 3:** Rodar `pnpm test` e `pnpm -r exec tsc --noEmit` → tudo passando.
- [ ] **Step 4: Teste manual (depende do usuário ter feito o guia):** do celular cadastrado, "oi, quero um botijão, pago no pix" → resposta; informar endereço e "não tenho vazio" → resumo com botões; tocar **Confirmar** → "Pedido nº … registrado"; enviar localização e um áudio; "quero falar com uma pessoa" → conversa no painel com selo WhatsApp; responder pelo painel → chega no celular; mandar de um número fora da lista → sem resposta. Mostrar o log (sem chaves).
- [ ] **Step 5:** Commit `docs: WhatsApp setup guide and presentation script`.
