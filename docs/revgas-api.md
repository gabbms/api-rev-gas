# API RevGás — referência para o projeto

Levantamento feito em 2026-11-20 a partir da especificação OpenAPI oficial e de chamadas reais
**somente leitura** com o token do projeto. Nenhuma escrita foi feita.

- Especificação completa (OpenAPI 3.1, 384 rotas): [`docs/revgas-openapi.yaml`](revgas-openapi.yaml)
  — exportada de `https://api.stoplight.io/projects/cHJqOjI2MzY1Nw/branches/main/export/reference/api.yaml`.
  Use-a como fonte de verdade para nomes de campos e enums.
- Documentação navegável: https://revgas.stoplight.io/docs/revgas-api

## 1. Servidores e autenticação

| Servidor | URL | Observação |
|---|---|---|
| Produção | `https://api.revgas.com/v1` | O que o projeto usa |
| Homologação | `https://apihomologacao.revgas.com/v1` | A própria spec diz **"Não utilizar"**. Perguntar à RevGás se podemos usar para testar vendas |

- Header `Authorization: <API_KEY>` (sem `Bearer`). Esquema `RevgasApiKey`.
- Limite global **1 requisição/segundo** (HTTP 429 acima disso).
- Listagens com `from`/`to`: intervalo máximo 366 dias; sem filtro = mês atual.
- Paginação: query `page`, `page_size`; resposta `{ pagination: { page, page_size, count, total_count, has_next }, data: [...] }`.
- Erros padrão: 400/422 inválido · 401 sem chave · 402 assinatura bloqueada · **403 `User doesn't have access to this resource`** · 409 lock ou duplicado · 429 limite · 500.

## 2. O que o nosso token consegue acessar (testado)

| Rota | Resultado |
|---|---|
| `GET /establishments`, `GET /establishments/{id}` | ✅ 200 |
| `GET /products`, `GET /products/{id}` | ✅ 200 |
| `GET /deals` (acordos = **preços**) | ✅ 200 |
| `GET /sales`, `GET /sales/{id}` | ✅ 200 |
| `GET /locations-search` | ✅ 200 (precisa do parâmetro `description`) |
| `POST /sales` | ⚠️ não testado (proibido até a RevGás liberar) |
| `GET /customers`, `GET /customers/{id}`, `GET /customers?phone=` | ❌ **403** |
| `GET /calls` (BINA), `GET /deliverers`, `GET /payment-types` | ❌ 403 |
| `GET /neighborhoods`, `/cities`, `/locations`, `/state-federations` | ❌ 403 |
| `GET /motive-cancel-sale`, `/tags`, `/lendings`, `/vale-gas`, `/stock-movements`, `/system-users` | ❌ 403 |

**Consequência principal: não conseguimos identificar o cliente pelo telefone com este token.**
Ver Correção C1.

## 3. Rotas usadas pelo projeto

### 3.1 `POST /sales` — criar venda

A spec **não marca nenhum campo como obrigatório** (nem no corpo, nem nos itens). Quais campos são
realmente exigidos só se descobre com uma chamada real ou com a RevGás.

| Campo | Tipo | Notas |
|---|---|---|
| `location`, `number`, `neighborhood`, `city`, `state_federation` | string | Endereço de entrega |
| `complement`, `landmark`, `observation` | string | Opcionais na prática |
| `lat`, `lon` | string | Ex.: `"-5.0892"` |
| `customer_id` | int64 | Opcional (resposta aceita `null`) |
| `deliverer_id` | int64 | Não enviamos |
| `establishment_id` | int64 | `2580` |
| `products[]` | `{ product_id, quantity, value }` | **`value` é o preço UNITÁRIO** (confirmado em vendas reais: `q=2, value=125, total=250`) |
| `payments[]` | `{ payment_type, value, date?, serial?, card_brand?, creditor_establishment_id? }` | `date` = vencimento (boleto/prazo) |
| `channel` | `DISK` \| `SINO` \| `WHATSAPP` | Usamos `WHATSAPP` |
| `origin` | `ENTREGA` \| `REVGAS` \| `INTEGRATION` | Usamos `INTEGRATION` |
| `option` | `INDOOR` \| `OUTDOOR` \| `NORMAL` | `INDOOR`/`OUTDOOR` confirmam a venda automaticamente. Usamos `NORMAL` |
| `broadcast` | `OLD_SALE` \| `NEW_SALE` \| `NONE` | Usamos `NONE` até a RevGás liberar |

