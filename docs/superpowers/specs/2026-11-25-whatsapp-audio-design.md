# Áudio no WhatsApp (transcrição pela Groq) — Design

Data: 2026-11-25 · Status: aguardando revisão do usuário · Depende de: `2026-11-25-whatsapp-waha` (branch `feat/whatsapp-waha`)

## 1. Intenção

O cliente manda um **áudio** no WhatsApp ("quero um botijão no pix, rua tal, número tal") e o bot entende e
responde como se ele tivesse escrito. Hoje o bot responde só "Por enquanto eu entendo só mensagens de texto".

Critério de sucesso: no roteiro da demonstração, um pedido completo feito **só por áudio** (inclusive o
"pode confirmar" falado) chega ao resumo e ao pedido registrado (simulado), e o painel mostra o que foi
transcrito.

## 2. Objetivos, não-objetivos, anti-objetivos

### Objetivos
- Baixar o áudio recebido pelo WAHA e transcrever em português com a **Groq** (API compatível com a da OpenAI).
- Entregar a transcrição à conversa como mensagem do cliente, marcada como áudio.
- Mostrar no painel a transcrição com a marca 🎤 (atendente lê o que o cliente falou, também no modo humano).
- Falha na transcrição: resposta fixa pedindo para escrever.
- Tudo desligado por padrão (`AUDIO_TRANSCRIPTION=off`); com `off`, o comportamento atual continua.

### Não-objetivos
- Bot respondendo em áudio (resposta continua em texto).
- Imagem, figurinha, vídeo, documento (continuam com a resposta fixa de hoje).
- Chat simulado com microfone.
- Guardar o arquivo de áudio.

### Anti-objetivos (falha mesmo que funcione)
- **Transcrição decidindo dinheiro.** O áudio vira texto e entra pelo mesmo caminho do texto: preço do
  `Catalog`, resumo do código, venda só por `OrderService.confirm`. Nada disso muda.
- **Um "sim" falado antes do resumo valer como confirmação** porque a transcrição demorou (ver 5.4).
- Vazar `GROQ_API_KEY`, o corpo das respostas da Groq ou a transcrição nos logs.
- Baixar arquivo de um endereço que não seja o WAHA (o caminho vem do webhook; só o caminho é usado).
- Áudio enorme travando a fila do cliente ou gastando cota (limite de tamanho, ver 5.2).

## 3. Restrições conhecidas

- **O Claude não recebe áudio** na API de mensagens: é preciso transcrever antes.
- **WAHA:** hoje `WHATSAPP_DOWNLOAD_MEDIA=false`. Com `true`, o webhook traz `payload.media.url`
  (arquivo servido pelo próprio WAHA, protegido pela `X-Api-Key`) e `payload.media.mimetype`
  (nota de voz do WhatsApp: `audio/ogg; codecs=opus`). O projeto Rev-Gás já usa isso com o motor GOWS.
  A URL vem com o host interno do container (`localhost:3000`): usa-se só o caminho, sobre `WAHA_URL`.
- **Groq:** `POST https://api.groq.com/openai/v1/audio/transcriptions`, `multipart/form-data` com `file`,
  `model` (`whisper-large-v3-turbo` ou `whisper-large-v3`), `language=pt`; header
  `Authorization: Bearer <chave>`; resposta `{ "text": "..." }`. Aceita OGG. Plano gratuito tem limite
  de requisições e de tamanho de arquivo (25 MB): conferir os números atuais no console da Groq.
- **Privacidade:** o áudio do cliente vai para um serviço de fora (Groq). Na demonstração, aceitável; em
  produção, entra na política de privacidade da revenda (LGPD).
- Limite de 1 req/s é da RevGás e não muda.

## 4. Abordagens consideradas

| Opção | Prós | Contras | Decisão |
|---|---|---|---|
| **Groq (Whisper)** | Plano gratuito, rápido, mesma interface da OpenAI | Conta e chave novas; limite do plano gratuito | **Escolhida pelo usuário** |
| OpenAI (Whisper / gpt-4o-mini-transcribe) | Padrão do Rev-Gás | Pago | O código aceita trocando URL, modelo e chave |
| Whisper local | Sem serviço de fora | Pesado no notebook da apresentação, lento | Descartada |

## 5. Como funciona

```
WAHA ─webhook─> :3334 POST /webhooks/waha
   └─ parse: áudio com media.url → { kind: "audio", mediaUrl, mime }
   └─ fila do remetente (mesma de hoje):
        1. baixa o arquivo do WAHA (só o caminho /api/files/..., com X-Api-Key, limite de tamanho)
        2. transcreve na Groq (timeout, pt)
        3. ConversationService.handleInbound({ kind: "audio", text: transcrição, receivedAt })
             ├─ grava "🎤 <transcrição>" como mensagem do cliente (painel)
             └─ IA recebe "[Áudio do cliente, transcrito automaticamente] <transcrição>"
        falhou ou veio vazio → handleInbound({ kind: "audio_failed" })
             ├─ grava "[áudio não transcrito]"
             └─ responde AUDIO_FAILED_TEXT (fora do modo humano), sem chamar a IA
```

### 5.1 Mensagem recebida
- `parseWahaWebhook`: `hasMedia` + `mimetype` `audio/*` + `media.url` → `kind: "audio"` com `mediaUrl` e
  `mime`. Sem `media.url` (download desligado ou falhou) → como hoje: `unsupported`, `[áudio]`.
