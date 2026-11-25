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
  cliente diz como vai pagar. Forma de pagamento sem acordo para o produto não pode ser usada.
  Formas aceitas: Pix, dinheiro, cartão de crédito e cartão de débito (vale gás fica de fora até a
  RevGás dizer como enviar o código do cupom);
- para gás, o bot pergunta **quantos botijões vazios** o cliente tem para trocar. Para cada botijão de
  gás sem vazio, o vasilhame (`container_id` do produto) entra no pedido com o preço dele. Exemplo:
  2× GLP 13KG com 1 vazio → 1 vasilhame;
- o resumo do pedido é gerado pelo sistema e enviado ao cliente;
- a venda só é criada se o resumo atual foi enviado **e** o cliente respondeu depois dele;
- um "sim" repetido ou simultâneo não cria venda duplicada (trava no banco);
- falha sem resposta clara da RevGás (timeout, rede, 5xx) **não** é repetida: o pedido fica "incerto" e a
  conversa vai para um atendente conferir no ERP. Se o servidor cair no meio de uma venda, na próxima
  subida o pedido vira "incerto" e a conversa vai para um atendente.

Os acordos são lidos na subida do servidor e ficam em cache por 30 minutos. São cerca de 12 páginas, e o
limite de 1 requisição por segundo faz a primeira carga levar uns 12 segundos. Depois disso, a recarga
acontece em segundo plano: o cliente continua vendo os preços anteriores até ela terminar, e se ela
falhar os preços anteriores continuam valendo.

### Atendimento humano

Quando a conversa passa para um atendente, o bot para de responder e o resumo que estava na tela deixa de
valer (um "sim" mandado ao atendente não confirma o pedido). Ao clicar em **Devolver ao bot**, a IA
recebe um resumo do que o cliente e o atendente conversaram nesse período. Se a IA ficar sem resposta,
o bot pede para o cliente repetir; na segunda vez seguida, chama um atendente.

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

Para conferir a configuração que depende da RevGás e se o token alcança cada rota (só `GET`):
`pnpm --filter server preflight`.

## Variáveis que mudam o comportamento

| Variável | Padrão | O que faz |
|---|---|---|
| `REVGAS_WRITE_ENABLED` | `false` | Com `false`, nenhuma venda é enviada à RevGás (veja abaixo). |
| `REVGAS_CUSTOMERS_ENABLED` | `false` | Com `true`, `buscar_cliente` também consulta `GET /customers?phone=` depois do perfil local e preenche o `customer_id` da venda quando acha exatamente um cliente. Um 403 é tratado como "cliente não identificado" e nunca derruba a conversa. Deixe `false` até a RevGás liberar a leitura de clientes para o token. |
| `REVGAS_BROADCAST` | `NONE` | `NEW_SALE` pode notificar entregadores reais. Só mude com autorização da RevGás. |
| `REVGAS_ESTABLISHMENT_ID` | `2580` | Estabelecimento das vendas, dos produtos e dos acordos de preço. |
| `REVGAS_VALEGAS_ENABLED` | `false` | Com `true`, o bot aceita Vale Gás: pede o código do cupom, envia em `payments[].serial` e mostra no resumo só o final ("Vale Gás (cupom final 1234)"). O produto precisa ter acordo para Vale Gás. |
| `REVGAS_PRICE_PRIORITY` | `false` | Com `true` e o cliente identificado na RevGás (exige `REVGAS_CUSTOMERS_ENABLED=true`), o preço vem do acordo do cliente, senão do acordo da categoria dele (`tag_id`), senão do acordo geral. O rascunho guarda de qual acordo veio cada preço. |
| `DEFAULT_CITY` / `DEFAULT_STATE` | `Teresina` / `PI` | Cidade e UF de entrega usadas quando o cliente não diz outra. O bot não pergunta cidade nem estado; o resumo mostra a cidade e o cliente pode corrigir. |
| `REVGAS_PRODUCT_IDS` | vazio | Lista de ids separados por vírgula. Preenchida, o bot só oferece esses produtos e os vasilhames ligados a eles (o 2580 tem vários "GLP 13KG TESTE" que confundem a IA). Exemplo no `.env.example`: `23740,23974,24141` (GLP 13kg, GLP 45kg e água 10L). |

### `REVGAS_WRITE_ENABLED` — por que está `false`

Com `REVGAS_WRITE_ENABLED=false`, as leituras (produtos, acordos, vendas) vão para a RevGás de verdade,
mas **nenhuma venda é enviada**: a venda é simulada e guardada na tabela `simulated_sales` do nosso banco, recebe um número a partir de
`900000001` (que nunca se repete, mesmo depois de reiniciar) e o servidor registra
`[revgas] escrita desligada: venda simulada`. "Cadê meu gás?" continua funcionando depois de reiniciar. A página mostra a faixa
"Modo de teste — vendas NÃO são enviadas à RevGás".