`payment_type` aceitos: `MONEY, WALLET, BANKDRAFT, FETLOCK (boleto), VISA, MASTER, HIPER, CREDISHOP,
VALEGAS, ELO, CARTAO_DE_CREDITO, CARTAO_OUTRO, CREDITO_CLIENTE, CARTAO_DE_DEBITO, CARTAO_REVGAS, PIX,
TRANSFERENCIA_BANCARIA`.

Resposta 201 (schema `Sale`): `id, total, status, channel, products[{id, quantity, value, discount,
product_id, product_description}], payments[{id, value, type}], logs[], establishment_id,
customer_id, customer_name, deliverer_id, deliverer_name, delivered_at, competence`.
Em vendas reais a API devolve campos extras não documentados (`date`, `paid`, `short_address`,
`display_address`, `display_customer`, `opened_user_name`, `canceled_at`, `new_sale`, e nos itens
`comission_value`, `normalized_quantity`, `revgas_product_id`). Os schemas Zod devem tolerar extras.

### 3.2 Ciclo de vida da venda

Observado em vendas reais: `OPEN → ACTIVE → (RECEIVED) → WARNING → CONFIRM → (CHECK)`, ou `→ CANCEL`.

| Status da venda | Significado | Mensagem sugerida ao cliente |
|---|---|---|
| `OPEN` | Aberta (criada) | Pedido recebido |
| `ACTIVE` | Ativa (na fila da revenda) | Pedido em preparação |
| `WARNING` | Avisada (entregador a caminho) | Saiu para entrega |
| `CONFIRM` | Confirmada (entregue) | Entregue |
| `CHECK` | Conferida | Entregue |
| `CANCEL` | Cancelada | Cancelado |

Os logs (`logs[].status`) também têm `RECEIVED` (entregador recebeu), `IGNORED` (entregador
recusou) e `CANCEL_DELIVERY` (entregador cancelou a entrega).

⚠️ Inconsistência na spec: o filtro `GET /sales?status=` usa `WARN`, mas as respostas usam `WARNING`.

**Não há webhook de vendas** (os webhooks da spec são só fiscais: NF, CT-e, MDF-e). Para avisar o
cliente sobre a entrega, é preciso consultar `GET /sales/{id}` periodicamente (respeitando 1 req/s).

### 3.3 Outras rotas de venda (não usadas na v1)

| Rota | Corpo | Uso |
|---|---|---|
| `GET /sales` | filtros: `from`, `to`, `establishment_id`, `status`, `channel`, `customer_id`, `deliverer_id`, `name`, endereço… | Ordenada por criação (desc) |
| `GET /sales/{id}` | — | Status do pedido (usada no `consultar_pedido`) |
| `PUT /sales/{id}` | mesmos campos do POST (sem channel/origin/option/broadcast) | Alterar venda |
| `PUT /sales/{id}/warning` | `{ lat, lon }` | Marcar como avisada |
| `PUT /sales/{id}/confirm` | `{ lat, lon }` | Confirmar entrega |
| `PUT /sales/{id}/cancel` | `{ motive_cancel_sale_id }` | Cancelar (motivos em `/motive-cancel-sale`, sem acesso) |
| `PUT /sales/{id}/ignore` | — | Entregador recusa |
| `PUT /sales/{id}/cancelDelivery` | `{ lat, lon }` | Entregador cancela a entrega |

### 3.4 Produtos — `GET /products`, `GET /products/{id}`

Filtros: `establishment_id`, `inactive`, `description`, `page`, `page_size`.
Campos: `id, description, stock_quantity, lent_quantity, transit_quantity, inactive,
revgas_product_id, customized_product_id, container_id, content_ids, variation_options[],
establishment_id`.

- **Não há preço no produto.** O preço vem dos acordos (3.5).
- **Vasilhame:** o gás (ex.: `23740` GLP 13KG) aponta para o vasilhame em `container_id` (`23741`
  VASILHAME 13KG), e o vasilhame aponta de volta em `content_ids`. Numa troca, o cliente entrega o
  botijão vazio e compra só o gás. Se ele **não tem botijão para trocar**, precisa comprar também o
  vasilhame. O bot deve perguntar isso.
- Produtos ativos no 2580 incluem: GLP 13KG (`23740`), VASILHAME 13KG (`23741`), GLP 45KG MA
  (`23974`), VASILHAME 45KG MA (`23975`), AGUA 10L (`24141`), AGUA 1,25L (`24142`), entre outros.

