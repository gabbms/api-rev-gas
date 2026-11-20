# Atendimento com IA para revendas de GLP (RevGás) — Design

Data: 2026-11-20 · Status: aprovado para implementação (2026-11-20)

## 1. Intenção e porquê

Projeto da Escola de Tecnologia Aplicada (iCEV) em parceria com a RevGás. O desafio da empresa é
automatizar o atendimento aos clientes das revendas de GLP com IA integrada ao ERP RevGás e ao
WhatsApp, reduzindo o atendimento manual, agilizando o registro de pedidos e mantendo a
possibilidade de passar para um humano.

A RevGás pediu foco em **criar venda**. Esta primeira versão faz exatamente isso: um cliente conversa
em linguagem natural, a IA entende o pedido, confirma com o cliente e registra a venda no ERP.

Começamos com um **chat simulado** (página web). O WhatsApp vem depois, trocando só a "porta de
entrada"; o resto do sistema não muda.

Critério de sucesso da v1: numa demonstração, alguém conversa pelo chat simulado como cliente, e a
venda aparece no ERP RevGás com canal WhatsApp, produto, endereço, pagamento e valor corretos.

## 2. Objetivos, não-objetivos e anti-objetivos

### Objetivos (v1)
- Chat simulado web: escolher um telefone ("de qual número a mensagem veio") e conversar.
- Identificar o cliente pelo telefone na RevGás e reaproveitar nome e endereço cadastrados.
- Entender pedidos em texto livre ("manda um P13, pago no pix"): produto, quantidade, endereço,
  forma de pagamento, troco/observação.
- Perguntar o que faltar, mostrar um resumo com preço e pedir confirmação.
- Criar a venda na RevGás (`POST /v1/sales`) só após confirmação explícita.
- Consultar o status de uma venda feita pela conversa ("cadê meu gás?").
- Passar para atendimento humano: a conversa é marcada como "aguardando humano" e o bot para de
  responder nela. Na v1, a conversa marcada aparece numa lista simples na própria página do chat
  simulado, onde uma pessoa pode responder manualmente e devolver a conversa ao bot.
- Histórico de conversas e pedidos guardado no nosso banco.

### Não-objetivos (ficam para depois)
- Integração real com WhatsApp (próxima fase).
- Painel completo de atendentes, métricas e relatórios.
- Áudio, localização por pin, Pix com QR code, lembrete de recompra, avaliação pós-entrega.
- Cadastro de clientes novos na RevGás (ver seção 5.4).
- Alterar ou cancelar vendas pela conversa (v1 só cria e consulta; cancelamento vai para humano).
- Deploy em produção.

### Anti-objetivos (falha mesmo que "funcione")
- A IA inventar preço, produto ou forma de pagamento que não existe no ERP.
- Criar venda sem o cliente ter dito "sim" ao resumo.
- Criar venda duplicada (cliente manda "sim" duas vezes, rede repete a requisição, etc.).
- Vazar o token RevGás ou a chave da IA (repositório, logs, front-end, slides).
- Disparar entregas reais durante testes.

## 3. Restrições conhecidas

- **API RevGás**: base `https://api.revgas.com/v1`, header `Authorization: <API_KEY>`.
  Documentação: https://revgas.stoplight.io/docs/revgas-api
- **Limite global: 1 requisição por segundo** (HTTP 429 se passar). Toda chamada à RevGás passa por
  uma fila única com espaçamento mínimo de 1 s e nova tentativa com espera em 429.
- **Respostas de erro padronizadas**: 400/422 (dados inválidos, não repetir sem corrigir), 401
  (token), 402 (assinatura bloqueada), 403 (sem permissão), 409 (lock → pode repetir; duplicado →
  não repetir), 500.
- **Sem ambiente de testes documentado.** O token aponta para o estabelecimento "RevGás - Técnico"
  (id 2580), que parece ser uma conta técnica (estoques na casa dos milhões). A mesma conta também
  enxerga "Filial 2" (id 2601). Precisa de confirmação da RevGás de que criar/cancelar vendas ali é
  seguro.
- **Produtos não trazem preço** em `GET /v1/products`, mas a venda exige `value` por item.
  Ver seção 5.3.
- Ambiente de desenvolvimento: Windows 10, Node 24, pnpm 12, Docker 29 disponíveis.

## 4. Abordagens consideradas

| Opção | Prós | Contras | Decisão |
|---|---|---|---|
| **TypeScript (Node.js)** | Uma linguagem para servidor, chat e futuro painel; tipos compartilhados; ótimo para I/O, webhooks e tempo real; ecossistema de WhatsApp não oficial como plano B | Mais configuração inicial; ecossistema exige curadoria | **Escolhida** |
| Python (FastAPI) | Código enxuto; Pydantic excelente; melhor para dados/ML | Duas linguagens (o painel exige JS); async menos natural; vantagem em IA não se aplica (só chamamos API) | Descartada |
| Java (Spring) | Robusto | Muito código para o escopo; descartado pelo usuário | Descartada |

