# WhatsApp via WAHA — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receber e responder mensagens de WhatsApp de verdade pelo WAHA (chip reserva), com o mesmo
atendente virtual, para a demonstração.

**Architecture:** Um segundo servidor Fastify (:3334) só com `POST /webhooks/waha` recebe os eventos do
WAHA, confere o segredo, responde 200 na hora, descarta repetidas, resolve contatos `@lid` e entrega ao
`ConversationService` com canal e endereço. As respostas passam por um roteador de canal que sempre avisa
o painel e, nas conversas do WhatsApp, envia pelo WAHA. IA, pedidos, catálogo e RevGás não mudam.

**Tech Stack:** o do projeto. Nenhuma dependência nova. WAHA em Docker (`devlikeapro/waha`, engine GOWS).

**Spec:** `docs/superpowers/specs/2026-11-25-whatsapp-waha-design.md` (ler antes).

**Referência de código:** `C:\Users\Gabriel\Desktop\Rev-Gás\src\whatsapp\waha.ts`, `src/server.ts`
(rota `/webhook/waha`), `docker-compose.yml`, `docs/WAHA.md` e `tests/whatsapp/waha.test.ts`. Leia e
adapte; não importe arquivos de lá. Se a leitura fora da pasta for bloqueada, peça ao usuário.

## Global Constraints

- Tudo atrás de `WHATSAPP_PROVIDER=off`. Desligado, nada muda e o :3334 nem sobe.
- O :3333 nunca recebe tráfego do WAHA. O :3334 tem **só** `POST /webhooks/waha`; qualquer outra rota responde 404.
- Segredo do webhook conferido em tempo constante (como `verifyWahaSecret` do Rev-Gás) antes de ler o corpo; sem ele, 401.
- `WAHA_API_KEY` e `WAHA_WEBHOOK_SECRET` só no `.env`; nunca em logs, respostas, painel ou commits.
- Ignorar `fromMe`, grupos (`@g.us`) e eventos que não sejam `message`.
- Respostas sempre para o `channelAddress` da conversa, resolvido pelo cliente WAHA (`check-exists`), nunca para o telefone normalizado sem o 55.
- `REVGAS_WRITE_ENABLED` continua `false`.
- O WAHA não é oficial: o servidor loga, ao subir com `waha`, "aviso: WhatsApp não oficial (WAHA), só para demonstração; o número pode ser banido".
- TDD em cada tarefa com lógica. Código e commits em inglês; textos ao cliente em português do Brasil.

## Review Focus

1. **Evento repetido** (mesmo id de mensagem duas vezes) → a IA roda uma vez. Teste na Task 3.
2. **Segredo ausente ou errado** → 401 e nada processado. Teste na Task 3.
3. **Contato `@lid`** → resolve o telefone e segue; sem telefone, descarta com log sem conteúdo. Teste na Task 3.
4. **Número antigo sem o nono dígito** → a resposta vai para o `chatId` que o WAHA indicar. Teste na Task 2.
5. **"Confirmar" tocado num resumo antigo** depois de uma mudança no pedido → nenhuma venda (trava atual). Teste na Task 5.

---

### Task 1: Configuração, Docker e banco

**Files:** `apps/server/src/config.ts`, `apps/server/src/db/schema.ts`, migração nova, `.env.example`, `docker-compose.yml`, `.gitignore`
**Test:** `apps/server/test/config.test.ts`, `apps/server/test/db/schema.test.ts`

