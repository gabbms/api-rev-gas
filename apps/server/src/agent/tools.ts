import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Catalog } from "../catalog/catalog.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { conversations } from "../db/schema.js";
import { formatCents } from "../orders/draft.js";
import type { OrderService } from "../orders/orderService.js";
import { PAYMENT_TYPES, RevgasError, type RevgasClient } from "../revgas/types.js";

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

export const toolDefinitions: Anthropic.Beta.BetaTool[] = [
  {
    name: "buscar_cliente",
    description:
      "Busca o cadastro do cliente pelo telefone desta conversa (o sistema já sabe o número). Retorna nome e endereço cadastrado, se houver.",
    input_schema: noInput,
    strict: true,
  },
  {
    name: "listar_produtos",
    description: "Lista os produtos disponíveis para venda, com id e preço oficial. Use antes de oferecer qualquer produto.",
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
          description: "Itens do pedido",
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
              type: { type: "string", enum: [...PAYMENT_TYPES], description: "MONEY = dinheiro" },
              amountCents: { type: "integer", description: "Valor em centavos (ex.: 5000 = R$ 50,00)" },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        observation: { type: "string", description: "Observação para a entrega, ex.: troco para R$ 200" },
      },
      required: ["items", "address", "payments"],
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

const emptyInput = z.object({}).strict();

const montarPedidoInput = z
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
    payments: z.array(z.object({ type: z.enum(PAYMENT_TYPES), amountCents: z.number().int().optional() }).strict()),
    observation: z.string().optional(),
  })
  .strict();

const chamarAtendenteInput = z.object({ motivo: z.string().min(1) }).strict();

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Aberto",
  ACTIVE: "Em andamento",
  WARNING: "Avisado",
  CONFIRM: "Confirmado/entregue",
  CHECK: "Conferido",
  CANCEL: "Cancelado",
};

const ok = (content: string): ToolResult => ({ content, isError: false });
const fail = (content: string): ToolResult => ({ content, isError: true });

function invalid(error: z.ZodError): ToolResult {
  const issues = error.issues.map((i) => `${i.path.join(".") || "entrada"}: ${i.message}`);
  return fail(`Entrada inválida: ${issues.join("; ")}`);
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
      const products = await deps.catalog.list();
      return ok(
        JSON.stringify(products.map((p) => ({ productId: p.productId, description: p.description, preco: formatCents(p.priceCents) }))),
      );
    }
    case "montar_pedido": {
      const parsed = montarPedidoInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const result = await deps.orders.upsertDraft(ctx.conversationId, parsed.data, ctx.customerId);
      if (!result.ok) return fail(`Pedido não pôde ser montado: ${result.errors.join("; ")}`);
      ctx.events.draftPresentable = { draftId: result.draftId!, summaryText: result.summaryText };
      return ok("Resumo gerado; o sistema vai enviá-lo ao cliente. Não repita preços.");
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
        return ok(`Pedido nº ${sale.id}: ${STATUS_LABELS[sale.status] ?? sale.status}. Total R$ ${sale.total.toFixed(2).replace(".", ",")}.`);
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

async function buscarCliente(ctx: ToolContext, deps: AgentDeps): Promise<ToolResult> {
  let found;
  try {
    found = await deps.revgas.findCustomersByPhone(ctx.phone);
  } catch (e) {
    if (e instanceof RevgasError) {
      return ok("Cliente não identificado (cadastro indisponível agora). Peça o endereço completo de entrega.");
    }
    throw e;
  }
  if (found.length === 0) return ok("Cliente não identificado: telefone sem cadastro. Peça o endereço completo de entrega.");
  if (found.length > 1) {
    return ok(
      `Há ${found.length} cadastros com este telefone: ${found.map((c) => c.name).join(", ")}. ` +
        "Pergunte o nome do cliente; se continuar ambíguo, trate como não identificado e peça o endereço.",
    );
  }
  const c = found[0]!;
  ctx.customerId = c.id;
  await deps.db.update(conversations).set({ revgasCustomerId: c.id, updatedAt: new Date() }).where(eq(conversations.id, ctx.conversationId));
  return ok(
    JSON.stringify({
      nome: c.name,
      endereco: {
        location: c.location,
        number: c.number,
        neighborhood: c.neighborhood,
        city: c.city,
        state: c.state_federation,
        complement: c.complement,
        landmark: c.landmark,
      },
    }),
  );
}
