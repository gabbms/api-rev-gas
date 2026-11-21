import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDeps, ToolContext } from "../../src/agent/agent.js";
import { Catalog } from "../../src/catalog/catalog.js";
import { loadConfig } from "../../src/config.js";
import {
  ConversationService,
  HANDOFF_TEXT,
  type Outgoing,
  type RunTurn,
} from "../../src/conversations/conversationService.js";
import type { Db } from "../../src/db/client.js";
import { asc } from "drizzle-orm";
import { conversations, handoffs, llmTurns, messages, orderDrafts } from "../../src/db/schema.js";
import { OrderService } from "../../src/orders/orderService.js";
import { FakeRevgasClient } from "../../src/revgas/fakeClient.js";
import { resetTables, setupTestDb } from "../helpers/testDb.js";

let db: Db;
let close: () => Promise<void>;
let deps: AgentDeps;
let sent: Outgoing[];
let log: string[];

const cfg = loadConfig({ DATABASE_URL: "postgres://x", REVGAS_API_KEY: "k", ANTHROPIC_API_KEY: "a" });

const send = async (m: Outgoing) => {
  sent.push(m);
  log.push(`send:${m.text}`);
};

function service(runTurn: RunTurn, onChange?: (id: string) => void) {
  return new ConversationService(deps, send, onChange, runTurn);
}

const replying =
  (replyText: string | null, events: ToolContext["events"] = {}): RunTurn =>
  async (ctx) => {
    Object.assign(ctx.events, events);
    return { replyText, events: ctx.events };
  };

async function conversationByPhone(phone: string) {
  const [row] = await db.select().from(conversations).where(eq(conversations.phone, phone));
  return row;
}

beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetTables(db);
  sent = [];
  log = [];
  const fake = new FakeRevgasClient();
  const catalog = new Catalog(fake, 2580);
  deps = {
    anthropic: {} as Pick<Anthropic, "beta">,
    orders: new OrderService(db, catalog, fake, cfg),
    catalog,
    revgas: fake,
    db,
    cfg,
  };
});

