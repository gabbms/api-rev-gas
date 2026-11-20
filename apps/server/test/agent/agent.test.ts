import type Anthropic from "@anthropic-ai/sdk";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentTurn, type AgentDeps, type ToolContext } from "../../src/agent/agent.js";
import { runTool, toolDefinitions } from "../../src/agent/tools.js";
import { Catalog } from "../../src/catalog/catalog.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db/client.js";
import { conversations, llmTurns, orderDrafts } from "../../src/db/schema.js";
import { OrderService } from "../../src/orders/orderService.js";
import { FakeRevgasClient } from "../../src/revgas/fakeClient.js";
import { RevgasError } from "../../src/revgas/types.js";
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

function deps(anthropic: Pick<Anthropic, "beta">): AgentDeps {
  const catalog = new Catalog(fake, 2580, { "23740": 110 });
  return { anthropic, orders: new OrderService(db, catalog, fake, cfg), catalog, revgas: fake, db, cfg };
}

const ctx = (): ToolContext => ({ conversationId, phone: "86999998888", customerId: null, events: {} });

const orderInput = {
  items: [{ productId: 23740, quantity: 1 }],
  address: { location: "Rua das Flores", number: "120", neighborhood: "Centro", city: "Teresina", state: "PI" },
  payments: [{ type: "PIX" }],
};

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
  fake.products.push({ id: 23740, description: "GLP 13KG", inactive: false, establishment_id: 2580 });
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
    expect(c.customerId).toBe(501);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv?.revgasCustomerId).toBe(501);

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
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(req.tool_choice === undefined || (req.tool_choice as { type: string }).type === "auto").toBe(true);
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("thinking");
    expect(typeof req.system).toBe("string");
    expect(req.tools).toEqual(toolDefinitions);
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

  it("buscar_cliente treats a permission error as an unidentified customer", async () => {
    vi.spyOn(fake, "findCustomersByPhone").mockRejectedValue(new RevgasError("auth", "no", 403));
    const c = ctx();
    const r = await runTool("buscar_cliente", {}, c, deps(scriptedAnthropic()));
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/não identificado/i);
    expect(c.customerId).toBeNull();
  });

  it("buscar_cliente asks which customer when the phone matches several", async () => {
    fake.customers.push({ ...fake.customers[0]!, id: 502, name: "João" });
    const c = ctx();
    const r = await runTool("buscar_cliente", {}, c, deps(scriptedAnthropic()));
    expect(r.content).toContain("Maria");
    expect(r.content).toContain("João");
    expect(c.customerId).toBeNull();
  });

  it("listar_produtos formats prices in reais", async () => {
    const r = await runTool("listar_produtos", {}, ctx(), deps(scriptedAnthropic()));
    expect(JSON.parse(r.content)).toEqual([{ productId: 23740, description: "GLP 13KG", preco: "R$ 110,00" }]);
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

  it("consultar_pedido translates the sale status", async () => {
    const d = deps(scriptedAnthropic());
    vi.spyOn(d.orders, "getLatestSale").mockResolvedValue({ id: 9, status: "ACTIVE", total: 110 });
    const r = await runTool("consultar_pedido", {}, ctx(), d);
    expect(r.content).toContain("Em andamento");
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
});
