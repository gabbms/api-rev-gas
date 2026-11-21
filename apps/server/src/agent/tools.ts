import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { referencePriceCents, type Catalog, type PriceTable } from "../catalog/catalog.js";
import type { AppConfig } from "../config.js";
import { getProfile, hasAddress, pricingCustomer, setRevgasCustomerId } from "../customers/customerProfiles.js";
import type { Db } from "../db/client.js";
import { conversations } from "../db/schema.js";
import { PAYMENT_LABELS, formatCents } from "../orders/draft.js";
import type { OrderService } from "../orders/orderService.js";
import { ALL_PAYMENT_TYPES, RevgasError, acceptedPaymentTypes, type PaymentType, type RevgasClient } from "../revgas/types.js";

export type ToolContext = {
  conversationId: string;
  phone: string;
  customerId: number | null;
  events: { draftPresentable?: { draftId: string; summaryText: string }; handoff?: { reason: string } };
};

export type AgentDeps = {
  anthropic: Pick<Anthropic, "beta">;
  orders: OrderService;
  catalog: Catalog;
  revgas: RevgasClient;
  db: Db;
  cfg: AppConfig;
};

export type ToolResult = { content: string; isError: boolean };

const noInput = { type: "object", properties: {}, required: [], additionalProperties: false } as const;

const addressSchema = {
  type: "object",
  description: "Endereço de entrega desta venda.",
  properties: {
    location: { type: "string", description: "Rua / logradouro" },
    number: { type: "string", description: "Número do imóvel (use \"S/N\" se o cliente disser que não tem)" },
    neighborhood: { type: "string", description: "Bairro" },
    city: { type: "string", description: "Cidade" },
    state: { type: "string", description: "Estado (UF), ex.: PI" },
    complement: { type: "string", description: "Complemento, se houver" },
    landmark: { type: "string", description: "Ponto de referência, se houver" },
  },
  required: ["location", "number", "neighborhood", "city", "state"],
  additionalProperties: false,
} as const;

/** Tool list for this configuration. Must stay identical across a conversation (thinking is bound to it). */
export function toolDefinitionsFor(cfg: Pick<AppConfig, "revgasValegasEnabled">): Anthropic.Beta.BetaTool[] {
  const accepted = acceptedPaymentTypes(cfg.revgasValegasEnabled);
  return [
  {
    name: "buscar_cliente",
    description:
      "Busca o cliente pelo telefone desta conversa (o sistema já sabe o número). Diz se é cliente novo ou conhecido e, se conhecido, o nome e o endereço da última entrega.",
    input_schema: noInput,
    strict: true,
  },
  {
    name: "listar_produtos",
    description:
      "Lista os produtos à venda com o preço oficial. O preço pode mudar conforme a forma de pagamento; mostra o preço de referência e o preço de cada forma aceita. Use antes de oferecer qualquer produto.",
    input_schema: noInput,
    strict: true,
  },
  {
    name: "montar_pedido",
    description:
      "Valida o pedido completo e gera o resumo oficial, que o sistema envia ao cliente para confirmação. Sempre envie o pedido inteiro (substitui o rascunho anterior).",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Itens do pedido. Não inclua o vasilhame: o sistema adiciona os que faltarem conforme emptyCylinders.",
          items: {
            type: "object",
            properties: {
              productId: { type: "integer", description: "id vindo de listar_produtos" },
              quantity: { type: "integer", description: "Quantidade (inteiro, 1 ou mais)" },
            },
            required: ["productId", "quantity"],
            additionalProperties: false,
          },
        },
        address: addressSchema,
        payments: {
          type: "array",
          description:
            "Formas de pagamento. Com uma só forma, omita amountCents (vale o total). Com mais de uma, informe o valor em centavos de cada.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: [...accepted], description: "MONEY = dinheiro" },
              amountCents: { type: "integer", description: "Valor em centavos (ex.: 5000 = R$ 50,00)" },
              ...(cfg.revgasValegasEnabled
                ? { couponCode: { type: "string", description: "Código do cupom do Vale Gás. Obrigatório para VALEGAS; não use nas outras formas." } }
                : {}),
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        emptyCylinders: {
          type: "integer",
          description:
            "Quantos botijões vazios o cliente tem para trocar: 0 se ele não tem nenhum ou se o pedido não tem gás. O sistema cobra um vasilhame para cada botijão de gás sem vazio. Sempre informe.",
        },
        customerName: { type: "string", description: "Nome do cliente, se ele informou" },
        observation: { type: "string", description: "Observação para a entrega, ex.: troco para R$ 200" },
      },
      required: ["items", "address", "payments", "emptyCylinders"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "confirmar_pedido",
    description:
      "Registra a venda do último resumo enviado. Use somente depois que o cliente aprovar claramente esse resumo.",
    input_schema: noInput,
    strict: true,
  },
  {
    name: "consultar_pedido",
    description: "Consulta o status do pedido mais recente registrado nesta conversa.",
    input_schema: noInput,
    strict: true,
  },
  {
    name: "chamar_atendente",
    description: "Passa a conversa para um atendente humano. O bot para de responder nesta conversa.",
    input_schema: {
      type: "object",
      properties: { motivo: { type: "string", description: "Motivo curto da passagem, em português" } },
      required: ["motivo"],
      additionalProperties: false,
    },
    strict: true,
  },
];
}

