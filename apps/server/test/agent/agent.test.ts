import type Anthropic from "@anthropic-ai/sdk";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentTurn, type AgentDeps, type ToolContext } from "../../src/agent/agent.js";
import { SYSTEM_PROMPT, systemPromptFor } from "../../src/agent/systemPrompt.js";
import { runTool, toolDefinitions, toolDefinitionsFor } from "../../src/agent/tools.js";
import { Catalog } from "../../src/catalog/catalog.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db/client.js";
import { conversations, customerProfiles, llmTurns, orderDrafts } from "../../src/db/schema.js";
import { OrderService } from "../../src/orders/orderService.js";
import { FakeRevgasClient } from "../../src/revgas/fakeClient.js";
import { HttpRevgasClient } from "../../src/revgas/httpClient.js";
import { RateLimiter } from "../../src/revgas/rateLimiter.js";
import { RevgasError, acceptedPaymentTypes } from "../../src/revgas/types.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

type Block = Anthropic.Beta.BetaContentBlock;
type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;

let db: Db;
let close: () => Promise<void>;
let fake: FakeRevgasClient;
let conversationId: string;
let requests: Params[];

const cfg = loadConfig({ DATABASE_URL: "postgres://x", REVGAS_API_KEY: "k", ANTHROPIC_API_KEY: "a" });

function reply(content: Block[], stop_reason: Anthropic.Beta.BetaStopReason): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

const toolUse = (id: string, name: string, input: unknown): Block =>
  ({ type: "tool_use", id, name, input }) as unknown as Block;
const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as unknown as Block;
const thinking = (sig: string): Block => ({ type: "thinking", thinking: "", signature: sig }) as unknown as Block;

function scriptedAnthropic(...responses: Anthropic.Beta.BetaMessage[]) {
  requests = [];
  const create = vi.fn(async (params: Params) => {
    requests.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  });
  return { beta: { messages: { create } } } as unknown as Pick<Anthropic, "beta">;
}

function deps(anthropic: Pick<Anthropic, "beta">, over: Partial<AgentDeps> = {}): AgentDeps {
  const revgas = over.revgas ?? fake;
  const c = over.cfg ?? cfg;
  const catalog = new Catalog(revgas, 2580, { acceptedPayments: acceptedPaymentTypes(c.revgasValegasEnabled) });
  return { anthropic, orders: new OrderService(db, catalog, revgas, c), catalog, revgas, db, cfg: c, ...over };
}

const customersOn = loadConfig({ DATABASE_URL: "postgres://x", REVGAS_API_KEY: "k", ANTHROPIC_API_KEY: "a", REVGAS_CUSTOMERS_ENABLED: "true" });

const ctx = (): ToolContext => ({ conversationId, phone: "86999998888", customerId: null, events: {} });

const orderInput = {
  items: [{ productId: 23740, quantity: 1 }],
  address: { location: "Rua das Flores", number: "120", neighborhood: "Centro", city: "Teresina", state: "PI" },
  payments: [{ type: "PIX" }],
  emptyCylinders: 1,
  customerName: "Maria",
};

const pixDeal = (product_id: number, value: number, payment_type = "PIX") => ({
  id: product_id * 10 + payment_type.length,
  product_id,
  payment_type,
  suggested_value: value,
  minimum_value: null,
  type: "PAYMENT_TYPE",
  is_default: false,
});

async function turns() {
  return db.select().from(llmTurns).where(eq(llmTurns.conversationId, conversationId)).orderBy(asc(llmTurns.id));
}

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetTables(db);
  fake = new FakeRevgasClient();
  fake.products.push(
    { id: 23740, description: "GLP 13KG", inactive: false, establishment_id: 2580, container_id: 23741 },
    { id: 23741, description: "VASILHAME 13KG", inactive: false, establishment_id: 2580 },
  );
  fake.deals.push(pixDeal(23740, 110), pixDeal(23740, 110, "MONEY"), pixDeal(23740, 115, "CARTAO_DE_CREDITO"), pixDeal(23741, 10));
  fake.customers.push({
    id: 501, name: "Maria", phone: "86999998888", location: "Rua das Flores", number: "120",
    neighborhood: "Centro", city: "Teresina", state_federation: "PI", complement: null, landmark: null,
  });
  const [conv] = await db.insert(conversations).values({ phone: "86999998888" }).returning();
  conversationId = conv!.id;
});