- Com `AUDIO_TRANSCRIPTION=off`, um `kind: "audio"` é tratado como `unsupported` (resposta de hoje).

### 5.2 Download (cliente WAHA)
- `downloadMedia(url)`: pega `pathname + search` da URL recebida, exige que comece com `/api/files/`, e
  busca em `WAHA_URL` + caminho com `X-Api-Key`. Outro caminho → erro, nada é buscado.
- Limite `AUDIO_MAX_BYTES` (padrão 2 MB ≈ 3 a 4 minutos de nota de voz): recusa por `content-length` e
  também ao ler o corpo. Áudio grande demais → `audio_too_long` com o texto "Esse áudio ficou longo demais
  para mim. Pode mandar um mais curto ou escrever?".
- Timeout de 15 s. Erros sem corpo nem chave na mensagem (como `WhatsAppError`).

### 5.3 Transcrição
- Módulo novo `apps/server/src/audio/transcriber.ts`, adaptado do Rev-Gás
  (`src/audio/transcriber.ts`): interface `Transcriber { transcribe(audio, mime): Promise<string> }` e
  `createOpenAICompatibleTranscriber({ apiKey, url, model, fetch?, timeoutMs? })`.
- Nome do arquivo pela extensão do mime (`audio/ogg` → `audio.ogg`); `language=pt`.
- Erros como `TranscriptionError` com tipo (`auth`, `rate_limited`, `invalid`, `server`, `network`) e
  status; nunca o corpo da resposta nem a chave. **Sem nova tentativa automática**: na demo, falhou → pede
  para escrever. Timeout 20 s.
- Log: só tipo do erro e duração; nunca a transcrição.

### 5.4 Horário da mensagem (correção que entra junto)
Hoje, no WhatsApp, a fila do remetente espera o turno inteiro da IA antes de passar para a mensagem
seguinte. A mensagem seguinte só é gravada depois, com o horário da gravação. Se o cliente escreve "sim"
enquanto a IA ainda monta o resumo, o "sim" fica com horário **depois** do `presentedAt` e pode contar como
confirmação de um resumo que o cliente ainda não viu. Com áudio isso piora: a transcrição leva segundos.

Correção: o servidor do webhook marca `receivedAt` (relógio do app) **quando o POST chega**, e
`handleInbound` grava a mensagem com `createdAt = receivedAt`. A trava do `OrderService.confirm` não muda:
continua exigindo mensagem do cliente com horário depois do `presentedAt`. O chat simulado continua usando
o horário da chegada (já é o mesmo momento).

### 5.5 IA
- A IA recebe o texto com o prefixo `[Áudio do cliente, transcrito automaticamente]`.
- Uma frase nova no prompt de sistema: mensagens de áudio são transcritas automaticamente e podem trocar
  nomes, números e endereços; na dúvida, perguntar. (O resumo escrito, gerado pelo código, continua sendo a
  conferência final.) Mudar o prompt invalida o raciocínio gravado; o `drop_block` já cobre isso.

### 5.6 Painel
- A mensagem do cliente aparece como `🎤 <transcrição>`. Sem mudança de tela: é o texto da mensagem.
- Modo humano: grava a transcrição e não chama a IA (como o texto hoje), para o atendente ler.

### 5.7 Configuração (desligado por padrão)
`.env` / `.env.example`:
```
# Transcrição de áudio do WhatsApp. off = responde "entendo só texto". groq = transcreve pela Groq.
AUDIO_TRANSCRIPTION=off
GROQ_API_KEY=
TRANSCRIBE_URL=https://api.groq.com/openai/v1/audio/transcriptions
TRANSCRIBE_MODEL=whisper-large-v3-turbo
AUDIO_MAX_BYTES=2000000
```
- `AUDIO_TRANSCRIPTION=groq` exige `GROQ_API_KEY` e `WHATSAPP_PROVIDER=waha`.
- `docker-compose.waha.yml`: `WHATSAPP_DOWNLOAD_MEDIA: "true"` e, se o WAHA aceitar (conferir na
  documentação), baixar só áudio e apagar os arquivos depois de poucos minutos
  (`WHATSAPP_FILES_MIMETYPES`, `WHATSAPP_FILES_LIFETIME`).

### 5.8 Preflight
Linha nova: transcrição `off` ou `groq`; com `groq`, confere a chave com uma leitura
(`GET https://api.groq.com/openai/v1/models`, sem enviar áudio) e mostra `ok` / `chave recusada` / `sem
resposta`. Aviso se `AUDIO_TRANSCRIPTION=groq` e o WAHA não baixa mídia.

## 6. O que fica com o usuário
1. Criar conta na Groq (console.groq.com), gerar a chave e colocar em `GROQ_API_KEY` no `.env`.
   Não mandar a chave no chat.
2. `AUDIO_TRANSCRIPTION=groq` no `.env`.
3. Recriar o container do WAHA (`docker compose -f docker-compose.waha.yml up -d`); a sessão continua (o QR
   não precisa ser lido de novo).
4. Testar com o celular: pedido inteiro por áudio.

## 7. O que fica para quem construir
- Formato exato do `payload.media` no GOWS: conferir num webhook real ou na documentação do WAHA.
- Nomes internos, mantendo áudio em `apps/server/src/audio/` e o download no cliente WAHA.
- Textos fixos em português, curtos.