describe("ConversationService", () => {
  it("creates the conversation, stores both messages and sends the reply", async () => {
    await service(replying("Olá! Em que posso ajudar?")).handleCustomerMessage("86999998888", "oi");
    const conv = await conversationByPhone("86999998888");
    expect(conv?.mode).toBe("bot");
    expect(sent).toEqual([{ conversationId: conv!.id, phone: "86999998888", author: "bot", text: "Olá! Em que posso ajudar?" }]);
    const svc = service(replying(null));
    expect((await svc.history(conv!.id)).map((m) => [m.author, m.text])).toEqual([
      ["customer", "oi"],
      ["bot", "Olá! Em que posso ajudar?"],
    ]);
  });

  it("Review Focus 5: does not call the AI or reply while the conversation is with a human", async () => {
    const runTurn = vi.fn(replying("não devia"));
    const svc = service(runTurn);
    const [conv] = await db.insert(conversations).values({ phone: "86999998888", mode: "human" }).returning();
    const changed: string[] = [];
    await new ConversationService(deps, send, (id) => changed.push(id), runTurn).handleCustomerMessage("86999998888", "alô?");
    expect(runTurn).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect((await svc.history(conv!.id)).map((m) => m.text)).toEqual(["alô?"]);
    expect(changed).toContain(conv!.id);
  });

  it("sends the reply, then the official summary, and only then marks it presented", async () => {
    const mark = vi.spyOn(deps.orders, "markPresented").mockImplementation(async () => {
      log.push("markPresented");
    });
    await service(
      replying("Vou te mandar o resumo.", { draftPresentable: { draftId: "d-1", summaryText: "Resumo do pedido: ..." } }),
    ).handleCustomerMessage("86999998888", "quero um botijão, pix");
    expect(log).toEqual(["send:Vou te mandar o resumo.", "send:Resumo do pedido: ...", "markPresented"]);
    expect(mark).toHaveBeenCalledWith("d-1", expect.any(Date));
  });

  it("records every handoff with its reason, for the metrics", async () => {
    const svc = service(replying(null, { handoff: { reason: "Cliente pediu humano" } }));
    await svc.handleCustomerMessage("86999998888", "quero falar com uma pessoa");
    const conv = await conversationByPhone("86999998888");
    await svc.returnToBot(conv!.id);
    await service(replying(null, { handoff: { reason: "Reclamação" } })).handleCustomerMessage("86999998888", "veio vazando");
    const rows = await db.select().from(handoffs);
    expect(rows.map((r) => [r.conversationId, r.reason])).toEqual([
      [conv!.id, "Cliente pediu humano"],
      [conv!.id, "Reclamação"],
    ]);
  });

  it("hands off to a human and can return to the bot", async () => {
    const svc = service(replying(null, { handoff: { reason: "Cliente pediu humano" } }));
    await svc.handleCustomerMessage("86999998888", "quero falar com uma pessoa");
    const conv = await conversationByPhone("86999998888");
    expect(conv).toMatchObject({ mode: "human", handoffReason: "Cliente pediu humano" });
    expect(sent.map((m) => m.text)).toEqual([HANDOFF_TEXT]);
    expect(HANDOFF_TEXT).toBe("Vou chamar um atendente para te ajudar. Só um instante!");

    const list = await svc.list();
    expect(list).toEqual([
      expect.objectContaining({ id: conv!.id, phone: "86999998888", mode: "human", handoffReason: "Cliente pediu humano" }),
    ]);
    expect(list[0]!.lastMessageAt).toBeInstanceOf(Date);

    await svc.attendantReply(conv!.id, "Oi, aqui é a Ana.");
    expect(sent.at(-1)).toMatchObject({ author: "attendant", text: "Oi, aqui é a Ana.", phone: "86999998888" });

    await svc.returnToBot(conv!.id);
    expect(await conversationByPhone("86999998888")).toMatchObject({ mode: "bot", handoffReason: null });
  });

  it("hands off with 'Erro interno' when the agent throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await service(async () => {
      throw new Error("boom");
    }).handleCustomerMessage("86999998888", "oi");
    expect(await conversationByPhone("86999998888")).toMatchObject({ mode: "human", handoffReason: "Erro interno" });
    expect(sent.map((m) => m.text)).toEqual([HANDOFF_TEXT]);
    error.mockRestore();
  });

  it("never runs two agent turns of the same conversation at once", async () => {
    let active = 0;
    let maxActive = 0;
    const runTurn: RunTurn = async (ctx) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { replyText: "ok", events: ctx.events };
    };
    const svc = service(runTurn);
    await Promise.all([svc.handleCustomerMessage("86999998888", "a"), svc.handleCustomerMessage("86999998888", "b")]);
    expect(maxActive).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("puts differently formatted phones in the same conversation", async () => {
    const svc = service(replying("ok"));
    await svc.handleCustomerMessage("+55 (86) 99999-8888", "a");
    await svc.handleCustomerMessage("86999998888", "b");
    expect(await db.select().from(conversations)).toHaveLength(1);
    expect(sent.every((m) => m.phone === "86999998888")).toBe(true);
  });

  it("ignores an invalid phone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runTurn = vi.fn(replying("x"));
    await service(runTurn).handleCustomerMessage("123", "oi");
    expect(runTurn).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toHaveLength(0);
    warn.mockRestore();
  });

  it("passes the stored RevGás customer id to the agent", async () => {
    await db.insert(conversations).values({ phone: "86999998888", revgasCustomerId: 501 });
    let seen: number | null = null;
    await service(async (ctx) => {
      seen = ctx.customerId;
      return { replyText: null, events: ctx.events };
    }).handleCustomerMessage("86999998888", "oi");
    expect(seen).toBe(501);
  });
});

