# WhatsApp na apresentação (WAHA)

> **Só para a demonstração.** O WAHA conecta um número de WhatsApp comum, como o WhatsApp Web. Isso
> não é a API oficial, viola os termos do WhatsApp e **o número pode ser banido**. Use um **chip
> reserva**, nunca o seu número pessoal nem o da revenda. Em produção, o canal seria a API oficial da
> Meta. Avise isso à banca.

## Como funciona

```
Celular de quem testa ─WhatsApp─> chip reserva ─QR─> WAHA (Docker, 127.0.0.1:3002)
                                                       │ POST /webhooks/waha + X-Revgas-Secret
                                                       ▼
                               apiRevGas: servidor do webhook (127.0.0.1:3334, só essa rota)
                                                       ▼
                               o mesmo atendente virtual do chat simulado
                                                       │
                       resposta ──> painel (sempre) + WhatsApp (conversas do WhatsApp)
```

- O painel e o chat simulado continuam em `http://localhost:5173` (servidor na porta 3333). O WAHA
  nunca fala com a porta 3333.
- A porta 3334 tem uma rota só, `POST /webhooks/waha`, e recusa (401) qualquer chamada sem o segredo.
- Mensagens repetidas, enviadas pelo próprio chip ou de grupos são ignoradas.
- Com a transcrição ligada (seção "Áudio" abaixo), o bot entende áudio. Para foto, figurinha, vídeo ou
  documento (e áudio, com a transcrição desligada), responde "Por enquanto eu entendo só mensagens de
  texto. Pode escrever o seu pedido?".
- O resumo do pedido chega com o botão **Ver opções**, que abre **Confirmar** e **Mudar algo**. Se a lista falhar,
  o resumo vai como texto, com "Responda *sim* para confirmar".
- Nenhuma venda vai para a RevGás: `REVGAS_WRITE_ENABLED` continua `false` e as vendas são simuladas.

## O que você precisa

- Docker Desktop aberto (ícone da baleia ativo).
- Um chip reserva com WhatsApp, num celular.
- Outro celular para mandar as mensagens de teste.

## Passo a passo

### 1. Gerar dois segredos

No PowerShell, rode este comando duas vezes e anote os dois resultados:

```powershell
[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
```

O primeiro vira a chave do WAHA (`WAHA_API_KEY`); o segundo, o segredo do webhook (`WAHA_WEBHOOK_SECRET`).

### 2. Preencher o `.env`

Na pasta do projeto, edite o `.env` (nunca o `.env.example`):

```
WHATSAPP_PROVIDER=waha
WAHA_URL=http://localhost:3002
WAHA_API_KEY=<primeiro texto>
WAHA_WEBHOOK_SECRET=<segundo texto>
WAHA_SESSION=default
WHATSAPP_WEBHOOK_PORT=3334
# Recomendado: só os números da banca e da equipe, com DDD, separados por vírgula
WHATSAPP_ALLOWED_NUMBERS=86999998888,86988887777
```

Não compartilhe esses valores nem o `.env`. Com `WHATSAPP_ALLOWED_NUMBERS` vazio, qualquer pessoa que
souber o número do chip usa o bot e gasta créditos da IA.

### 3. Subir o WAHA

```powershell
cd C:\Users\Gabriel\Desktop\apiRevGas
docker compose -f docker-compose.waha.yml up -d
```

Na primeira vez, o Docker baixa a imagem, o que leva alguns minutos. Confira com `docker ps`: deve
aparecer `apirevgas-waha`. O WAHA fica num arquivo separado (`docker-compose.waha.yml`) para que o
`docker compose up -d` de sempre continue subindo só o Postgres, mesmo sem os segredos no `.env`.

### 4. Conectar o chip pelo QR

1. Abra http://localhost:3002/dashboard. Usuário: `admin`. Senha: o valor de `WAHA_API_KEY`.
2. Na sessão `default`, clique em **Start** se ela estiver parada, depois em **QR**.
3. No celular com o chip: WhatsApp → **Aparelhos conectados** → **Conectar um aparelho** → aponte
   para o QR.