### 3.5 Preços — `GET /deals` (Acordos)

Filtros: `establishment_id`, `product_id`, `customer_id`, `customer_isnull`, `tag_id`,
`tag_isnull`, `payment_type`, `payment_type_establishment_id`, `page`, `page_size`.

| Campo | Significado |
|---|---|
| `product_id`, `product_description` | Produto |
| `payment_type` | **O preço depende da forma de pagamento** |
| `suggested_value` | Preço a cobrar (string decimal, ex.: `"150.00"`) |
| `minimum_value` | Menor preço permitido |
| `type` | `PAYMENT_TYPE` (geral), `TAG` (categoria de cliente), `CUSTOMER` (cliente específico) |
| `is_default` | Acordo padrão |
| `tag_id`, `customer_id` | Preenchidos nos acordos de categoria/cliente |
| `term`, `preferential_term` | Prazos para contas a receber (venda a prazo) |

Dados reais (2580, acordos `PAYMENT_TYPE`), 1.215 acordos no total:

| Produto | MONEY / PIX / cartões | Mínimo |
|---|---|---|
| GLP 13KG (`23740`) | R$ 150,00 | R$ 80,00 (R$ 90,00 no Cartão RevGás) |
| VASILHAME 13KG (`23741`) | R$ 10,00 (FETLOCK: R$ 285,00) | R$ 0,01 |
| GLP 45KG MA (`23974`) | R$ 100,00 | R$ 100,00 |
| AGUA 10L (`24141`) | R$ 15,00 | R$ 5,00 |

Nem toda forma de pagamento tem acordo para todo produto (ex.: GLP 13KG não tem `VALEGAS` nem
`FETLOCK` na primeira página). **Sem acordo para o par produto + pagamento = não vender por esse meio.**

Regra de prioridade (suposição, **confirmar com a RevGás**): `CUSTOMER` > `TAG` > `PAYMENT_TYPE`.
Sem acesso a clientes, a v1 só consegue usar `PAYMENT_TYPE`.

### 3.6 Estabelecimento — `GET /establishments/{id}`

2580 "RevGás - Técnico", Teresina/PI. Campos úteis: `accept_order`, `allow_cancel_sale`,
`allow_vale_gas`, `allow_credit`, `roles` (inclui `GESTOR`).

### 3.7 Endereço — `GET /locations-search`

Parâmetros: `description` (texto do logradouro), `city`, `state_federation`. Pode servir para
validar ou normalizar a rua digitada pelo cliente. Formato da resposta não verificado.

### 3.8 Clientes (sem acesso hoje)

`GET /customers` aceita `phone` (padrão `^(\+?55)?\d{10,11}$`), `cpf_or_cnpj`, `name`, endereço,
`last_sale_*`, `tag_id`. `POST /customers` aceita `name, phones[], location, number, neighborhood,
complement, landmark, city, state_federation, postal_code, latitude, longitude, type, tag_id…`.
Tudo isso retorna **403** com o token atual.

Alternativa vista na spec: `GET /calls` (BINA) devolve `customers_ids` para um número de telefone,
mas também retorna 403.

## 4. Inventário completo (76 grupos, 384 rotas)

Relevantes para o atendimento: **Vendas (9)**, **Produtos (8)**, **Gestor - Acordos (5)**,
Gestor - Clientes (9), Gestor - Chamadas (4), Gestor - Entregadores (6), Gestor - Motivo de
cancelamento de venda (5), Endereço - Logradouros (6) / Bairros (2) / Cidades (2), Estados (2),
Administrativo - Estabelecimentos (6), Formas de pagamento (1), Vale Gás (5), Gestor - Comodato (5),
Tags (5), Estoque (2).

Fora do escopo: Fiscal (NF-e, NFC-e, CT-e, MDF-e, EFD, CFOPs, certificados… ~170 rotas), Financeiro
(contas, contas a receber, pagamentos, recebimentos, boletos, transferências, renegociação…),
RevBank, Power BI, OAuth, Segurança/Colaboradores/Usuários, Compras, Fornecedores, Comissões,
Distribuidoras, Terminais, Veículos, Transferência de estoque, FCM.

Lista completa com métodos e caminhos: abrir `docs/revgas-openapi.yaml` (seção `paths`).

## 5. Correções ao plano

Para quem está executando `docs/superpowers/plans/2026-11-20-atendimento-ia-revgas-v1.md`.
Todas as correções (C1–C8) estão decididas e podem ser implementadas.

