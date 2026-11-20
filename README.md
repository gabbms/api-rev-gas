# Atendimento IA RevGás

Bot de atendimento com IA para revendas de gás (GLP), integrado ao ERP RevGás. Um cliente conversa em
linguagem natural ("manda um botijão, pago no pix"), a IA monta o pedido, o sistema envia um resumo com
preço e total, e depois de um "sim" a venda é registrada na RevGás com canal WhatsApp.

Projeto acadêmico da iCEV (Escola de Tecnologia Aplicada) em parceria com a RevGás. Nesta primeira
versão o WhatsApp é **simulado** por uma página web; o WhatsApp real entra depois, atrás da mesma
interface de canal.

- Design: [docs/superpowers/specs/2026-11-20-atendimento-ia-revgas-design.md](docs/superpowers/specs/2026-11-20-atendimento-ia-revgas-design.md)
- Plano de implementação: [docs/superpowers/plans/2026-11-20-atendimento-ia-revgas-v1.md](docs/superpowers/plans/2026-11-20-atendimento-ia-revgas-v1.md)

## Como funciona

```
[Chat simulado (React)] ──WebSocket──> [Servidor Fastify] ──> [Agente Claude + ferramentas]
                                              │                        │
                                         [PostgreSQL]          [Cliente RevGás: fila 1 req/s]
                                                                       │
                                                              api.revgas.com/v1
```

A IA só conversa e pede ferramentas (`buscar_cliente`, `listar_produtos`, `montar_pedido`,
`confirmar_pedido`, `consultar_pedido`, `chamar_atendente`). Tudo o que envolve dinheiro é código:

- o preço vem de [apps/server/config/prices.json](apps/server/config/prices.json), nunca do texto da IA;
- o resumo do pedido é gerado pelo sistema e enviado ao cliente;
- a venda só é criada se o resumo atual foi enviado **e** o cliente respondeu depois dele;
- um "sim" repetido ou simultâneo não cria venda duplicada (trava no banco);
- falha sem resposta clara da RevGás (timeout, rede, 5xx) **não** é repetida: o pedido fica "incerto" e a
  conversa vai para um atendente conferir no ERP.

## Pré-requisitos

- Node.js 22 ou 24
- pnpm 10
- Docker Desktop (para o PostgreSQL)
- Chave da RevGás e chave da API da Anthropic

## Como rodar

```bash
cp .env.example .env          # preencha REVGAS_API_KEY e ANTHROPIC_API_KEY
docker compose up -d          # PostgreSQL 17 na porta 5433
pnpm install
pnpm --filter server db:migrate
pnpm dev                      # servidor em :3333 e chat em http://localhost:5173
```

O banco usa a porta **5433** (e não 5432) para não conflitar com um PostgreSQL instalado no Windows.
O `.env` nunca vai para o git; não coloque as chaves em nenhum outro arquivo.

## Testes

```bash
pnpm -r test                  # testes do servidor (usam o banco revgas_bot_test)
pnpm -r exec tsc --noEmit     # checagem de tipos de todos os pacotes
```

Os testes não chamam a IA nem a RevGás: usam um cliente RevGás em memória e respostas roteirizadas da IA.
Para conferir a leitura real da RevGás (só leitura): `pnpm --filter server exec tsx scripts/smoke-read.ts 86999998888`.

## `REVGAS_WRITE_ENABLED` — por que está `false`

Com `REVGAS_WRITE_ENABLED=false` (padrão), as leituras (produtos, vendas) vão para a RevGás de verdade,
mas **nenhuma venda é enviada**: a venda é simulada em memória, recebe um número a partir de
`900000001` e o servidor registra `[revgas] escrita desligada: venda simulada`. A página mostra a faixa
"Modo de teste — vendas NÃO são enviadas à RevGás".

O token do projeto aponta para o estabelecimento 2580 ("RevGás - Técnico"). Até a RevGás confirmar que
criar e cancelar vendas ali é seguro, esse valor fica `false`. Mudá-lo para `true` cria vendas reais.
Mesmo ligado, `REVGAS_BROADCAST` fica `NONE` para não notificar entregadores.

## Roteiro de demonstração

Abra http://localhost:5173. À esquerda está o celular do cliente (número padrão 86999998888); à direita, o
painel de atendimento.

1. **Pedido completo.** Como cliente, envie "quero um botijão, pago no pix" e informe o endereço quando o
   bot pedir. O bot responde e, em seguida, chega o resumo oficial:
   ```
   Resumo do pedido:
   • 1x GLP 13KG ENVASADO NO BOTIJÃO — R$ 110,00
   Total: R$ 110,00
   Pagamento: Pix
   Entrega: Rua das Flores, 120 – Centro, Teresina/PI
   Posso registrar o pedido? Responda *sim* para confirmar ou me diga o que mudar.
   ```
2. **Confirmação.** Responda "sim". O bot informa "Pedido nº 900000001 registrado" (venda simulada).
3. **Passagem para humano.** Envie "quero falar com uma pessoa". A conversa aparece à direita com o selo
   **Humano** e o motivo; o bot para de responder nessa conversa.
4. **Atendente.** Abra a conversa à direita, responda como atendente e clique em **Devolver ao bot**.

Também vale mostrar: mudar o pedido depois do resumo ("na verdade são 2") gera um resumo novo, e o
"sim" anterior não vale para ele.

## Perguntas em aberto para a RevGás

1. De onde vem o preço de cada produto (tabela, acordo por cliente, produto personalizado)? Hoje os preços
   são de demonstração, em `apps/server/config/prices.json`.
2. Podemos criar e cancelar vendas à vontade no estabelecimento "RevGás - Técnico" (id 2580)? Qual
   estabelecimento o bot deve usar?
3. `broadcast: NEW_SALE` notifica entregadores reais nessa conta?
4. Venda sem `customer_id` é aceita?
5. O token atual recebe **403** em `GET /customers` (busca por telefone). Sem essa permissão o bot não
   reconhece clientes cadastrados e sempre pede o endereço. É possível liberar a leitura de clientes?
