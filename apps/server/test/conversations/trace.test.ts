import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTrace } from "../../src/conversations/trace.js";
import type { Db } from "../../src/db/client.js";
import { conversations, llmTurns, messages } from "../../src/db/schema.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

let db: Db;
let close: () => Promise<void>;
let conversationId: string;
const t = (s: number) => new Date(Date.UTC(2026, 10, 21, 13, 0, s));

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetTables(db);
  const [c] = await db.insert(conversations).values({ phone: "86999998888" }).returning();
  conversationId = c!.id;
});

const use = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use", id, name, input });
const result = (id: string, content: string, isError = false) => ({ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });

async function turn(role: "user" | "assistant", content: unknown, at: Date) {
  await db.insert(llmTurns).values({ conversationId, role, content, createdAt: at });
}
async function msg(author: "customer" | "bot", text: string, at: Date) {
  await db.insert(messages).values({ conversationId, author, text, createdAt: at });
}

describe("buildTrace", () => {
  it("interleaves messages with short summaries of each tool call, never thinking or raw content", async () => {
    await msg("customer", "quero um botijão", t(0));
    await turn("user", "quero um botijão", t(0));
    await turn("assistant", [{ type: "thinking", thinking: "segredo do raciocínio", signature: "sig" }, use("a", "buscar_cliente"), use("b", "listar_produtos")], t(1));
    await turn("user", [
      result("a", JSON.stringify({ cliente: "conhecido", nome: "Joana", endereco: { location: "Rua X" } })),
      result("b", JSON.stringify({ aviso: "x", produtos: [{ productId: 1 }, { productId: 2 }, { productId: 3 }] })),
    ], t(2));
    await turn("assistant", [use("c", "montar_pedido", { items: [] })], t(3));
    await turn("user", [result("c", "Resumo gerado (total R$ 160,00); o sistema vai enviá-lo ao cliente. Não repita preços.")], t(4));
    await msg("bot", "Vou te mandar o resumo.", t(5));
    await msg("customer", "sim", t(10));
    await turn("assistant", [use("d", "confirmar_pedido")], t(11));
    await turn("user", [result("d", "Venda 900000004 criada. Informe ao cliente: Pedido nº 900000004 registrado.")], t(12));
    await turn("assistant", [use("e", "montar_pedido", {})], t(13));
    await turn("user", [result("e", "Pedido não pôde ser montado: GLP 13KG não pode ser pago com Vale Gás", true)], t(14));
    await turn("assistant", [use("f", "chamar_atendente", { motivo: "Cliente pediu humano" })], t(15));
    await turn("user", [result("f", "Conversa encaminhada para um atendente humano.")], t(16));

    const items = await buildTrace(db, conversationId);
    expect(items.map((i) => (i.kind === "message" ? `${i.author}: ${i.text}` : `[${i.name}] ${i.summary}${i.isError ? " (erro)" : ""}`))).toEqual([
      "customer: quero um botijão",
      "[buscar_cliente] cliente conhecido: Joana",
      "[listar_produtos] 3 produtos",
      "[montar_pedido] resumo gerado: R$ 160,00",
      "bot: Vou te mandar o resumo.",
      "customer: sim",
      "[confirmar_pedido] venda 900000004 criada",
      "[montar_pedido] GLP 13KG não pode ser pago com Vale Gás (erro)",
      "[chamar_atendente] passou para atendente: Cliente pediu humano",
    ]);
    const json = JSON.stringify(items);
    expect(json).not.toContain("segredo do raciocínio");
    expect(json).not.toContain("thinking");
    expect(json).not.toContain("Rua X");
  });

  it("marks a tool call without result as pending and an interrupted one as interrupted", async () => {
    await turn("assistant", [use("x", "listar_produtos")], t(1));
    await turn("user", [result("x", "Execução interrompida", true)], t(2));
    await turn("assistant", [use("y", "buscar_cliente")], t(3));
    const items = await buildTrace(db, conversationId);
    expect(items).toEqual([
      expect.objectContaining({ kind: "tool", name: "listar_produtos", summary: "execução interrompida", isError: true }),
      expect.objectContaining({ kind: "tool", name: "buscar_cliente", summary: "sem resultado" }),
    ]);
  });

  it("summarises a new customer and unknown tools briefly", async () => {
    await turn("assistant", [use("a", "buscar_cliente"), use("b", "ferramenta_nova")], t(1));
    await turn("user", [result("a", JSON.stringify({ cliente: "novo", instrucao: "x" })), result("b", "qualquer coisa longa ".repeat(30))], t(2));
    const items = await buildTrace(db, conversationId);
    expect(items.map((i) => (i.kind === "tool" ? i.summary : ""))).toEqual(["cliente novo", "concluída"]);
  });
});