- **C1 — `/customers` dá 403. DECIDIDO pelo usuário (2026-11-20): endereço no nosso banco.**
  `buscar_cliente` não consegue usar a RevGás com este token. A v1 cria vendas **sem `customer_id`**
  e guarda o cliente localmente:
  - Nova tabela `customer_profiles`: `phone text pk` (normalizado), `name text null`,
    `location`, `number`, `neighborhood`, `city`, `state`, `complement`, `landmark` (null até a
    primeira venda), `hasEmptyCylinder boolean null`, `revgasCustomerId bigint null`,
    `lastSaleId bigint null`, `createdAt`, `updatedAt`.
  - `buscar_cliente` passa a consultar primeiro `customer_profiles` pelo telefone da conversa. Se o
    cliente tiver endereço salvo, devolve nome e endereço para o bot oferecer *"Entregar no mesmo
    endereço de antes (Rua X, 120 – Centro)?"*. Se não tiver, devolve "cliente novo" e o bot pergunta
    nome e endereço.
  - Depois que `OrderService.confirm` retorna `created`, o perfil é gravado/atualizado com o nome e
    o endereço da venda e com `lastSaleId`. Venda que falhou não altera o perfil.
  - A busca na RevGás (`findCustomersByPhone`) fica no código, atrás de uma opção
    `REVGAS_CUSTOMERS_ENABLED` (padrão `false`). Com `true`, ela roda depois da busca local e
    preenche `revgasCustomerId`. Se der 403, é tratada como "cliente não identificado" e nunca
    derruba a conversa.
  - Testes: telefone sem perfil vira cliente novo; perfil com endereço é oferecido; venda `created`
    grava o perfil; venda `rejected`/`uncertain` não grava; com `REVGAS_CUSTOMERS_ENABLED=false`
    o `fetch` de `/customers` nunca é chamado.
- **C2 — Preço vem de `/deals`, não de `prices.json`.** O `Catalog` deve ler os acordos
  `PAYMENT_TYPE` do estabelecimento (paginando, com cache) e indexar por `(product_id, payment_type)`
  usando `suggested_value`. Como o preço depende do pagamento, o `buildDraft` calcula o preço só
  depois de saber a forma de pagamento, e `listar_produtos` mostra o preço de referência (Pix/dinheiro)
  avisando que pode variar. Par sem acordo = forma de pagamento indisponível para aquele produto.
  O `prices.json` pode ficar só como fallback configurável, ou ser removido.
- **C3 — Vasilhame.** Antes de montar o pedido de gás, perguntar se o cliente tem botijão vazio
  para trocar. Se não tiver, adicionar o produto de `container_id` com o preço dele. O resumo
  mostra as duas linhas.
- **C4 — `products[].value` é preço unitário.** Confirmar que o `toSalePayload` envia o valor
  unitário, e não o total da linha.
- **C5 — Status.** Os schemas Zod de status devem aceitar `WARN` e `WARNING` e tolerar valores
  desconhecidos (não quebrar com `RECEIVED`). Usar a tabela da seção 3.2 no `consultar_pedido`.
- **C6 — 403 genérico.** Mapear 403 para `kind: "auth"` com a mensagem
  `"Token sem acesso a <rota>"`, sem derrubar o servidor.
- **C7 — `/payment-types` dá 403.** Manter a lista fixa de formas de pagamento no código e
  cruzá-la com as que têm acordo.
- **C8 — Campos obrigatórios desconhecidos.** A spec não declara obrigatórios em `POST /sales`.
  O `buildDraft` continua exigindo o endereço completo. Validar de verdade só quando a RevGás
  liberar a escrita (ou o servidor de homologação).

## 6. Perguntas atualizadas para a RevGás

1. Podemos ter permissão de leitura em **Clientes** (`/customers`) para este token? (e `/calls`, `/deliverers`, `/motive-cancel-sale`)
2. Podemos usar o servidor de **homologação** (`apihomologacao.revgas.com`) para testar a criação de vendas?
3. Se não, podemos criar e cancelar vendas de teste no estabelecimento 2580?
4. A prioridade de preço é `CUSTOMER` > `TAG` > `PAYMENT_TYPE`? O `suggested_value` é o preço que deve ser cobrado?
5. Quais campos de `POST /sales` são obrigatórios?
6. `broadcast: NEW_SALE` notifica entregadores reais nessa conta?
7. Vemos vendas `WHATSAPP` recentes no 2580 (12 neste mês, várias canceladas). Há outra integração testando nesse estabelecimento?