4. Espere a sessão ficar com o status **WORKING**.

### 5. Subir o apiRevGas

```powershell
pnpm dev
```

No terminal do servidor, devem aparecer:

```
[whatsapp] aviso: WhatsApp não oficial (WAHA), só para demonstração; o número pode ser banido
[whatsapp] webhook em http://127.0.0.1:3334/webhooks/waha (só 2 número(s) permitidos)
```

Se o servidor já estava rodando antes de você mexer no `.env`, pare (Ctrl+C) e rode de novo: o `.env`
só é lido ao iniciar.

### 6. Conferir tudo

```powershell
pnpm --filter server preflight
```

Na parte **WhatsApp**, `WAHA_SESSION` deve mostrar `default: WORKING` e `ok`.

### 7. Testar

Do outro celular, mande "oi" para o número do chip. O bot responde no WhatsApp, e a conversa aparece
no painel (aba **Atendimento**) com o selo **WhatsApp**. O roteiro completo está no `README.md`, em
"WhatsApp na apresentação (WAHA)".

## Áudio (transcrição pela Groq)

O cliente pode mandar áudio: o bot baixa a nota de voz do WAHA, transcreve pela Groq e responde em
texto, como se ele tivesse escrito. No painel, a mensagem aparece como `🎤 <o que foi entendido>`,
inclusive quando a conversa está com um atendente (aí o bot não responde, só grava). O preço, o resumo
e a confirmação continuam vindo do código: um "pode confirmar" falado só vale depois do resumo, como
um "sim" escrito.

**Privacidade:** o áudio do cliente é enviado à Groq, um serviço de fora. Para a demonstração, tudo
bem; em produção, isso precisa entrar na política de privacidade da revenda (LGPD). O arquivo não é
guardado: só o texto transcrito fica no banco, e o WAHA apaga o arquivo depois de 5 minutos.

### Ligar

1. Crie uma conta em https://console.groq.com, vá em **API Keys** e gere uma chave. Não cole a chave
   no chat nem em nenhum arquivo além do `.env`.
2. No `.env`:
   ```
   AUDIO_TRANSCRIPTION=groq
   GROQ_API_KEY=<a chave da Groq>
   ```
   As outras variáveis (`TRANSCRIBE_URL`, `TRANSCRIBE_MODEL`, `AUDIO_MAX_BYTES`) já têm padrão; veja o
   `.env.example`. O plano gratuito da Groq tem limite de pedidos por minuto e por dia: confira os
   números atuais no console.
3. Recrie o WAHA para ele passar a baixar áudio (a sessão continua; não precisa ler o QR de novo):
   ```powershell
   docker compose -f docker-compose.waha.yml up -d
   ```
4. Reinicie o `pnpm dev`. No terminal deve aparecer
   `[áudio] transcrição ligada (whisper-large-v3-turbo); o áudio do cliente é enviado à Groq`.
5. `pnpm --filter server preflight` deve mostrar `AUDIO_TRANSCRIPTION  groq (whisper-large-v3-turbo): ok`.

### Respostas fixas

| Situação | O bot responde |
|---|---|
| A transcrição falhou ou veio vazia (silêncio, Groq fora do ar, limite atingido) | "Não consegui entender o seu áudio. Pode escrever para mim?" |
| Áudio maior que `AUDIO_MAX_BYTES` (padrão 2 MB, cerca de 3 a 4 minutos) | "Esse áudio ficou longo demais para mim. Pode mandar um mais curto ou escrever?" |

Não há nova tentativa automática: o cliente é convidado a escrever.

### Se não funcionar

- **O bot responde "entendo só texto" a um áudio.** A transcrição está desligada (`AUDIO_TRANSCRIPTION`
  não é `groq`, ou o `pnpm dev` não foi reiniciado), ou o WAHA não baixou o arquivo: recrie o WAHA
  (passo 3) e confira em `docker compose -f docker-compose.waha.yml logs -f waha`.
