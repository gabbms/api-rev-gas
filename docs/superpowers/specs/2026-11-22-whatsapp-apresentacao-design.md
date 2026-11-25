# WhatsApp para a apresentação — Design

> **Substituído para a apresentação** por `2026-11-25-whatsapp-waha` (a Cloud API da Meta foi bloqueada com o erro 130497 no projeto Rev-Gás). Mantido como referência para produção.


Data: 2026-11-22 · Status: aguardando revisão do usuário

## 1. Intenção

Mostrar na apresentação o atendente virtual funcionando **no WhatsApp de verdade**: alguém manda
mensagem do próprio celular para o número de teste da Meta, o bot responde, o resumo chega com botões, o
"Confirmar" vira pedido registrado (simulado) e a conversa aparece no painel do atendente.

Critério de sucesso: no dia da apresentação, os 4 celulares da equipe (cadastrados como destinatários de
teste) conseguem fazer o roteiro da demo pelo WhatsApp, e o painel mostra as conversas e os bastidores.

## 2. Objetivos, não-objetivos, anti-objetivos

### Objetivos
- Receber mensagens do WhatsApp (API oficial da Meta, WhatsApp Cloud API) por webhook.
- Responder pelo WhatsApp com os mesmos textos do bot e do atendente.
- Enviar o resumo do pedido com botões **"Confirmar"** e **"Mudar algo"**.
- Aceitar **localização** enviada pelo cliente (vira latitude/longitude na venda).
- Responder com educação a áudio, imagem, figurinha etc.: "por enquanto entendo só texto".
- Continuar com o chat simulado funcionando (plano B da apresentação).
- Painel do atendente mostrando também as conversas do WhatsApp; resposta do atendente sai pelo WhatsApp.

### Não-objetivos (ficam para produção)
- Número próprio da revenda, verificação da empresa na Meta, hospedagem em nuvem.
- Modelos de mensagem (templates) e mensagens fora da janela de 24 horas.
- Transcrição de áudio.
- Caixa de atendimento com login (Chatwoot ou similar).
- Vendas reais (continua `REVGAS_WRITE_ENABLED=false`).

### Anti-objetivos (falha mesmo que funcione)
- **Expor o painel ou o WebSocket na internet.** O túnel só pode alcançar o webhook.
- Aceitar webhook sem conferir a assinatura da Meta.
- Processar a mesma mensagem duas vezes (a Meta reenvia webhooks).
- Um desconhecido que descubra o número de teste conseguir usar o bot (gasto de IA, dados falsos no painel).
- Vazar o token da Meta, o segredo do app ou o token de verificação.
- Usar bibliotecas não oficiais de WhatsApp (violam os termos e podem levar a bloqueio do número).

## 3. Restrições conhecidas

- **Número de teste da Meta:** gratuito, envia só para até 5 números cadastrados como destinatários.
- **Janela de 24 horas:** mensagem livre só até 24 h após a última mensagem do cliente. Na demo, o cliente
  sempre escreve primeiro, então não há problema.
- **Token temporário expira em 24 h.** Para a apresentação, usar um token de usuário do sistema
  (permanente) ou gerar um novo no dia.
- **O webhook precisa de URL pública https.** O servidor roda no computador do apresentador; usa-se um
  túnel.
- **Número brasileiro e o nono dígito:** o identificador do WhatsApp (`wa_id`) pode vir sem o 9 (ex.:
  `558699998888`). A conversa é identificada pelo telefone normalizado, mas **a resposta precisa ir para o
  `wa_id` exatamente como chegou**.
- O servidor atual não tem autenticação e escuta só em `127.0.0.1`.
- Limite de 1 req/s é da RevGás e não muda.

## 4. Abordagens consideradas

| Opção | Prós | Contras | Decisão |
|---|---|---|---|
| **WhatsApp Cloud API (oficial) + túnel** | Oficial, gratuito para teste, sem risco de bloqueio, mesma API da produção | Exige conta na Meta e URL pública | **Escolhida** |
| Intermediário (Twilio, 360dialog) | Painel e suporte | Custo e mais uma conta; mesma API por baixo | Descartada |
| Biblioteca não oficial (Baileys, Evolution) | Usa qualquer número na hora | Viola os termos; número pode ser banido | Descartada |

Túnel: **ngrok com domínio estático gratuito** (o endereço não muda entre uma execução e outra, então o
webhook é configurado uma vez na Meta). Alternativa: Cloudflare Tunnel rápido, cujo endereço muda a cada
execução e obriga a reconfigurar o webhook. Escolha minha, revisável.

## 5. Como funciona

