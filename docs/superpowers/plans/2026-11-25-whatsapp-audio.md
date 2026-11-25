# Áudio no WhatsApp (Groq) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O cliente manda áudio no WhatsApp e o bot entende e responde em texto, como se ele tivesse
escrito. A transcrição é feita pela Groq.

**Architecture:** O parser do webhook reconhece áudio com `media.url`. Na fila do remetente, o servidor
baixa o arquivo do WAHA (só o caminho `/api/files/...`, com `X-Api-Key` e limite de tamanho) e transcreve
na Groq. Depois entrega ao `ConversationService` como `kind: "audio"`. A conversa grava `🎤 <transcrição>`
para o painel e passa à IA o texto com um prefixo de áudio. Se falhar, a conversa responde com um texto
fixo. IA, pedidos, catálogo e RevGás não mudam. Junto entra uma correção: a mensagem do WhatsApp passa a
ser gravada com o horário em que o webhook chegou.

**Tech Stack:** o do projeto. Nenhuma dependência nova (`fetch`, `FormData` e `Blob` nativos do Node).

**Spec:** `docs/superpowers/specs/2026-11-25-whatsapp-audio-design.md` (ler antes).

**Referência de código:** `C:\Users\Gabriel\Desktop\Rev-Gás\src\audio\transcriber.ts`,
`src/inbound/media.ts` (`createContentToText`), `src/whatsapp/waha.ts` (`downloadMedia` e o parser de
mídia) e os testes correspondentes em `tests/`. Leia e adapte; não importe arquivos de lá. Se a leitura
fora da pasta for bloqueada, peça ao usuário.

**Branch:** continuar em `feat/whatsapp-waha` (ainda não foi para a `main`) ou criar `feat/whatsapp-audio`
a partir dele. Perguntar ao usuário.

## Global Constraints

- Tudo atrás de `AUDIO_TRANSCRIPTION=off` (padrão). Desligado, o áudio recebe a resposta de hoje
  (`UNSUPPORTED_TEXT`) e nenhuma chamada à Groq acontece.
- `GROQ_API_KEY` só no `.env`. Nunca em logs, erros, respostas, painel, testes (use valores falsos como
  `"groq-key-should-never-leak"`) ou commits.
- Nunca logar a transcrição nem o corpo das respostas da Groq ou do WAHA. Log só com tipo de erro, status e
  duração.
- O download usa **só o caminho** da URL recebida, sobre `WAHA_URL`, e só se começar com `/api/files/`.
- **Sem nova tentativa automática** na transcrição nem no download.
- O áudio não é guardado: só a transcrição, na tabela `messages`.
- Preço, resumo e confirmação continuam no código (`Catalog`, `OrderService`). Nenhuma regra de dinheiro vai
  para o prompt.
- `REVGAS_WRITE_ENABLED` continua `false`.
- TDD em cada tarefa com lógica. Código e commits em inglês; textos ao cliente em português do Brasil.

## Review Focus

1. **"Sim" enviado enquanto a IA ainda monta o resumo** → não confirma a venda (horário de chegada). Teste na Task 1.
2. **URL de mídia com outro host ou outro caminho** → nada é buscado fora do WAHA. Teste na Task 3.
3. **Áudio maior que `AUDIO_MAX_BYTES`** → recusado sem ler tudo e sem chamar a Groq. Teste na Task 3.
4. **Groq fora do ar, 401 ou 429** → o cliente recebe o texto fixo, a IA não é chamada e o erro não traz a chave. Testes nas Tasks 2 e 4.
5. **Áudio no modo humano** → transcrição gravada, IA não chamada, nenhuma resposta do bot. Teste na Task 4.

---

### Task 1: Horário de chegada nas mensagens do WhatsApp

**Files:** `apps/server/src/channels/waha/server.ts`, `apps/server/src/channels/waha/webhook.ts` (tipo),
`apps/server/src/conversations/conversationService.ts`, `apps/server/src/main.ts`
**Test:** `apps/server/test/channels/waha/server.test.ts`, `apps/server/test/conversations/conversationService.test.ts`

