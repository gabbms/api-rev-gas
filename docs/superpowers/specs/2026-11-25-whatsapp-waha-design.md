# WhatsApp na apresentação via WAHA — Design

Data: 2026-11-25 · Status: aprovado pelo usuário (caminho "WAHA levado para o apiRevGas")
Substitui, para a apresentação, `2026-11-22-whatsapp-apresentacao-design.md` (Meta Cloud API).

## 1. Intenção

Na apresentação, o professor e o dono da RevGás mandam mensagem **do próprio celular** para o número
de um chip reserva da equipe, e o atendente virtual do apiRevGas responde pelo WhatsApp. A conversa
aparece no painel (aba Atendimento, com selo **WhatsApp**) e os bastidores mostram a IA trabalhando.

## 2. Por que WAHA, e não a API oficial

- No projeto irmão (`C:\Users\Gabriel\Desktop\Rev-Gás`) a Cloud API da Meta foi bloqueada: erro
  **130497** (conta restrita para o Brasil) por falta de verificação do negócio, que exige CNPJ.
- O número de teste da Meta só conversa com até 5 números cadastrados antes; a demo precisa que
  qualquer pessoa da banca escreva na hora.
- O Rev-Gás já tem um canal WAHA testado de ponta a ponta com um chip de teste.

**Riscos aceitos:** WAHA não é oficial, viola os termos do WhatsApp e o número pode ser banido.
Mitigação: chip reserva descartável, uso só na demonstração, aviso explícito à banca de que em
produção o canal seria a API oficial.

## 3. Objetivos

- Receber mensagens de texto do WhatsApp via WAHA e entregá-las ao `ConversationService` atual.
- Responder pelo WhatsApp com os mesmos textos do bot e do atendente.
- Resumo do pedido com lista de opções ("Confirmar" / "Mudar algo"), com volta para texto se falhar.
- Áudio, imagem, figurinha, documento: resposta educada ("por enquanto entendo só texto").
- Painel com selo WhatsApp/Simulado; chat simulado continua como plano B.
- Tudo desligado por padrão (`WHATSAPP_PROVIDER=off`).

## 4. Não-objetivos

API oficial da Meta, transcrição de áudio, comprovante Pix, aviso ao entregador pelo WhatsApp,
modelos de mensagem, hospedagem em nuvem, vendas reais (`REVGAS_WRITE_ENABLED` continua `false`).

## 5. Anti-objetivos

- Expor o painel ou o WebSocket (:3333) fora do computador.
- Aceitar webhook sem o segredo `X-Revgas-Secret`.
- Processar a mesma mensagem duas vezes.
- Responder em grupos ou a mensagens enviadas pelo próprio chip.
- Vazar `WAHA_API_KEY` ou `WAHA_WEBHOOK_SECRET`.

## 6. Como funciona

```
Celular ─WhatsApp─> chip reserva ─QR─> WAHA (Docker, 127.0.0.1:3002, engine GOWS)
                                          │ webhook POST /webhooks/waha + X-Revgas-Secret
                                          ▼
                     apiRevGas: servidor do webhook (:3334, só esta rota)
                                          │ dedupe, @lid → telefone, lista de permitidos
                                          ▼
                     ConversationService.handleInbound(channel "whatsapp")
                     (IA, pedidos, catálogo, RevGás: sem mudança)
                                          │
              roteador de saída ──> painel (sempre) + WAHA sendText/sendList (conversas WhatsApp)
```

- **Dois servidores:** :3333 (tela, painel, WebSocket) continua em `127.0.0.1`. O novo :3334 tem só
  `POST /webhooks/waha`. O WAHA (no Docker) alcança o host por `host.docker.internal`.
- **Reaproveitamento:** `src/whatsapp/waha.ts` do Rev-Gás (cliente WAHA, verificação do segredo em
  tempo constante, resolução de `@lid`, consulta de nono dígito por `check-exists`, parser do webhook)
  e os testes de `tests/whatsapp/waha.test.ts`, adaptados ao apiRevGas (inglês no código, tipos próprios).
- **Endereço de resposta:** a conversa guarda `channelAddress` (dígitos com 55, como vieram do WAHA);
  o cliente WAHA resolve o `chatId` certo antes de enviar.
- **Opções:** o resumo oficial vai por `sendList` com as linhas "Confirmar" e "Mudar algo". A resposta
  do cliente chega como texto (o título da linha) e segue para a IA; a trava de confirmação do código
  não muda. Se `sendList` falhar, o resumo vai como texto com "Responda *sim* para confirmar".

## 7. Configuração

`WHATSAPP_PROVIDER=off|waha` (padrão `off`), `WAHA_URL=http://localhost:3002`, `WAHA_API_KEY`,
`WAHA_WEBHOOK_SECRET`, `WAHA_SESSION=default`, `WHATSAPP_WEBHOOK_PORT=3334`,
`WHATSAPP_ALLOWED_NUMBERS` (opcional; vazio = qualquer número). Serviço `waha` no `docker-compose.yml`
do apiRevGas, sessão em `.waha/` (fora do git), porta `127.0.0.1:3002`.

## 8. Fica com o usuário

Chip reserva num celular, escanear o QR no painel do WAHA, gerar os dois segredos, preencher o `.env`.
Não rodar o WAHA do Rev-Gás com o mesmo chip ao mesmo tempo.