Banco: **PostgreSQL desde o início** (via Docker Compose) em vez de SQLite. O Docker já está
instalado, então o custo de setup é quase zero; evita migrar depois, suporta concorrência real
(webhooks do WhatsApp chegando em paralelo) e trava de linha para impedir venda duplicada.

Decisões do usuário: TypeScript; chat simulado primeiro e WhatsApp depois; foco em criar venda;
PostgreSQL. Demais escolhas de ferramenta abaixo são proposta minha e podem ser corrigidas.

## 5. Como funciona

### 5.1 Peças

```
[Chat simulado (React)] ──HTTP/WebSocket──> [Servidor Fastify]
                                               │
                         ┌─────────────────────┼──────────────────────┐
                   [Conversas]          [Agente de IA]          [Cliente RevGás]
                   (Postgres)        (Claude + ferramentas)   (fila 1 req/s + cache)
                                                                       │
                                                               api.revgas.com/v1
```

- **Canal** (`channels/`): interface única "mensagem recebida de telefone X / enviar mensagem para
  telefone X". Implementação v1: chat simulado via WebSocket. Depois: WhatsApp atrás da mesma
  interface.
- **Conversas** (`conversations/`): guarda mensagens, estado (`bot` | `aguardando_humano`) e o
  rascunho do pedido atual.
- **Agente** (`agent/`): manda o histórico para o modelo de IA com as ferramentas disponíveis,
  executa as ferramentas pedidas e devolve a resposta. A IA nunca chama a RevGás diretamente.
- **Cliente RevGás** (`revgas/`): funções tipadas por endpoint, validação das respostas com Zod,
  fila com limite de 1 req/s, cache de produtos.

### 5.2 Ferramentas da IA

| Ferramenta | O que faz | Chamada RevGás |
|---|---|---|
| `buscar_cliente()` | Busca pelo telefone da conversa (a IA não escolhe o telefone) | `GET /customers?phone=` |
| `listar_produtos()` | Produtos ativos do estabelecimento, com preço | `GET /products` (cache) |
| `montar_pedido(itens, endereço, pagamentos, observação)` | Valida tudo no código e grava/atualiza o **rascunho**; devolve o resumo com total | nenhuma |
| `confirmar_pedido()` | Cria a venda a partir do rascunho | `POST /sales` |
| `consultar_pedido(id?)` | Status de um pedido desta conversa | `GET /sales/{id}` |
| `chamar_atendente(motivo)` | Marca a conversa como aguardando humano | nenhuma |

### 5.3 Regras que ficam no código (não na IA)

1. **Preço** vem sempre da fonte de preços do sistema, nunca do texto da IA. Como a API de
   produtos não traz preço, a v1 usa uma **tabela de preços local** (arquivo de configuração por
   `product_id`), até a RevGás indicar de onde ler o preço. Trocar a fonte depois deve mexer só num
   módulo.
2. **Confirmação obrigatória:** `confirmar_pedido` só funciona se existir um rascunho válido cujo
   resumo já foi enviado ao cliente **e** se chegou uma nova mensagem do cliente depois desse
   envio. Se o rascunho mudar, a confirmação anterior deixa de valer.
3. **Sem duplicidade:** o rascunho tem estado (`rascunho` → `enviando` → `criado` | `erro` | `incerto`). A
   transição para `enviando` é feita com trava no banco; um segundo "sim" não cria outra venda.
   Se a requisição falhar sem resposta clara (timeout, queda de rede, 5xx), a v1 **não tenta de
   novo sozinha**: marca o rascunho como `incerto` e passa a conversa para um humano conferir no
   ERP. 429 e 409-lock (a RevGás não processou) podem ser repetidos com espera.
4. **O resumo é gerado pelo código**, não pela IA: depois de um `montar_pedido` bem-sucedido, o
   sistema envia ao cliente o texto oficial do resumo (itens, preços, total, endereço, pagamento)
   e só então o rascunho conta como "apresentado".
5. **Validação:** produto precisa existir e estar ativo; quantidade ≥ 1 e com teto configurável;
   pagamento precisa ser um dos valores aceitos pela API (`PIX`, `MONEY`, `CARTAO_DE_CREDITO`,
   `CARTAO_DE_DEBITO`, `VALEGAS`…); soma dos pagamentos = total.