- Hoje a fila do remetente espera o turno inteiro da IA (`take` aguarda `onInbound`, que aguarda
  `enqueue(process)`). Por isso a mensagem seguinte é gravada depois, com `new Date()` na gravação.
- `onInbound` passa a receber `receivedAt: Date`, marcado no handler do `POST` (relógio do app, `new Date()`
  antes de agendar). Para `@lid`, o mesmo `receivedAt` do POST.
- `Inbound` ganha `receivedAt?: Date`; `handleInbound` grava `createdAt: m.receivedAt ?? new Date()`.
- `main.ts` repassa `receivedAt`.

- [x] **Step 1: Testes que falham** —
  - server: dois POSTs do mesmo remetente; o `onInbound` do primeiro fica pendurado (promessa controlada). O
    segundo chega antes de o primeiro terminar e o `receivedAt` dele é anterior ao momento em que o
    primeiro é liberado.
  - conversationService (**Review Focus 1**): com uma IA falsa que, ao processar a mensagem A, apresenta o
    resumo (`presentedAt = T1`), uma mensagem B "sim" com `receivedAt < T1` é gravada com esse horário, e
    `OrderService.confirm` responde `not_ready` para esse resumo. Uma mensagem C com `receivedAt > T1`
    libera a confirmação.
- [x] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS (e a suíte toda).
- [x] **Step 5:** Commit `fix: store WhatsApp messages with the time the webhook arrived`.

---

### Task 2: Configuração e transcritor

**Files:** `apps/server/src/config.ts`, `apps/server/src/audio/transcriber.ts` (novo),
`apps/server/src/audio/fakeTranscriber.ts` (novo), `.env.example`
**Test:** `apps/server/test/config.test.ts`, `apps/server/test/audio/transcriber.test.ts` (novo)

- `AppConfig`: `audioTranscription: "off" | "groq"` (padrão `off`), `groqApiKey: string | null`,
  `transcribeUrl` (padrão `https://api.groq.com/openai/v1/audio/transcriptions`), `transcribeModel`
  (padrão `whisper-large-v3-turbo`), `audioMaxBytes` (padrão `2_000_000`).
  `groq` exige `GROQ_API_KEY` e `WHATSAPP_PROVIDER=waha` (mensagem nomeia a variável, sem valores).
- Produces:
  ```ts
  interface Transcriber { transcribe(audio: Uint8Array, mime: string): Promise<string> }
  type TranscriptionErrorKind = "auth" | "rate_limited" | "invalid" | "server" | "network";
  class TranscriptionError extends Error { kind: TranscriptionErrorKind; status?: number }
  function baseMime(mime: string): string;          // "audio/ogg; codecs=opus" → "audio/ogg"
  function audioFileName(mime: string): string;     // "audio/ogg" → "audio.ogg"; desconhecido → "audio.bin"
  function createOpenAICompatibleTranscriber(o: { apiKey: string; url: string; model: string; fetch?: typeof fetch; timeoutMs?: number /* 20_000 */ }): Transcriber;
  class FakeTranscriber implements Transcriber { calls: { bytes: number; mime: string }[]; next: string | TranscriptionError }
  ```
  `multipart/form-data` com `file`, `model`, `language=pt`; header `Authorization: Bearer <chave>`;
  devolve `text` sem espaços nas pontas (`""` se faltar). 401/403 → `auth`; 429 → `rate_limited`;
  outros 4xx → `invalid`; 5xx → `server`; exceção ou timeout → `network`.
- `.env.example`: o bloco da seção 5.7 da spec, com comentário em português.