```
Celular ─WhatsApp─> Meta ─webhook https─> túnel ─> :3334 (só webhook) ─┐
                                                                       ├─> ConversationService ─> (IA, pedidos, RevGás: iguais)
Navegador local ─> :3333 (tela, painel, WebSocket, só 127.0.0.1) ─────┘
                                 ▲
Respostas: ConversationService ─> roteador de canal ─┬─> WhatsApp (Graph API)
                                                     └─> painel (sempre)
```

### 5.1 Dois servidores, uma porta exposta
- **:3333** continua como está: tela, painel, WebSocket, só em `127.0.0.1`, **nunca no túnel**.
- **:3334** novo, só com `GET /webhooks/whatsapp` (verificação) e `POST /webhooks/whatsapp` (mensagens).
  Também em `127.0.0.1`; o túnel aponta só para ele.

### 5.2 Recebimento
1. `GET`: confere `hub.mode=subscribe` e `hub.verify_token` e devolve `hub.challenge`.
2. `POST`: confere a assinatura `X-Hub-Signature-256` (HMAC-SHA256 do corpo bruto com o segredo do app).
   Sem assinatura válida → 401, nada é processado.
3. Responde **200 na hora**; o processamento segue em segundo plano.
4. Para cada mensagem: ignora repetidas (id da mensagem já visto), ignora números fora da lista de
   permitidos (se configurada), marca como lida, e entrega ao `ConversationService` com o canal
   `whatsapp` e o endereço (`wa_id`).
5. Notificações de status (entregue, lida) são ignoradas.

### 5.3 Tipos de mensagem
| Tipo | O que o sistema faz |
|---|---|
| Texto | Vai para a IA como hoje |
| Resposta de botão | Vira o texto do botão ("Confirmar" / "Mudar algo") e vai para a IA; a trava de confirmação do código continua valendo |
| Localização | Guarda latitude/longitude na conversa e envia à IA um texto "[Localização recebida: endereço, se vier]"; a próxima venda leva `lat`/`lon` |
| Áudio, imagem, vídeo, figurinha, documento | Resposta fixa: "Por enquanto eu entendo só mensagens de texto. Pode escrever o seu pedido?" |

### 5.4 Envio
- Um **roteador de canal** substitui o `send` atual: toda mensagem de saída vai para o painel (como hoje)
  e, se a conversa é do canal `whatsapp`, também para a Graph API.
- O **resumo** no WhatsApp vai como mensagem interativa com 2 botões de resposta. Se o texto passar do
  limite da mensagem interativa, vai como texto seguido de uma mensagem curta com os botões.
- Falha de envio: uma nova tentativa em erro de rede ou 5xx; depois, registra no log e marca a mensagem
  com falha no painel. Erro 4xx não é repetido.
- A resposta do atendente no painel sai pelo WhatsApp quando a conversa é desse canal.

### 5.5 Dados
- `conversations` ganha `channel` (`simulated` | `whatsapp`, padrão `simulated`), `channelAddress`
  (o `wa_id`, nulo no simulado), `lastLat`, `lastLon`, `lastLocationAt`.
- Tabela nova `inbound_events` (id da mensagem da Meta, único; data) para não processar duas vezes.
- `messages` ganha `deliveryStatus` (`sent` | `failed`, nulo no simulado).

### 5.6 Configuração (tudo desligado por padrão)
`WHATSAPP_ENABLED=false`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_VERSION` (versão da Graph API; conferir a atual na documentação
da Meta), `WHATSAPP_WEBHOOK_PORT=3334`, `WHATSAPP_ALLOWED_NUMBERS` (lista opcional; na apresentação, os
4 números da equipe). Os segredos só no `.env`.

### 5.7 Preflight
Novas linhas: WhatsApp ligado ou não, token válido (leitura do número pela Graph API, sem enviar nada),
lista de permitidos vazia (aviso: "qualquer pessoa que achar o número usa o bot"), porta do webhook.

## 6. O que fica com o usuário (não é código)

1. Conta de desenvolvedor da Meta, app do tipo Business com o produto WhatsApp.
2. Número de teste e cadastro dos 4 celulares da equipe como destinatários.
3. Token (de preferência permanente, de usuário do sistema), id do número e segredo do app no `.env`.
4. Conta no ngrok com domínio estático, túnel apontando para `localhost:3334`.
5. Configurar o webhook na Meta (URL do túnel + `/webhooks/whatsapp`, token de verificação) e assinar o
   campo `messages`.

## 7. O que fica para quem construir
- Formato exato das chamadas à Graph API e da mensagem interativa, conferido na documentação da Meta.
- Estrutura interna dos arquivos, mantendo o canal isolado em `channels/whatsapp/`.
- Texto das mensagens fixas, em português, curto.