/** The default tool list (Vale Gás off). */
export const toolDefinitions = toolDefinitionsFor({ revgasValegasEnabled: false });

const emptyInput = z.object({}).strict();

const EMPTY_CYLINDERS_HELP =
  "informe emptyCylinders com o número de botijões vazios para trocar (0 se o cliente não tem nenhum ou se o pedido não tem gás)";

function montarPedidoInputFor(valegasEnabled: boolean) {
  const accepted = acceptedPaymentTypes(valegasEnabled) as [PaymentType, ...PaymentType[]];
  const payment = valegasEnabled
    ? z.object({ type: z.enum(accepted), amountCents: z.number().int().optional(), couponCode: z.string().optional() }).strict()
    : z.object({ type: z.enum(accepted), amountCents: z.number().int().optional() }).strict();
  return z
  .object({
    items: z.array(z.object({ productId: z.number().int(), quantity: z.number().int() }).strict()),
    address: z
      .object({
        location: z.string(),
        number: z.string(),
        neighborhood: z.string(),
        city: z.string(),
        state: z.string(),
        complement: z.string().optional(),
        landmark: z.string().optional(),
      })
      .strict(),
    payments: z.array(payment),
    emptyCylinders: z.number({ error: EMPTY_CYLINDERS_HELP }).int({ error: EMPTY_CYLINDERS_HELP }).min(0, { error: EMPTY_CYLINDERS_HELP }),
    customerName: z.string().optional(),
    observation: z.string().optional(),
  })
  .strict();
}

const chamarAtendenteInput = z.object({ motivo: z.string().min(1) }).strict();

// C5: wording from the API survey (docs/revgas-api.md §3.2).
const STATUS_LABELS: Record<string, string> = {
  OPEN: "Pedido recebido",
  ACTIVE: "Pedido em preparação",
  WARNING: "Saiu para entrega",
  CONFIRM: "Entregue",
  CHECK: "Entregue",
  CANCEL: "Cancelado",
};

const ok = (content: string): ToolResult => ({ content, isError: false });
const fail = (content: string): ToolResult => ({ content, isError: true });

function invalid(error: z.ZodError): ToolResult {
  const issues = error.issues.map((i) => `${i.path.join(".") || "entrada"}: ${i.message}`);
  return fail(`Entrada inválida: ${issues.join("; ")}`);
}

const reais = (value: number) => `R$ ${value.toFixed(2).replace(".", ",")}`;

function pricesByPayment(prices: PriceTable): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of ALL_PAYMENT_TYPES) if (prices[t] !== undefined) out[PAYMENT_LABELS[t as PaymentType]] = formatCents(prices[t]!);
  return out;
}

export async function runTool(name: string, input: unknown, ctx: ToolContext, deps: AgentDeps): Promise<ToolResult> {
  switch (name) {
    case "buscar_cliente": {
      const parsed = emptyInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      return buscarCliente(ctx, deps);
    }
    case "listar_produtos": {
      const parsed = emptyInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      return listarProdutos(ctx, deps);
    }
    case "montar_pedido": {
      const parsed = montarPedidoInputFor(deps.cfg.revgasValegasEnabled).safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const result = await deps.orders.upsertDraft(ctx.conversationId, parsed.data, ctx.customerId);
      if (!result.ok) return fail(`Pedido não pôde ser montado: ${result.errors.join("; ")}`);
      ctx.events.draftPresentable = { draftId: result.draftId!, summaryText: result.summaryText };
      return ok(`Resumo gerado (total ${formatCents(result.data.totalCents)}); o sistema vai enviá-lo ao cliente. Não repita preços.`);
    }
    case "confirmar_pedido": {
      const parsed = emptyInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const r = await deps.orders.confirm(ctx.conversationId);
      switch (r.kind) {
        case "created":
          return ok(`Venda ${r.saleId} criada. Informe ao cliente: Pedido nº ${r.saleId} registrado.`);
        case "already_created":
          return ok(`Este pedido já foi registrado antes (venda ${r.saleId}). Não registre de novo.`);
        case "not_ready": {
          const why = {
            no_draft: "Não há pedido montado. Use montar_pedido primeiro.",
            not_presented: "O resumo atual ainda não foi enviado ao cliente. Use montar_pedido para gerar o resumo.",
            no_reply_after_summary: "O cliente ainda não respondeu ao último resumo. Aguarde a confirmação dele.",
            in_progress: "O pedido já está sendo registrado. Aguarde.",
          }[r.reason];
          return fail(why);
        }
        case "uncertain":
          ctx.events.handoff = { reason: "Falha incerta ao registrar venda" };
          return fail("Não foi possível ter certeza se a venda foi registrada. Um atendente vai conferir; não tente de novo.");
        case "rejected":
          ctx.events.handoff = { reason: `RevGás recusou a venda: ${r.message}` };
          return fail(`O sistema recusou a venda (${r.message}). Um atendente vai assumir.`);
      }
      break;
    }
    case "consultar_pedido": {
      const parsed = emptyInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      try {
        const sale = await deps.orders.getLatestSale(ctx.conversationId);
        if (!sale) return ok("Nenhum pedido registrado nesta conversa.");
        return ok(`Pedido nº ${sale.id}: ${STATUS_LABELS[sale.status] ?? "Em andamento"}. Total ${reais(sale.total)}.`);
      } catch (e) {
        if (e instanceof RevgasError) return fail(`Não foi possível consultar o pedido agora (${e.kind}).`);
        throw e;
      }
    }
    case "chamar_atendente": {
      const parsed = chamarAtendenteInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      ctx.events.handoff = { reason: parsed.data.motivo };
      return ok("Conversa encaminhada para um atendente humano.");
    }
  }
  return fail(`Ferramenta desconhecida: ${name}`);
}