- `AppConfig`: `whatsappProvider: "off" | "waha"` (padrão `off`), `wahaUrl` (padrão `http://localhost:3002`), `wahaApiKey`, `wahaWebhookSecret` (obrigatórios com `waha`), `wahaSession` (padrão `default`), `whatsappWebhookPort` (padrão 3334), `whatsappAllowedNumbers: string[] | null`.
- `conversations`: `channel text not null default 'simulated'` (`simulated | whatsapp`), `channelAddress text null`. Tabela `inbound_events` (`id text pk`, `receivedAt`). `messages.deliveryStatus text null` (`sent | failed`).
- `docker-compose.yml`: serviço `waha` adaptado do Rev-Gás: `127.0.0.1:3002:3000`, `WHATSAPP_DEFAULT_ENGINE: GOWS`, `WHATSAPP_HOOK_URL: http://host.docker.internal:3334/webhooks/waha`, `WHATSAPP_HOOK_EVENTS: message`, `WHATSAPP_HOOK_CUSTOM_HEADERS: "X-Revgas-Secret:${WAHA_WEBHOOK_SECRET}"`, `WHATSAPP_DOWNLOAD_MEDIA: "false"`, chave e painel com `${WAHA_API_KEY}`, volume `./.waha/sessions`, `extra_hosts: host.docker.internal:host-gateway`, `profiles: ["whatsapp"]` (sobe só com `docker compose --profile whatsapp up -d`). `.waha/` no `.gitignore`.

- [x] **Step 1: Testes que falham** — `waha` sem `WAHA_WEBHOOK_SECRET` → erro que nomeia a variável e não contém valores; `off` não exige nada; `WHATSAPP_ALLOWED_NUMBERS="5586911112222, 86933334444"` → dígitos normalizados; mesmo id em `inbound_events` duas vezes → violação de unicidade.
- [x] **Step 2:** FAIL. **Step 3:** implementar e gerar a migração. **Step 4:** PASS.
- [x] **Step 5:** Commit `feat: add WAHA configuration, compose service and channel columns`.

---

### Task 2: Cliente WAHA e parser do webhook (adaptados do Rev-Gás)

**Files:** `apps/server/src/channels/waha/client.ts`, `apps/server/src/channels/waha/webhook.ts`, `apps/server/src/channels/waha/fakeClient.ts`
**Test:** `apps/server/test/channels/waha/client.test.ts`, `apps/server/test/channels/waha/webhook.test.ts`

- Produces:
  ```ts
  interface WhatsAppSender {
    sendText(to: string, body: string): Promise<{ id: string }>;
    sendChoices(to: string, text: string, options: string[]): Promise<{ id: string }>; // WAHA sendList
  }
  class WhatsAppError extends Error { kind: "invalid" | "auth" | "unavailable" | "server" | "network"; status?: number }
  function createWahaSender(o: { baseUrl: string; apiKey: string; session: string; fetch?: typeof fetch }): WhatsAppSender;
  function createWahaLidResolver(o: { baseUrl: string; apiKey: string; session: string; fetch?: typeof fetch }): (lid: string) => Promise<string | undefined>;
  function verifyWahaSecret(header: string | undefined, secret: string): boolean;
  type InboundMessage = { id: string; from: string /* dígitos com 55 */; profileName: string | null; at: Date; kind: "text" | "unsupported"; text: string };
  function parseWahaWebhook(body: unknown): { messages: InboundMessage[]; lids: { lid: string; message: Omit<InboundMessage, "from"> }[] };
  class FakeWhatsAppSender implements WhatsAppSender { sent: { to: string; text: string; options?: string[] }[]; failNextWith?: WhatsAppError }
  ```
  Regras do Rev-Gás a manter: `X-Api-Key` no header; `chatId` via `/api/contacts/check-exists` com cache (nono dígito); título da lista = primeira linha sem asteriscos (até 60 caracteres); ignora `fromMe`, grupos e eventos que não sejam `message`; mídia vira `unsupported`; id da mensagem enviada extraído das várias formas do WAHA.

- [x] **Step 1: Testes que falham** (fetch falso), adaptando `tests/whatsapp/waha.test.ts` do Rev-Gás: `sendText` usa o `chatId` devolvido por `check-exists` (**Review Focus 4**: `558699998888` → `558699998888@c.us` informado pelo WAHA); `sendChoices` monta `sendList` com 2 linhas; 401 → `auth`, 501 → `unavailable`, 5xx → `server`, exceção → `network`; a chave nunca aparece no erro; `verifyWahaSecret` certo/errado/ausente; parser: texto, `fromMe`, grupo, `@lid`, áudio → `unsupported`, payload malformado → listas vazias.
- [x] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [x] **Step 5:** Commit `feat: add WAHA sender and webhook parser adapted from Rev-Gás`.

