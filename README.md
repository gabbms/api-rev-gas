# Atendimento IA RevGás

Bot de atendimento com IA para revendas de gás (GLP), integrado ao ERP RevGás. Um cliente conversa em
linguagem natural ("manda um botijão, pago no pix"), a IA monta o pedido, o sistema envia um resumo com
preço e total, e depois de um "sim" a venda é registrada na RevGás com canal WhatsApp.

Projeto acadêmico da iCEV (Escola de Tecnologia Aplicada) em parceria com a RevGás. Nesta primeira
versão o WhatsApp é **simulado** por uma página web; o WhatsApp real entra depois, atrás da mesma
interface de canal.

- Design: [docs/superpowers/specs/2026-11-20-atendimento-ia-revgas-design.md](docs/superpowers/specs/2026-11-20-atendimento-ia-revgas-design.md)
- Plano de implementação: [docs/superpowers/plans/2026-11-20-atendimento-ia-revgas-v1.md](docs/superpowers/plans/2026-11-20-atendimento-ia-revgas-v1.md)
- Levantamento da API RevGás (rotas, permissões do token, correções C1–C8): [docs/revgas-api.md](docs/revgas-api.md)
- Especificação OpenAPI oficial, fonte de verdade para campos e enums: [docs/revgas-openapi.yaml](docs/revgas-openapi.yaml)

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

- **o preço vem dos acordos da RevGás** (`GET /deals`, acordos gerais por forma de pagamento), nunca do
  texto da IA. O preço depende da forma de pagamento, então o pedido só é precificado depois que o
  cliente diz como vai pagar. Forma de pagamento sem acordo para o produto não pode ser usada;
- para gás, o bot pergunta se o cliente tem **botijão vazio para trocar**. Se não tiver, o vasilhame
  (`container_id` do produto) entra no pedido com o preço dele;
- o resumo do pedido é gerado pelo sistema e enviado ao cliente;
- a venda só é criada se o resumo atual foi enviado **e** o cliente respondeu depois dele;
- um "sim" repetido ou simultâneo não cria venda duplicada (trava no banco);
- falha sem resposta clara da RevGás (timeout, rede, 5xx) **não** é repetida: o pedido fica "incerto" e a
  conversa vai para um atendente conferir no ERP.

Os acordos são lidos uma vez na subida do servidor e ficam em cache por 30 minutos. São cerca de 12
páginas, e o limite de 1 requisição por segundo faz a primeira carga levar uns 12 segundos.

### Clientes: endereço guardado no nosso banco

O token atual recebe **403** em `GET /customers`, então o bot não consegue identificar o cliente na
RevGás. A v1 cria vendas **sem `customer_id`** e guarda o cliente localmente, na tabela
`customer_profiles` (telefone, nome e endereço da última entrega). Na próxima conversa do mesmo número o
bot oferece "Entregar no mesmo endereço de antes?". O perfil só é gravado depois de uma venda criada;
venda recusada ou incerta não altera nada.

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
pnpm test                     # testes do servidor (usam o banco revgas_bot_test)
pnpm -r exec tsc --noEmit     # checagem de tipos de todos os pacotes
```

Os testes não chamam a IA nem a RevGás: usam um cliente RevGás em memória e respostas roteirizadas da IA.
Para conferir a leitura real da RevGás (só leitura: produtos, acordos e a busca de cliente):
`pnpm --filter server exec tsx scripts/smoke-read.ts 86999998888`.

## Variáveis que mudam o comportamento

| Variável | Padrão | O que faz |
|---|---|---|
| `REVGAS_WRITE_ENABLED` | `false` | Com `false`, nenhuma venda é enviada à RevGás (veja abaixo). |
| `REVGAS_CUSTOMERS_ENABLED` | `false` | Com `true`, `buscar_cliente` também consulta `GET /customers?phone=` depois do perfil local e preenche o `customer_id` da venda quando acha exatamente um cliente. Um 403 é tratado como "cliente não identificado" e nunca derruba a conversa. Deixe `false` até a RevGás liberar a leitura de clientes para o token. |
| `REVGAS_BROADCAST` | `NONE` | `NEW_SALE` pode notificar entregadores reais. Só mude com autorização da RevGás. |
| `REVGAS_ESTABLISHMENT_ID` | `2580` | Estabelecimento das vendas, dos produtos e dos acordos de preço. |

### `REVGAS_WRITE_ENABLED` — por que está `false`

Com `REVGAS_WRITE_ENABLED=false`, as leituras (produtos, acordos, vendas) vão para a RevGás de verdade,
mas **nenhuma venda é enviada**: a venda é simulada em memória, recebe um número a partir de
`900000001` e o servidor registra `[revgas] escrita desligada: venda simulada`. A página mostra a faixa
"Modo de teste — vendas NÃO são enviadas à RevGás".

O token do projeto aponta para o estabelecimento 2580 ("RevGás - Técnico"). Até a RevGás confirmar que
criar e cancelar vendas ali é seguro, esse valor fica `false`. Mudá-lo para `true` cria vendas reais.

## Roteiro de demonstração

Abra http://localhost:5173. À esquerda está o celular do cliente (número padrão 86999998888); à direita, o
painel de atendimento.

1. **Pedido completo (cliente novo).** Como cliente, envie "quero um botijão, pago no pix". O bot pergunta
   nome, endereço e se você tem botijão vazio para trocar. Responda que **não tem** para ver o vasilhame no
   resumo oficial (preços reais dos acordos do 2580):
   ```
   Resumo do pedido:
   • 1x GLP 13KG ENVASADO NO BOTIJÃO — R$ 150,00
   • 1x VASILHAME 13KG ENVASADO NO BOTIJÃO — R$ 10,00
   Total: R$ 160,00
   Pagamento: Pix
   Entrega: Rua das Flores, 120 – Centro, Teresina/PI
   Posso registrar o pedido? Responda *sim* para confirmar ou me diga o que mudar.
   ```
2. **Confirmação.** Responda "sim". O bot informa "Pedido nº 900000001 registrado" (venda simulada).
3. **Cliente conhecido.** Escreva de novo do mesmo número ("quero outro botijão"). O bot cumprimenta pelo
   nome e pergunta se entrega no mesmo endereço de antes.
4. **Passagem para humano.** Envie "quero falar com uma pessoa". A conversa aparece à direita com o selo
   **Humano** e o motivo; o bot para de responder nessa conversa.
5. **Atendente.** Abra a conversa à direita, responda como atendente e clique em **Devolver ao bot**.

Também vale mostrar: mudar o pedido depois do resumo ("na verdade são 2") gera um resumo novo, e o
"sim" anterior não vale para ele.

## Perguntas em aberto para a RevGás

1. Podemos ter permissão de leitura em **Clientes** (`/customers`) para este token? (e `/calls`,
   `/deliverers`, `/motive-cancel-sale`)
2. Podemos usar o servidor de **homologação** (`apihomologacao.revgas.com`) para testar a criação de vendas?
3. Se não, podemos criar e cancelar vendas de teste no estabelecimento 2580?
4. A prioridade de preço é `CUSTOMER` > `TAG` > `PAYMENT_TYPE`? O `suggested_value` é o preço que deve
   ser cobrado?
5. Quais campos de `POST /sales` são obrigatórios?
6. `broadcast: NEW_SALE` notifica entregadores reais nessa conta?
7. Vemos vendas `WHATSAPP` recentes no 2580 (12 neste mês, várias canceladas). Há outra integração
   testando nesse estabelecimento?