- **O bot responde "Não consegui entender o seu áudio".** Veja o terminal do servidor: a linha
  `[áudio] falha ...` diz o tipo do erro (`auth 401` = chave errada; `rate_limited 429` = limite da
  Groq; `network` = sem internet ou a Groq não respondeu). O conteúdo do áudio nunca vai para o log.
- **O preflight mostra "chave recusada".** Gere outra chave no console da Groq e troque no `.env`.

### Desligar

`AUDIO_TRANSCRIPTION=off` no `.env` e reinicie o `pnpm dev`. Os áudios voltam a receber "entendo só texto".

## Problemas comuns

- **O bot não recebe nada.** Veja `docker compose -f docker-compose.waha.yml logs -f waha`. O WAHA
  precisa alcançar `host.docker.internal:3334`. Confirme que o `pnpm dev` está rodando com
  `WHATSAPP_PROVIDER=waha` (aparece o aviso do passo 5) e que o número de quem testa está em
  `WHATSAPP_ALLOWED_NUMBERS`.
- **O log do WAHA mostra 401 no webhook.** O `WAHA_WEBHOOK_SECRET` do WAHA é diferente do que o
  servidor leu. Depois de mudar o `.env`, rode `docker compose -f docker-compose.waha.yml up -d` de
  novo e reinicie o `pnpm dev`.
- **Erro 401 ao responder ("mensagem não entregue" no painel).** A `WAHA_API_KEY` do `.env` não é a
  mesma com que o WAHA subiu. Mesma solução do item anterior.
- **No terminal: "contato @lid sem telefone; mensagem ignorada".** O WhatsApp novo identifica alguns
  contatos por um código (`...@lid`) em vez do telefone, e o bot pergunta ao WAHA qual é o número. Se
  o WAHA não souber, a mensagem é descartada. Confira se a sessão está **WORKING** e peça para a
  pessoa mandar de novo.
- **Número sem o nono dígito.** Alguns números antigos aparecem no WhatsApp sem o 9. Antes de
  responder, o bot pergunta ao WAHA qual é o endereço certo do contato. Na lista de permitidos, escreva
  o número normal (com o 9): ele vale com ou sem o 9. No painel, o número aparece como o WhatsApp
  mandou (às vezes sem o 9).
- **No painel, "não entregue" numa resposta.** O WAHA não aceitou a mensagem (sessão caiu, chave
  errada, WAHA fora do ar). Veja o terminal do servidor e o status da sessão no painel do WAHA.
- **O chat simulado diz "Esta conversa é do WhatsApp; responda pelo painel".** É de propósito: o
  número escolhido no chat simulado é de alguém que escreveu pelo WhatsApp, e o chat simulado não pode
  falar no lugar dele. Use outro número no chat simulado.
- **Não rode o WAHA do projeto Rev-Gás com o mesmo chip ao mesmo tempo.** Os dois disputam a mesma
  conexão. Desligue o outro com `docker compose down` na pasta do Rev-Gás.

## Cuidados para o número não ser banido

- Teste só com a equipe e com quem sabe do teste.
- Não mande mensagens em massa nem para quem não estava esperando.
- Se o número cair, troque o chip e escaneie o QR de novo.

## Depois da apresentação

1. No `.env`: `WHATSAPP_PROVIDER=off`, e reinicie o `pnpm dev`. O chat simulado continua igual.
2. Desligue o WAHA: `docker compose -f docker-compose.waha.yml down`. A sessão fica guardada em
   `.waha/` (fora do git).
3. Para desconectar o chip de vez: no celular, WhatsApp → **Aparelhos conectados** → remova o aparelho;
   depois apague a pasta `.waha/`.

## Comandos úteis

| Comando | O que faz |
|---|---|
| `docker compose -f docker-compose.waha.yml up -d` | liga o WAHA |
| `docker compose -f docker-compose.waha.yml down` | desliga (a sessão é mantida) |
| `docker compose -f docker-compose.waha.yml logs -f waha` | mostra o que o WAHA está fazendo |
| `pnpm --filter server preflight` | confere a configuração e o status da sessão |