---

### Task 3: Servidor do webhook (:3334)

**Files:** `apps/server/src/channels/waha/server.ts`
**Test:** `apps/server/test/channels/waha/server.test.ts` (Fastify `inject`)

- Produces: `buildWahaWebhookServer(deps: { cfg; db; resolveLid; onInbound: (m: InboundMessage) => Promise<void> }): FastifyInstance` com **apenas** `POST /webhooks/waha`. Confere o segredo (401 sem ele), responde 200 e, depois da resposta: resolve `@lid` (sem telefone: log "contato @lid sem telefone; mensagem ignorada", sem conteúdo), `INSERT ... ON CONFLICT DO NOTHING` em `inbound_events` (se não inseriu, ignora), filtra `whatsappAllowedNumbers` e chama `onInbound`.
- Escuta em `127.0.0.1:whatsappWebhookPort`. **Verificação manual na Task 7:** se o WAHA no Docker não alcançar `127.0.0.1` pelo `host.docker.internal`, trocar para `0.0.0.0` só neste servidor (ele só tem a rota protegida pelo segredo) e registrar a decisão.

- [x] **Step 1: Testes que falham** — **Review Focus 2:** sem segredo → 401 e `onInbound` não chamado; válido → 200 e `onInbound` 1 vez; **Review Focus 1:** o mesmo evento duas vezes → 1 vez; **Review Focus 3:** `@lid` resolvido segue, não resolvido é descartado; número fora da lista → ignorado; `/conversations`, `/ws`, `/health` → 404; nenhuma resposta contém os segredos.
- [x] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [x] **Step 5:** Commit `feat: add WAHA webhook server on its own port`.

---

### Task 4: Canal nas conversas e roteador de saída

**Files:** `apps/server/src/conversations/conversationService.ts`, `apps/server/src/channels/router.ts`, `apps/server/src/main.ts`, `packages/shared/src/protocol.ts`
**Test:** `apps/server/test/conversations/conversationService.test.ts`, `apps/server/test/channels/router.test.ts`

- `ConversationService.handleInbound(m: { channel: "simulated" | "whatsapp"; address: string | null; rawPhone: string; text: string; kind?: "text" | "unsupported" })`. `handleCustomerMessage(rawPhone, text)` passa a chamar `handleInbound({ channel: "simulated", address: null, rawPhone, text })`. Na primeira mensagem do WhatsApp, a conversa grava `channel = "whatsapp"` e `channelAddress`; nas seguintes, atualiza o endereço se mudar. A mensagem do cliente também é avisada ao painel.
- `kind: "unsupported"` não chama a IA; responde "Por enquanto eu entendo só mensagens de texto. Pode escrever o seu pedido?".
- `Outgoing` ganha `kind?: "summary"`. `createOutgoingRouter({ db, hub, whatsapp: WhatsAppSender | null })`: sempre avisa o painel; nas conversas WhatsApp, o resumo vai por `sendChoices(address, text, ["Confirmar", "Mudar algo"])` e, se falhar, por `sendText`; o resto por `sendText`. Erro `network`/`server`: uma nova tentativa; depois `deliveryStatus = "failed"` e log sem conteúdo.
- `main.ts`: com `waha`, cria o sender e o resolvedor, sobe `buildWahaWebhookServer` com `onInbound` → `handleInbound({ channel: "whatsapp", address: m.from, rawPhone: m.from, text: m.text, kind: m.kind })` e loga o aviso de canal não oficial.
- `ConversationSummary` ganha `channel`.