O token do projeto aponta para o estabelecimento 2580 ("RevGás - Técnico"). Até a RevGás confirmar que
criar e cancelar vendas ali é seguro, esse valor fica `false`. Mudá-lo para `true` cria vendas reais.

## Roteiro de demonstração

Abra http://localhost:5173. À esquerda está o celular do cliente (número padrão 86999998888); à direita, o
painel de atendimento.

1. **Pedido completo (cliente novo).** Como cliente, envie "quero um botijão, pago no pix". O bot pergunta
   nome, endereço e quantos botijões vazios você tem para trocar. Responda que **não tem** para ver o vasilhame no
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
6. **Bastidores.** Com a conversa aberta, clique em **Ver bastidores**: entre as mensagens aparecem as
   ferramentas que a IA chamou e o resultado resumido de cada uma ("3 produtos", "resumo gerado: R$ 160,00",
   "venda 900000004 criada"). O raciocínio da IA e os dados brutos nunca aparecem.
7. **Métricas.** Na aba **Métricas**: conversas atendidas, resolvidas só pelo bot e taxa de automação,
   vendas e ticket médio (com o selo **simulado** enquanto a escrita está desligada), passagens para humano
   por motivo, tempo médio de resposta do bot e do "oi" ao pedido registrado. O painel atualiza sozinho;
   o dia segue o fuso de Fortaleza.

**Antes de apresentar**, limpe os testes do banco de desenvolvimento com `pnpm --filter server demo:reset`.
Ele pede para digitar `APAGAR`, recusa rodar com `REVGAS_WRITE_ENABLED=true` ou apontando para o banco de
teste, e não chama a RevGás. Os números das vendas simuladas continuam crescendo (nunca se repetem).

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
8. Como enviar o pagamento em **Vale Gás** em `POST /sales`? O código do cupom vai em `payments[].serial`
   ou em outro campo? Até sabermos, o Vale Gás fica desligado (`REVGAS_VALEGAS_ENABLED=false`).

## Checklist para produção

Antes e depois de mudar qualquer variável abaixo, rode `pnpm --filter server preflight`. Ele mostra o valor
de cada opção, avisa das combinações arriscadas e testa (só leitura) as rotas que o bot usa.

| Pergunta | Resposta que libera | O que muda | Variável |
|---|---|---|---|
| 1. Leitura de clientes | "Sim, o token pode ler `/customers`" | O bot identifica o cliente na RevGás, preenche o `customer_id` da venda e lê a categoria dele. O preflight deve mostrar `GET /customers 200`. | `REVGAS_CUSTOMERS_ENABLED=true` |
| 2. Servidor de homologação | "Sim, podem usar a homologação para testar vendas" | Testes de venda real sem tocar na produção. | `REVGAS_BASE_URL=https://apihomologacao.revgas.com/v1` e, só nele, `REVGAS_WRITE_ENABLED=true` |
| 3. Vendas de teste no 2580 | "Sim, podem criar e cancelar vendas no 2580" | O bot cria vendas reais no ERP (fim da venda simulada). | `REVGAS_WRITE_ENABLED=true` (com `REVGAS_BROADCAST=NONE` até a pergunta 6) |
| 4. Prioridade de preço | "Sim, `CUSTOMER` > `TAG` > `PAYMENT_TYPE`, cobrando o `suggested_value`" | Clientes com acordo próprio ou de categoria pagam o preço deles. Só funciona com a pergunta 1 liberada. | `REVGAS_PRICE_PRIORITY=true` |
| 5. Campos obrigatórios de `POST /sales` | A lista de campos | Ajuste no `buildDraft`/`toSalePayload` se faltar algum (hoje o endereço completo é exigido). | nenhuma (mudança de código) |
| 6. `broadcast: NEW_SALE` | "Notifica, e podem usar" | As vendas do bot avisam o entregador pelo aplicativo. | `REVGAS_BROADCAST=NEW_SALE` (só com escrita ligada) |
| 7. Outra integração no 2580 | Quem é e se há conflito | Nada no código; evita confundir as vendas de teste delas com as nossas. | nenhuma |
| 8. Vale Gás | "O código do cupom vai em `payments[].serial`" (ou outro campo) | O bot aceita Vale Gás e pede o código. Se o campo for outro, muda o `toSalePayload`. | `REVGAS_VALEGAS_ENABLED=true` |

Também: escolha os produtos que o bot oferece em `REVGAS_PRODUCT_IDS` (o preflight avisa quando está vazio).