- [ ] **Step 1: Testes que falham** (fetch falso) — config: `groq` sem chave → erro com o nome da variável;
  `groq` com `WHATSAPP_PROVIDER=off` → erro; `off` não exige nada. Transcritor: URL, header, `model`,
  `language` e nome do arquivo corretos; texto aparado; cada status vira o tipo certo
  (**Review Focus 4**); a chave e o corpo da resposta nunca aparecem em `message`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar (adaptar do Rev-Gás). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: add Groq-compatible audio transcriber and config`.

---

### Task 3: Áudio no parser e download pelo WAHA

**Files:** `apps/server/src/channels/waha/webhook.ts`, `apps/server/src/channels/waha/client.ts`,
`apps/server/src/channels/waha/fakeClient.ts`
**Test:** `apps/server/test/channels/waha/webhook.test.ts`, `apps/server/test/channels/waha/client.test.ts`

- `InboundMessage.kind` ganha `"audio"`, com `media: { url: string; mime: string }`. Áudio sem `media.url`
  continua `unsupported` com `[áudio]`. Imagem, vídeo e figurinha não mudam.
- Produces:
  ```ts
  class MediaTooLargeError extends Error {}
  function createWahaMediaDownloader(o: { baseUrl: string; apiKey: string; maxBytes: number; fetch?: typeof fetch; timeoutMs?: number /* 15_000 */ }):
    (url: string) => Promise<{ data: Uint8Array; mime: string }>;
  ```
  Usa `new URL(url)`, pega `pathname + search`, exige `/api/files/` no começo (senão `WhatsAppError`
  `invalid`, sem fetch). Busca `baseUrl + caminho` com `X-Api-Key`. `content-length` acima do limite →
  `MediaTooLargeError` sem ler o corpo; sem `content-length`, lê em partes e para ao passar do limite.
  Erros de status como os do `createWahaSender`.

- [ ] **Step 1: Testes que falham** — parser: nota de voz com `media.url` e `audio/ogg; codecs=opus` →
  `kind: "audio"`; sem `url` → `unsupported`. Downloader (**Review Focus 2**):
  `http://localhost:3000/api/files/default/x.oga` → busca `WAHA_URL/api/files/default/x.oga` com a chave;
  `http://evil.example/api/files/x` → busca só o caminho sobre `WAHA_URL`;
  `http://localhost:3000/api/sessions` → erro, nenhum fetch. **Review Focus 3:** `content-length` grande →
  `MediaTooLargeError`; corpo grande sem `content-length` → `MediaTooLargeError`. 401 → `auth` sem a chave
  na mensagem.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: parse WAHA voice notes and download media from WAHA only`.

---

### Task 4: Áudio na conversa

**Files:** `apps/server/src/channels/waha/audio.ts` (novo), `apps/server/src/conversations/conversationService.ts`,
`apps/server/src/agent/systemPrompt.ts`, `apps/server/src/main.ts`
**Test:** `apps/server/test/channels/waha/audio.test.ts` (novo), `apps/server/test/conversations/conversationService.test.ts`,
teste do prompt se existir

- `audio.ts` produz `toInbound(m: InboundMessage): Promise<Pick<Inbound, "kind" | "text">>`, criado com
  `{ download, transcriber | null }`:
  - texto/unsupported → como vierem;
  - áudio com `transcriber` nulo (`off`) → `unsupported`, `[áudio]`;
  - áudio → baixa, transcreve; texto não vazio → `{ kind: "audio", text }`;
  - vazio, erro de download ou de transcrição → `{ kind: "audio_failed", text: "[áudio não transcrito]" }`;
    grande demais → `{ kind: "audio_too_long", text: "[áudio longo demais]" }`.
  - Loga só o tipo do erro e a duração em ms.
- `Inbound.kind`: `"text" | "unsupported" | "audio" | "audio_failed" | "audio_too_long"`.
  - `audio`: grava `🎤 ${text}` e chama a IA com
    `[Áudio do cliente, transcrito automaticamente] ${text}`. Modo humano: grava e não chama a IA (a
    checagem de hoje em `process` já cobre isso; confirmar com teste).
  - `audio_failed`: grava o texto e responde `AUDIO_FAILED_TEXT` = "Não consegui entender o seu áudio. Pode
    escrever para mim?" (fora do modo humano), sem chamar a IA.
  - `audio_too_long`: igual, com `AUDIO_TOO_LONG_TEXT` = "Esse áudio ficou longo demais para mim. Pode
    mandar um mais curto ou escrever?".
- Prompt de sistema, uma frase: mensagens que começam com `[Áudio do cliente, transcrito
  automaticamente]` podem ter erros em nomes, números e endereços; se algo parecer estranho, pergunte.
- `main.ts`: no `onInbound`, `await toInbound(m)` antes de `handleInbound` (continua dentro da fila do
  remetente, então a ordem das mensagens se mantém), passando `receivedAt`.

- [ ] **Step 1: Testes que falham** — `audio.test.ts` com `FakeTranscriber` e downloader falso: os cinco
  caminhos acima; com `off`, o downloader nem é chamado (**Review Focus 4**). conversationService: `audio` grava
  `🎤 ...` e a IA falsa recebe o prefixo; `audio_failed` responde o texto fixo e a IA falsa não é chamada;
  **Review Focus 5:** modo humano + `audio` → mensagem gravada, nenhuma resposta, IA não chamada.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: transcribe WhatsApp voice notes into the conversation`.