- [ ] **Step 1: Testes que falham** — conversa WhatsApp → resposta do bot vai ao `FakeWhatsAppSender` com o endereço gravado; conversa simulada → nada vai ao WhatsApp; resposta do atendente numa conversa WhatsApp → sai pelo WhatsApp; resumo → `sendChoices` com as 2 opções; `sendChoices` falhando → `sendText`; falha de rede dupla → `failed` sem quebrar o turno; áudio → resposta fixa e IA não chamada.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: route replies to WhatsApp via WAHA and keep the panel in sync`.

---

### Task 5: Opções no prompt e confirmação

**Files:** `apps/server/src/agent/systemPrompt.ts`
**Test:** `apps/server/test/conversations/conversationService.test.ts`, `apps/server/test/agent/*.test.ts`

- Prompt: "Confirmar" é a aprovação do último resumo; "Mudar algo" pede o que mudar. Nada mais muda na confirmação.

- [ ] **Step 1: Testes que falham** — "Confirmar" após resumo apresentado → venda simulada criada; **Review Focus 5:** resumo → mudança de pedido → "Confirmar" antigo → `not_presented`, nenhuma venda.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: treat WhatsApp option replies as confirmation or change`.

---

### Task 6: Painel e preflight

**Files:** `apps/web/src/AttendantPane.tsx`, `apps/web/src/ChatPane.tsx`, `apps/server/src/preflight/preflight.ts`
**Test:** `apps/server/test/preflight/preflight.test.ts`

- Painel: selo **WhatsApp** ou **Simulado** em cada conversa; mensagem com `deliveryStatus = "failed"` mostra "não entregue". No chat simulado, aviso quando o número escolhido é de uma conversa do WhatsApp: "Esta conversa é do WhatsApp; responda pelo painel".
- Preflight: `WHATSAPP_PROVIDER`; com `waha`, consulta `GET {WAHA_URL}/api/sessions/{session}` (com `X-Api-Key`) e mostra o status (`WORKING` = ok; outro = aviso "escaneie o QR"); aviso fixo "WAHA não é oficial: use chip reserva"; aviso se `WHATSAPP_ALLOWED_NUMBERS` estiver vazio ("qualquer pessoa que souber o número usa o bot e gasta créditos da IA").

- [ ] **Step 1: Testes que falham** (preflight com fetch falso): `WORKING` → ok; `SCAN_QR_CODE` → aviso; WAHA fora do ar → "WAHA não respondeu"; `off` → nenhuma chamada.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS e `pnpm -r exec tsc --noEmit` sem erros.
- [ ] **Step 5:** Commit `feat: show WhatsApp channel in the panel and check WAHA in preflight`.

---

### Task 7: Guia e teste ponta a ponta

**Files:** `docs/WAHA.md` (adaptado do Rev-Gás), `README.md`

- [ ] **Step 1:** `docs/WAHA.md` em português: aviso de não oficial e chip reserva; gerar os dois segredos no PowerShell; preencher o `.env`; `docker compose --profile whatsapp up -d`; abrir `http://localhost:3002/dashboard` (usuário `admin`, senha = `WAHA_API_KEY`), iniciar a sessão `default` e escanear o QR; `pnpm dev`; `preflight`; problemas comuns (webhook 401, `@lid`, host.docker.internal); não rodar o WAHA do Rev-Gás com o mesmo chip ao mesmo tempo; como desligar depois da apresentação.
- [ ] **Step 2:** README: seção "WhatsApp na apresentação (WAHA)" com o roteiro pelo celular e o plano B (chat simulado).
- [ ] **Step 3:** `pnpm test` e `pnpm -r exec tsc --noEmit` → tudo passando.
- [ ] **Step 4: Teste manual (depende do usuário ter o chip conectado):** de outro celular, "oi, quero um botijão, pago no pix" → resposta; endereço e "não tenho vazio" → resumo com a lista Confirmar/Mudar algo; "Confirmar" → "Pedido nº … registrado"; um áudio → resposta fixa; "quero falar com uma pessoa" → conversa no painel com selo WhatsApp; resposta pelo painel → chega no celular; devolver ao bot. Conferir que o WAHA alcança o :3334 (Task 3). Mostrar o log, sem segredos.
- [ ] **Step 5:** Commit `docs: WAHA guide and WhatsApp demo script`.