6. **Campos fixos da venda:** `channel: "WHATSAPP"`, `origin: "INTEGRATION"`, `option: "NORMAL"`,
   `establishment_id` da configuração. `broadcast` vem da configuração: `NONE` em desenvolvimento,
   `NEW_SALE` só quando a RevGás liberar. `deliverer_id` não é enviado (a revenda atribui).
7. **Passagem para humano** quando: o cliente pede; a IA não entende após duas tentativas;
   reclamação; pedido de cancelamento; erro da RevGás que impede a venda.

### 5.4 Cliente não cadastrado

A resposta da venda indica `customer_id` como opcional (`integer or null`). A v1 tenta criar a
venda **sem cliente**, só com o endereço informado na conversa. Se a API recusar, a conversa vai
para atendimento humano. Cadastrar cliente novo (`POST /customers`) fica fora da v1.

### 5.5 Exemplo de conversa

```
Cliente: quero um botijão
  IA → buscar_cliente()      → Maria, Rua das Flores, 120, Centro
  IA → listar_produtos()     → GLP 13KG (id 23740), R$ X
Bot: Oi Maria! 1 botijão de 13 kg por R$ X, entrega na Rua das Flores, 120. Como vai pagar?
Cliente: pix
  IA → montar_pedido(...)    → resumo, total R$ X
Bot: Confirmando: 1x GLP 13 kg, R$ X, Pix, Rua das Flores, 120 – Centro. Posso registrar?
Cliente: pode
  IA → confirmar_pedido()    → POST /v1/sales → venda 4521
Bot: Pedido nº 4521 registrado! Já já chega.
```

## 6. Stack (proposta)

- Node.js 24 + TypeScript (modo estrito), pnpm, monorepo simples: `apps/server`, `apps/web`,
  `packages/shared` (tipos e schemas Zod compartilhados).
- Servidor: Fastify + `@fastify/websocket`.
- Validação: Zod (entrada das ferramentas da IA, respostas da RevGás, rotas HTTP).
- Banco: PostgreSQL 17 via `docker-compose.yml`; acesso com Drizzle ORM e migrações versionadas.
- IA: SDK oficial da Anthropic para TypeScript, com *tool use*. Modelo configurável por variável de
  ambiente.
- Front: React + Vite para o chat simulado (lista de conversas, seletor de telefone, área de
  atendente humano).
- Testes: Vitest. Cliente RevGás testado contra respostas gravadas/mocks; regras do rascunho
  testadas sem IA; um teste de ponta a ponta com IA real é manual.
- Segredos: `.env` (fora do git), `.env.example` sem valores, `.gitignore` desde o primeiro commit.
  Nada de segredo no front-end nem nos logs.

## 6.1 Decisões menores (minhas, revisáveis)

- **Telefone com mais de um cliente** na RevGás: o bot pergunta o nome para escolher; se continuar
  ambíguo, segue como cliente não identificado (5.4).
- **Endereço diferente do cadastro:** `montar_pedido` aceita o endereço informado na conversa e ele
  vale só para aquela venda (não altera o cadastro).
- **Chamadas reais de escrita** (`POST /sales`) ficam desligadas por padrão (`REVGAS_WRITE_ENABLED=false`);
  o desenvolvimento usa um cliente RevGás falso. Leituras reais (clientes, produtos) são permitidas.
  **Decisão do usuário:** nenhuma venda real é criada antes de a RevGás confirmar que é seguro
  (pergunta 8.2). Até lá, `REVGAS_WRITE_ENABLED` permanece `false`.
- **Chave da IA:** o usuário já tem chave da API da Anthropic; vai em `ANTHROPIC_API_KEY` no `.env`.
- **Preços da tabela local** na v1 são valores de demonstração até a RevGás informar a fonte real.
- Repositório git iniciado na raiz do projeto.

## 7. O que fica para quem construir

- Escolha exata do modelo de IA e do texto do prompt de sistema (tom: cordial, curto, português do
  Brasil).
- Estrutura interna das pastas e nomes, desde que a separação canal / conversas / agente / RevGás
  seja mantida.
- Formato da tabela de preços local.
- Estratégia de expiração do cache de produtos.
- Detalhes visuais do chat simulado.
- Verificar na documentação (ou com uma chamada de teste) os campos obrigatórios reais de
  `POST /v1/sales` e o formato de `GET /v1/sales/{id}`.

## 8. Perguntas em aberto para a RevGás

1. De onde vem o preço de cada produto (tabela, acordo por cliente, produto personalizado)?
2. Podemos criar e cancelar vendas à vontade no estabelecimento "RevGás - Técnico" (id 2580)?
   Qual estabelecimento o bot deve usar?
3. `broadcast: NEW_SALE` notifica entregadores reais nessa conta?
4. Venda sem `customer_id` é aceita?