describe("runAgentTurn", () => {
  it("runs the 'quero um botijão' script, presents a draft and stores history append-only", async () => {
    const first = reply([thinking("sig-1"), toolUse("t1", "buscar_cliente", {})], "tool_use");
    const firstContent = structuredClone(first.content);
    const anthropic = scriptedAnthropic(
      first,
      reply([toolUse("t2", "listar_produtos", {})], "tool_use"),
      reply([toolUse("t3", "montar_pedido", orderInput)], "tool_use"),
      reply([text("Prontinho, Maria! Segue o resumo.")], "end_turn"),
    );
    const c = ctx();
    const result = await runAgentTurn(c, "quero um botijão", deps(anthropic));

    expect(result.replyText).toBe("Prontinho, Maria! Segue o resumo.");
    expect(result.events.draftPresentable?.summaryText).toContain("• 1x GLP 13KG — R$ 110,00");
    expect(result.events.draftPresentable?.draftId).toMatch(/[0-9a-f-]{36}/);
    // C1: with REVGAS_CUSTOMERS_ENABLED off the RevGás customer is never looked up.
    expect(c.customerId).toBeNull();

    const rows = await turns();
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(rows[0]!.content).toBe("quero um botijão");
    expect(rows[1]!.content).toEqual(firstContent); // thinking block kept byte-for-byte

    // Each request extends the previous one without editing it.
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i]!.messages.slice(0, requests[i - 1]!.messages.length)).toEqual(requests[i - 1]!.messages);
    }
    expect(requests[1]!.messages[1]).toEqual({ role: "assistant", content: firstContent });
  });

  it("closes tool_use left without tool_result by a crash, appending (not editing) error results", async () => {
    const pending = [thinking("s"), toolUse("t8", "listar_produtos", {}), toolUse("t9", "buscar_cliente", {})];
    await db.insert(llmTurns).values([
      { conversationId, role: "user", content: "oi" },
      { conversationId, role: "assistant", content: pending },
    ]);
    const before = await turns();

    await runAgentTurn(ctx(), "quero gás", deps(scriptedAnthropic(reply([text("Claro!")], "end_turn"))));

    expect(requests[0]!.messages).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: pending },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t8", content: "Execução interrompida", is_error: true },
          { type: "tool_result", tool_use_id: "t9", content: "Execução interrompida", is_error: true },
        ],
      },
      { role: "user", content: "quero gás" },
    ]);
    const after = await turns();
    expect(after.slice(0, 2)).toEqual(before); // nothing edited
    expect(after.map((r) => r.role)).toEqual(["user", "assistant", "user", "user", "assistant"]);
  });

  it("does not add results when the last assistant turn has none pending", async () => {
    await db.insert(llmTurns).values([
      { conversationId, role: "user", content: "oi" },
      { conversationId, role: "assistant", content: [text("Olá!")] },
    ]);
    await runAgentTurn(ctx(), "quero gás", deps(scriptedAnthropic(reply([text("Claro!")], "end_turn"))));
    expect(requests[0]!.messages).toHaveLength(3);
  });

  it("replays stored history on the next customer message", async () => {
    await runAgentTurn(ctx(), "oi", deps(scriptedAnthropic(reply([thinking("s"), text("Olá!")], "end_turn"))));
    await runAgentTurn(ctx(), "quero gás", deps(scriptedAnthropic(reply([text("Claro!")], "end_turn"))));
    expect(requests[0]!.messages).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "Olá!", citations: null }] },
      { role: "user", content: "quero gás" },
    ]);
  });

  it("returns is_error for invalid montar_pedido input without touching drafts", async () => {
    const anthropic = scriptedAnthropic(
      reply([toolUse("t1", "montar_pedido", { ...orderInput, items: [{ productId: 23740, quantity: "dois" }] })], "tool_use"),
      reply([text("Quantos botijões?")], "end_turn"),
    );
    const result = await runAgentTurn(ctx(), "quero dois", deps(anthropic));
    const toolResult = (requests[1]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!;
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: true });
    expect(await db.select().from(orderDrafts)).toHaveLength(0);
    expect(result.events.draftPresentable).toBeUndefined();
  });

  it("answers every tool_use even when a tool throws, and hands off", async () => {
    const d = deps(
      scriptedAnthropic(
        reply([toolUse("t1", "listar_produtos", {})], "tool_use"),
        reply([text("Desculpe, vou chamar alguém.")], "end_turn"),
      ),
    );
    vi.spyOn(d.catalog, "list").mockRejectedValue(new Error("db down"));
    const result = await runAgentTurn(ctx(), "oi", d);
    const toolResult = (requests[1]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!;
    expect(toolResult).toMatchObject({ tool_use_id: "t1", is_error: true });
    expect(String(toolResult.content)).not.toContain("db down");
    expect(result.events.handoff).toEqual({ reason: "Erro interno" });
  });

  it("hands off when the model refuses", async () => {
    const refused = reply([], "refusal");
    const result = await runAgentTurn(ctx(), "algo", deps(scriptedAnthropic(refused)));
    expect(result.events.handoff).toEqual({ reason: "IA recusou" });
    expect(result.replyText).toBeNull();
  });

  it("stops after 8 tool-use iterations and hands off", async () => {
    const loops = Array.from({ length: 9 }, (_, i) => reply([toolUse(`t${i}`, "listar_produtos", {})], "tool_use"));
    const result = await runAgentTurn(ctx(), "?", deps(scriptedAnthropic(...loops)));
    expect(requests).toHaveLength(8);
    expect(result.events.handoff).toEqual({ reason: "Limite de passos da IA" });
  });

  it("sends the required request shape", async () => {
    await runAgentTurn(ctx(), "oi", deps(scriptedAnthropic(reply([text("Olá")], "end_turn"))));
    const req = requests[0]! as Params & Record<string, unknown>;
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.max_tokens).toBe(16000);
    expect(req.output_config).toEqual({ effort: "medium" });
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"]);
    expect(req.tool_choice === undefined || (req.tool_choice as { type: string }).type === "auto").toBe(true);
    expect(req).not.toHaveProperty("temperature");
    // Exactly this shape: adaptive only, no budget_tokens, no display, never disabled.
    expect(req.thinking).toStrictEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(typeof req.system).toBe("string");
    expect(req.tools).toEqual(toolDefinitions);
  });

  it("sends drop_block on every request of a multi-step turn (it applies per request)", async () => {
    await runAgentTurn(
      ctx(),
      "oi",
      deps(scriptedAnthropic(reply([toolUse("t1", "listar_produtos", {})], "tool_use"), reply([text("Olá")], "end_turn"))),
    );
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req.thinking).toStrictEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
      expect(req.betas).toContain("thinking-binding-controls-2026-08-01");
    }
  });

  it("logs dropped thinking blocks: conversation, count and reason, never the content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = reply([text("Claro!")], "end_turn") as unknown as Record<string, unknown>;
    r.input_transformations = [
      { type: "thinking_dropped", path: "messages.7.content.0", reason: "prefix_binding_mismatch" },
      { type: "thinking_dropped", path: "messages.9.content.0", reason: "prefix_binding_mismatch" },
      { type: "some_future_type", secret: "conteúdo-que-não-pode-vazar" },
    ];
    await runAgentTurn(ctx(), "quero gás", deps(scriptedAnthropic(r as unknown as Anthropic.Beta.BetaMessage)));
    const lines = warn.mock.calls.map((c) => c.join(" "));
    const line = lines.find((l) => l.includes("descartad"));
    expect(line).toBeDefined();
    expect(line).toContain(conversationId);
    expect(line).toContain("2");
    expect(line).toContain("prefix_binding_mismatch");
    expect(lines.join(" ")).not.toContain("some_future_type");
    expect(lines.join(" ")).not.toContain("conteúdo-que-não-pode-vazar");
    warn.mockRestore();
  });

  it("logs nothing when input_transformations is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = reply([text("Olá")], "end_turn") as unknown as Record<string, unknown>;
    r.input_transformations = [];
    await runAgentTurn(ctx(), "oi", deps(scriptedAnthropic(r as unknown as Anthropic.Beta.BetaMessage)));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("tools", () => {
  it("defines every tool as strict with closed schemas", () => {
    expect(toolDefinitions.map((t) => t.name).sort()).toEqual(
      ["buscar_cliente", "chamar_atendente", "confirmar_pedido", "consultar_pedido", "listar_produtos", "montar_pedido"],
    );
    for (const t of toolDefinitions) {
      expect(t.strict).toBe(true);
      expect((t.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  describe("buscar_cliente (C1)", () => {
    it("treats a phone without profile as a new customer", async () => {
      const r = await runTool("buscar_cliente", {}, ctx(), deps(scriptedAnthropic()));
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.content)).toMatchObject({ cliente: "novo" });
      expect(r.content).toMatch(/nome e o endereço/);
    });

    it("offers the saved address of a known customer", async () => {
      await db.insert(customerProfiles).values({
        phone: "86999998888", name: "Maria", location: "Rua X", number: "120", neighborhood: "Centro",
        city: "Teresina", state: "PI", emptyCylinders: 1, lastSaleId: 900000001,
      });
      const body = JSON.parse((await runTool("buscar_cliente", {}, ctx(), deps(scriptedAnthropic()))).content);
      expect(body).toMatchObject({
        cliente: "conhecido",
        nome: "Maria",
        enderecoTexto: "Rua X, 120 – Centro, Teresina/PI",
        endereco: { location: "Rua X", number: "120", neighborhood: "Centro", city: "Teresina", state: "PI" },
        botijoesVaziosNaUltimaCompra: 1,
      });
      expect(body.instrucao).toContain("Entregar no mesmo endereço de antes (Rua X, 120 – Centro)?");
    });

    it("never calls RevGás /customers when REVGAS_CUSTOMERS_ENABLED is false", async () => {
      const fetchFn = vi.fn(async (_url: string | URL | Request) => new Response("{}", { status: 200 }));
      const http = new HttpRevgasClient(cfg, new RateLimiter(0), fetchFn as unknown as typeof fetch, 0);
      await runTool("buscar_cliente", {}, ctx(), deps(scriptedAnthropic(), { revgas: http }));
      expect(fetchFn.mock.calls.filter(([url]) => String(url).includes("/customers"))).toHaveLength(0);
    });

    it("with the flag on, a 403 is an unidentified customer and never breaks the conversation", async () => {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ message: "User doesn't have access to this resource" }), { status: 403 }));
      const http = new HttpRevgasClient(customersOn, new RateLimiter(0), fetchFn as unknown as typeof fetch, 0);
      const c = ctx();
      const r = await runTool("buscar_cliente", {}, c, deps(scriptedAnthropic(), { revgas: http, cfg: customersOn }));
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.content)).toMatchObject({ cliente: "novo" });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(c.customerId).toBeNull();
    });

    it("with the flag on, one RevGás match fills revgasCustomerId", async () => {
      const c = ctx();
      await runTool("buscar_cliente", {}, c, deps(scriptedAnthropic(), { cfg: customersOn }));
      expect(c.customerId).toBe(501);
      const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
      expect(conv?.revgasCustomerId).toBe(501);
      const [profile] = await db.select().from(customerProfiles);
      expect(profile?.revgasCustomerId).toBe(501);
    });

    it("with the flag on, several RevGás matches are listed but none is chosen", async () => {
      fake.customers.push({ ...fake.customers[0]!, id: 502, name: "João" });
      const c = ctx();
      const r = await runTool("buscar_cliente", {}, c, deps(scriptedAnthropic(), { cfg: customersOn }));
      expect(r.content).toContain("Maria");
      expect(r.content).toContain("João");
      expect(c.customerId).toBeNull();
    });
  });

  it("listar_produtos (C2) shows the reference price, prices per payment and the cylinder", async () => {
    const r = await runTool("listar_produtos", {}, ctx(), deps(scriptedAnthropic()));
    const body = JSON.parse(r.content);
    expect(body.aviso).toMatch(/pode variar conforme a forma de pagamento/);
    expect(body.produtos).toEqual([
      {
        productId: 23740,
        description: "GLP 13KG",
        precoReferencia: "R$ 110,00",
        precosPorPagamento: { Pix: "R$ 110,00", Dinheiro: "R$ 110,00", "Cartão de crédito": "R$ 115,00" },
        vasilhame: { productId: 23741, description: "VASILHAME 13KG", precoReferencia: "R$ 10,00" },
      },
      { productId: 23741, description: "VASILHAME 13KG", precoReferencia: "R$ 10,00", precosPorPagamento: { Pix: "R$ 10,00" } },
    ]);
  });

  it("montar_pedido (C3) asks about the empty cylinder before building a gas order", async () => {
    const r = await runTool("montar_pedido", { ...orderInput, emptyCylinders: undefined }, ctx(), deps(scriptedAnthropic()));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/botijões vazios/);
  });

  // Found in the real-AI demo: the model omitted the optional field 7 times in a row ("sem vazio" in
  // the observation) until the step limit. Required + strict makes the API always send it.
  it("montar_pedido requires emptyCylinders in the strict schema", () => {
    const schema = toolDefinitions.find((t) => t.name === "montar_pedido")!.input_schema as { required: string[] };
    expect(schema.required).toContain("emptyCylinders");
  });

  it("montar_pedido explains how to fill emptyCylinders when it is missing", async () => {
    const r = await runTool("montar_pedido", { ...orderInput, emptyCylinders: undefined }, ctx(), deps(scriptedAnthropic()));
    expect(r.content).toContain("emptyCylinders");
    expect(r.content).toMatch(/0 se o cliente não tem/);
  });

  it("montar_pedido accepts emptyCylinders 0 for a water-only order", async () => {
    fake.products.push({ id: 24141, description: "AGUA 10L", inactive: false, establishment_id: 2580 });
    fake.deals.push(pixDeal(24141, 15));
    const c = ctx();
    const input = { ...orderInput, items: [{ productId: 24141, quantity: 1 }], emptyCylinders: 0 };
    const r = await runTool("montar_pedido", input, c, deps(scriptedAnthropic()));
    expect(r.isError).toBe(false);
    expect(c.events.draftPresentable?.summaryText).not.toContain("VASILHAME");
  });

  it("montar_pedido reports the total in its result (shown in the attendant's trace)", async () => {
    const r = await runTool("montar_pedido", { ...orderInput, emptyCylinders: 0 }, ctx(), deps(scriptedAnthropic()));
    expect(r.content).toContain("Resumo gerado (total R$ 120,00)");
  });

  it("montar_pedido (C3) adds the cylinder when the customer has none to swap", async () => {
    const c = ctx();
    await runTool("montar_pedido", { ...orderInput, emptyCylinders: 0 }, c, deps(scriptedAnthropic()));
    expect(c.events.draftPresentable?.summaryText).toContain("• 1x GLP 13KG — R$ 110,00\n• 1x VASILHAME 13KG — R$ 10,00\nTotal: R$ 120,00");
  });

  it("confirmar_pedido hands off on an uncertain result", async () => {
    const d = deps(scriptedAnthropic());
    const c = ctx();
    vi.spyOn(d.orders, "confirm").mockResolvedValue({ kind: "uncertain" });
    await runTool("confirmar_pedido", {}, c, d);
    expect(c.events.handoff).toEqual({ reason: "Falha incerta ao registrar venda" });
  });

  it("confirmar_pedido reports a created sale", async () => {
    const d = deps(scriptedAnthropic());
    vi.spyOn(d.orders, "confirm").mockResolvedValue({ kind: "created", saleId: 4521 });
    const r = await runTool("confirmar_pedido", {}, ctx(), d);
    expect(r.content).toContain("Venda 4521 criada");
  });

  it("confirmar_pedido hands off when RevGás rejects", async () => {
    const d = deps(scriptedAnthropic());
    const c = ctx();
    vi.spyOn(d.orders, "confirm").mockResolvedValue({ kind: "rejected", message: "Endereço inválido" });
    await runTool("confirmar_pedido", {}, c, d);
    expect(c.events.handoff).toEqual({ reason: "RevGás recusou a venda: Endereço inválido" });
  });

  it.each([
    ["OPEN", "Pedido recebido"],
    ["ACTIVE", "Pedido em preparação"],
    ["WARNING", "Saiu para entrega"],
    ["CONFIRM", "Entregue"],
    ["CHECK", "Entregue"],
    ["CANCEL", "Cancelado"],
    ["RECEIVED", "Em andamento"],
  ])("consultar_pedido (C5) translates %s as '%s'", async (status, label) => {
    const d = deps(scriptedAnthropic());
    vi.spyOn(d.orders, "getLatestSale").mockResolvedValue({ id: 9, status, total: 110 });
    const r = await runTool("consultar_pedido", {}, ctx(), d);
    expect(r.content).toBe(`Pedido nº 9: ${label}. Total R$ 110,00.`);
  });

  it("chamar_atendente records the handoff reason", async () => {
    const c = ctx();
    await runTool("chamar_atendente", { motivo: "Cliente pediu humano" }, c, deps(scriptedAnthropic()));
    expect(c.events.handoff).toEqual({ reason: "Cliente pediu humano" });
  });

  it("rejects an unknown tool", async () => {
    const r = await runTool("apagar_tudo", {}, ctx(), deps(scriptedAnthropic()));
    expect(r.isError).toBe(true);
  });

  it("does not offer Vale Gás in the montar_pedido schema nor accept it", async () => {
    const montar = toolDefinitions.find((t) => t.name === "montar_pedido")!;
    expect(JSON.stringify(montar.input_schema)).not.toContain("VALEGAS");
    const r = await runTool("montar_pedido", { ...orderInput, payments: [{ type: "VALEGAS" }] }, ctx(), deps(scriptedAnthropic()));
    expect(r.isError).toBe(true);
  });

  describe("with REVGAS_VALEGAS_ENABLED=true", () => {
    const vgOn = loadConfig({ DATABASE_URL: "postgres://x", REVGAS_API_KEY: "k", ANTHROPIC_API_KEY: "a", REVGAS_VALEGAS_ENABLED: "true" });

    it("offers VALEGAS and a couponCode per payment in the montar_pedido schema", () => {
      const montar = toolDefinitionsFor(vgOn).find((t) => t.name === "montar_pedido")!;
      const payment = (montar.input_schema as any).properties.payments.items;
      expect(payment.properties.type.enum).toContain("VALEGAS");
      expect(payment.properties.couponCode.type).toBe("string");
      expect(payment.additionalProperties).toBe(false);
    });

    it("keeps today's schema and prompt when the flag is off", () => {
      expect(toolDefinitionsFor(cfg)).toEqual(toolDefinitions);
      expect(JSON.stringify(toolDefinitions)).not.toContain("couponCode");
      expect(systemPromptFor(cfg)).toBe(SYSTEM_PROMPT);
    });

    it("tells the AI to ask for the coupon code", () => {
      const prompt = systemPromptFor(vgOn);
      expect(prompt).toContain("peça o código do cupom");
      expect(prompt).not.toContain("vale gás ainda não é aceito");
    });

    it("builds a Vale Gás order with the coupon and masks it in the summary", async () => {
      fake.deals.push(pixDeal(23740, 110, "VALEGAS"));
      const c = ctx();
      const input = { ...orderInput, payments: [{ type: "VALEGAS", couponCode: "55554444" }] };
      const r = await runTool("montar_pedido", input, c, deps(scriptedAnthropic(), { cfg: vgOn }));
      expect(r.isError).toBe(false);
      expect(c.events.draftPresentable?.summaryText).toContain("Vale Gás (cupom final 4444)");
    });

    it("rejects VALEGAS when the flag is off", async () => {
      fake.deals.push(pixDeal(23740, 110, "VALEGAS"));
      const r = await runTool("montar_pedido", { ...orderInput, payments: [{ type: "VALEGAS", couponCode: "1" }] }, ctx(), deps(scriptedAnthropic()));
      expect(r.isError).toBe(true);
    });

    it("sends the flag's tools and prompt to the API", async () => {
      await runAgentTurn(ctx(), "oi", deps(scriptedAnthropic(reply([text("Olá")], "end_turn")), { cfg: vgOn }));
      expect(requests[0]!.tools).toEqual(toolDefinitionsFor(vgOn));
      expect(requests[0]!.system).toBe(systemPromptFor(vgOn));
    });
  });

  it("does not offer vale gás in the system prompt and says it is not accepted", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/ou vale gás\)/);
    expect(SYSTEM_PROMPT).toContain("vale gás ainda não é aceito");
  });

  it("treats more products after a registered order as a new order, without asking", () => {
    expect(SYSTEM_PROMPT).toContain("trate como um pedido novo");
    expect(SYSTEM_PROMPT).toContain("sem perguntar se é para incluir no anterior");
  });

  it("reuses the last order's address and payment for a returning customer, saying what was kept", () => {
    expect(SYSTEM_PROMPT).toContain("reaproveite o endereço (de buscar_cliente) e a forma de pagamento do último pedido");
    expect(SYSTEM_PROMPT).toContain("chame montar_pedido assim que souber produto, quantidade e botijões vazios");
    expect(SYSTEM_PROMPT).toContain("Mantive o endereço da Rua das Flores, 120, e o pagamento no Pix; se quiser mudar, é só falar.");
    expect(SYSTEM_PROMPT).toContain("Sempre diga ao cliente qual forma de pagamento foi reaproveitada");
    expect(SYSTEM_PROMPT).toContain("Cliente novo: pergunte tudo");
  });

  it("uses the default city and state without asking, unless the customer says another", () => {
    expect(SYSTEM_PROMPT).toContain("A cidade de entrega padrão é Teresina/PI");
    expect(SYSTEM_PROMPT).toContain("não pergunte cidade nem estado");
    expect(SYSTEM_PROMPT).not.toContain("bairro, cidade, estado;");
    const other = systemPromptFor({ ...cfg, defaultCity: "Parnaíba", defaultState: "PI" });
    expect(other).toContain("A cidade de entrega padrão é Parnaíba/PI");
    expect(other).not.toContain("Teresina");
  });

  it("asks which gas size when the customer does not say, without suggesting one", () => {
    expect(SYSTEM_PROMPT).not.toContain('Se o cliente pedir "um botijão" ou "um P13", é o GLP 13 kg.');
    expect(SYSTEM_PROMPT).toContain("pergunte qual tamanho ele quer, citando as opções da lista, sem sugerir nem presumir um");
    expect(SYSTEM_PROMPT).toContain('"P13" é o GLP 13 kg e "P45" é o GLP 45 kg');
  });

  it("treats the WhatsApp options as approval of the last summary or a request to change it", () => {
    expect(SYSTEM_PROMPT).toContain('"Confirmar" (opção da lista do WhatsApp) é a aprovação do último resumo enviado');
    expect(SYSTEM_PROMPT).toContain('"Mudar algo" quer dizer que o cliente quer mudar o pedido: pergunte o que mudar');
  });

  it("calls an attendant to change or cancel a registered order only when the customer says so clearly", () => {
    expect(SYSTEM_PROMPT).toContain("pedir claramente para alterar ou cancelar um pedido já registrado");
    expect(SYSTEM_PROMPT).not.toContain("o cliente quiser cancelar ou alterar um pedido já registrado");
  });
});