async function listarProdutos(ctx: ToolContext, deps: AgentDeps): Promise<ToolResult> {
  const products = await deps.catalog.list(await pricingCustomer(deps.db, deps.cfg, ctx.customerId));
  const byId = new Map(products.map((p) => [p.productId, p]));
  const ref = (prices: PriceTable) => {
    const cents = referencePriceCents(prices);
    return cents === null ? null : formatCents(cents);
  };
  return ok(
    JSON.stringify({
      aviso: "O preço pode variar conforme a forma de pagamento. O preço de referência é no Pix (ou dinheiro).",
      produtos: products.map((p) => {
        const container = p.containerId ? byId.get(p.containerId) : undefined;
        return {
          productId: p.productId,
          description: p.description,
          precoReferencia: ref(p.pricesCents),
          precosPorPagamento: pricesByPayment(p.pricesCents),
          ...(container
            ? { vasilhame: { productId: container.productId, description: container.description, precoReferencia: ref(container.pricesCents) } }
            : {}),
        };
      }),
    }),
  );
}

/** C1: local profile first; RevGás /customers only when enabled, and never fatal. */
async function buscarCliente(ctx: ToolContext, deps: AgentDeps): Promise<ToolResult> {
  const profile = await getProfile(deps.db, ctx.phone);
  let revgasNote: string | undefined;

  if (deps.cfg.revgasCustomersEnabled) {
    try {
      const found = await deps.revgas.findCustomersByPhone(ctx.phone);
      if (found.length === 1) {
        const c = found[0]!;
        ctx.customerId = c.id;
        await deps.db
          .update(conversations)
          .set({ revgasCustomerId: c.id, updatedAt: new Date() })
          .where(eq(conversations.id, ctx.conversationId));
        await setRevgasCustomerId(deps.db, ctx.phone, c.id, c.tag_id ?? null);
      } else if (found.length > 1) {
        revgasNote =
          `Há ${found.length} cadastros na RevGás com este telefone: ${found.map((c) => c.name).join(", ")}. ` +
          "Pergunte o nome do cliente; se continuar ambíguo, siga sem cadastro.";
      }
    } catch (e) {
      if (!(e instanceof RevgasError)) throw e;
      // 403 (or any RevGás error): treated as "not identified".
    }
  }

  if (hasAddress(profile)) {
    const street = `${profile.location}, ${profile.number} – ${profile.neighborhood}`;
    return ok(
      JSON.stringify({
        cliente: "conhecido",
        nome: profile.name,
        endereco: {
          location: profile.location,
          number: profile.number,
          neighborhood: profile.neighborhood,
          city: profile.city,
          state: profile.state,
          ...(profile.complement ? { complement: profile.complement } : {}),
          ...(profile.landmark ? { landmark: profile.landmark } : {}),
        },
        enderecoTexto: `${street}, ${profile.city}/${profile.state}`,
        botijoesVaziosNaUltimaCompra: profile.emptyCylinders,
        instrucao: `Cumprimente pelo nome e pergunte: "Entregar no mesmo endereço de antes (${street})?"`,
        ...(revgasNote ? { observacao: revgasNote } : {}),
      }),
    );
  }
  return ok(
    JSON.stringify({
      cliente: "novo",
      ...(profile?.name ? { nome: profile.name } : {}),
      instrucao: "Cliente sem endereço salvo: pergunte o nome e o endereço completo de entrega.",
      ...(revgasNote ? { observacao: revgasNote } : {}),
    }),
  );
}