---

### Task 5: Preflight, Docker e guia

**Files:** `apps/server/src/preflight/*.ts`, `docker-compose.waha.yml`, `docs/WAHA.md`, `README.md`
**Test:** teste do preflight existente

- Preflight: linha `Áudio: off` ou `Áudio: groq (whisper-large-v3-turbo) ok | chave recusada | sem resposta`,
  conferindo com `GET https://api.groq.com/openai/v1/models` (só leitura, sem áudio). Derive a URL de
  `transcribeUrl` (troca `/audio/transcriptions` por `/models`). Aviso se `groq` estiver ligado: "o áudio do
  cliente é enviado à Groq".
- `docker-compose.waha.yml`: `WHATSAPP_DOWNLOAD_MEDIA: "true"` (atualizar o comentário). Conferir na
  documentação do WAHA se existem `WHATSAPP_FILES_MIMETYPES` (baixar só `audio`) e `WHATSAPP_FILES_LIFETIME`
  (apagar depois de poucos minutos); se existirem, usar. Registrar o que foi encontrado.
- `docs/WAHA.md`: seção "Áudio" com o passo a passo do usuário (spec, seção 6) e o que fazer se não
  funcionar. `README.md`: variáveis novas.

- [ ] **Step 1: Testes que falham** — preflight com fetch falso: 200 → `ok`; 401 → `chave recusada`;
  exceção → `sem resposta`; a chave não aparece na saída; `off` não faz requisição.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS. `pnpm -r test` e `pnpm -r exec tsc --noEmit` limpos.
- [ ] **Step 5:** Commit `feat: check audio transcription in preflight and enable WAHA media download`.

---

### Task 6: Teste ponta a ponta (com o usuário)

- [ ] **Step 1:** Usuário coloca `GROQ_API_KEY` e `AUDIO_TRANSCRIPTION=groq` no `.env` (não colar a chave no chat).
- [ ] **Step 2:** `docker compose -f docker-compose.waha.yml up -d` (recria o WAHA; a sessão continua) e `pnpm dev`.
- [ ] **Step 3:** Preflight mostra `Áudio: groq ... ok`.
- [ ] **Step 4:** Pelo celular, só com áudios: "oi, quero um botijão de 13 no pix", nome e endereço,
  "não tenho vazio", e depois do resumo um áudio "pode confirmar". Conferir: o painel mostra `🎤 ...`; o
  resumo sai do código; o pedido é registrado (simulado).
- [ ] **Step 5:** Áudio de 1 segundo em silêncio → resposta "Não consegui entender o seu áudio...".
- [ ] **Step 6:** "Quero falar com uma pessoa" e depois um áudio → transcrição no painel, bot calado.
- [ ] **Step 7:** Anotar no plano o que foi visto (formato real de `payload.media` no GOWS, tempo médio da transcrição).