describe("ConversationService — human period", () => {
  const handoffTurn = replying(null, { handoff: { reason: "Cliente pediu humano" } });

  it("clears the presented summary on handoff, so a 'sim' sent to the human does not confirm it", async () => {
    const svc = service(replying("ok"));
    await svc.handleCustomerMessage("86999998888", "oi");
    const conv = await conversationByPhone("86999998888");
    const [draft] = await db
      .insert(orderDrafts)
      .values({ conversationId: conv!.id, status: "open", payload: {}, totalCents: 1, presentedAt: new Date() })
      .returning();

    await service(handoffTurn).handleCustomerMessage("86999998888", "quero falar com uma pessoa");

    const [row] = await db.select().from(orderDrafts).where(eq(orderDrafts.id, draft!.id));
    expect(row?.presentedAt).toBeNull();
  });

  it("tells the AI what happened with the human when the conversation returns to the bot", async () => {
    const svc = service(replying("Olá!"));
    await svc.handleCustomerMessage("86999998888", "oi");
    await service(handoffTurn).handleCustomerMessage("86999998888", "quero falar com uma pessoa");
    const conv = await conversationByPhone("86999998888");
    const humanSvc = service(replying("não devia"));
    await humanSvc.handleCustomerMessage("86999998888", "meu gás veio vazado");
    await humanSvc.attendantReply(conv!.id, "Vamos trocar hoje à tarde.");
    const before = await db.select().from(llmTurns).where(eq(llmTurns.conversationId, conv!.id));

    await humanSvc.returnToBot(conv!.id);

    const turns = await db.select().from(llmTurns).where(eq(llmTurns.conversationId, conv!.id)).orderBy(asc(llmTurns.id));
    expect(turns).toHaveLength(before.length + 1);
    const last = turns.at(-1)!;
    expect(last.role).toBe("user");
    const blocks = last.content as { type: string; text: string }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toContain("[Atendimento humano]");
    expect(blocks[0]!.text).toContain("Cliente: meu gás veio vazado");
    expect(blocks[0]!.text).toContain("Atendente: Vamos trocar hoje à tarde.");
    // Only what happened after the handoff.
    expect(blocks[0]!.text).not.toContain("Cliente: oi");
    expect(blocks[0]!.text).not.toContain("quero falar com uma pessoa");
  });
});

describe("ConversationService — empty AI turn", () => {
  const empty = replying(null);

  it("asks the customer to repeat when the AI returns nothing", async () => {
    await service(empty).handleCustomerMessage("86999998888", "hmm");
    expect(sent.map((m) => m.text)).toEqual(["Desculpe, não entendi. Pode repetir?"]);
    expect(await conversationByPhone("86999998888")).toMatchObject({ mode: "bot" });
  });

  it("hands off with 'IA sem resposta' on the second empty turn in a row", async () => {
    const svc = service(empty);
    await svc.handleCustomerMessage("86999998888", "hmm");
    await svc.handleCustomerMessage("86999998888", "hmm?");
    expect(sent.map((m) => m.text)).toEqual(["Desculpe, não entendi. Pode repetir?", HANDOFF_TEXT]);
    expect(await conversationByPhone("86999998888")).toMatchObject({ mode: "human", handoffReason: "IA sem resposta" });
  });

  it("resets the count after a turn with an answer", async () => {
    let n = 0;
    const svc = service(async (ctx) => ({ replyText: n++ === 1 ? "Claro!" : null, events: ctx.events }));
    for (const t of ["a", "b", "c"]) await svc.handleCustomerMessage("86999998888", t);
    expect(sent.map((m) => m.text)).toEqual(["Desculpe, não entendi. Pode repetir?", "Claro!", "Desculpe, não entendi. Pode repetir?"]);
    expect(await conversationByPhone("86999998888")).toMatchObject({ mode: "bot" });
  });

  it("does not treat a turn that only sends the summary as empty", async () => {
    vi.spyOn(deps.orders, "markPresented").mockResolvedValue();
    await service(replying(null, { draftPresentable: { draftId: "d", summaryText: "Resumo do pedido: ..." } })).handleCustomerMessage(
      "86999998888",
      "pix",
    );
    expect(sent.map((m) => m.text)).toEqual(["Resumo do pedido: ..."]);
  });
});
